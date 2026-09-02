require("fake-indexeddb/auto");
const sdk = require("matrix-js-sdk");
const { EventEmitter } = require("events");
const { speakAlert } = require("./voice-call-dispatcher");

class MatrixClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.homeserverUrl = config.homeserverUrl || config.homeserver || process.env.MATRIX_HOMESERVER || "https://voice.trylocalhost.com";
    this.userId = config.matrixId || config.userId || process.env.MATRIX_USER_ID || "";
    this.username = config.username || process.env.MATRIX_USERNAME || "";
    this.password = config.password || process.env.MATRIX_PASSWORD || "";
    this.displayName = config.displayName || "RustPlus Sentinel";
    this.savedDeviceId = config.deviceId || process.env.MATRIX_DEVICE_ID || "RUSTPLUS_SENTINEL_E2EE";
    this.savedAccessToken = config.accessToken || null;
    
    this.voiceCallRoomId = config.voiceCallRoomId || config.rooms?.voiceCall || process.env.MATRIX_VOICE_ROOM_ID || "";
    this.alertsRoomId = config.alertsRoomId || config.rooms?.alerts || process.env.MATRIX_ALERTS_ROOM_ID || "";
    this.teamChatRoomId = config.teamChatRoomId || config.rooms?.teamChat || process.env.MATRIX_TEAMCHAT_ROOM_ID || "";
    this.raidRoomId = config.raidRoomId || config.rooms?.raid || process.env.MATRIX_RAID_ROOM_ID || "";

    this.client = null;
    this.isReady = false;
    this.lastError = null;
    this.commandHandler = null;
    this.teamChatRelay = null;
    this.roomsJoined = new Set();
    this.isSyncPrepared = false;
  }

  setCommandHandler(handler) {
    this.commandHandler = handler;
  }

  setTeamChatRelay(handler) {
    this.teamChatRelay = handler;
  }

  async login() {
    try {
      console.log("[Matrix E2EE] Authenticating session...");
      let accessToken = this.savedAccessToken;
      let deviceId = this.savedDeviceId;
      let userId = this.userId;

      if (!accessToken || !deviceId) {
        const authClient = sdk.createClient({ baseUrl: this.homeserverUrl });
        const loginRes = await authClient.login("m.login.password", {
          identifier: { type: "m.id.user", user: this.username },
          password: this.password,
          device_id: "RUSTPLUS_SENTINEL_E2EE",
          initial_device_display_name: "RustPlus Sentinel E2EE"
        });

        userId = loginRes.user_id;
        accessToken = loginRes.access_token;
        deviceId = loginRes.device_id;
        this.savedDeviceId = deviceId;
        this.savedAccessToken = accessToken;
        this.userId = userId;
      }

      this.client = sdk.createClient({
        baseUrl: this.homeserverUrl,
        userId: userId,
        accessToken: accessToken,
        deviceId: deviceId
      });

      // Initialize Rust End-to-End Encryption (Megolm / Olm)
      await this.client.initRustCrypto();
      console.log("[Matrix E2EE] Rust Crypto (Megolm / Olm) initialized successfully! Device:", deviceId);

      // Wait for client initial sync to be PREPARED so room encryption state is fully loaded
      const syncPromise = new Promise((resolve) => {
        const onSync = (state) => {
          if (state === "PREPARED" || state === "SYNCING") {
            this.isSyncPrepared = true;
            this.isReady = true;
            this.client.removeListener("sync", onSync);
            resolve();
          }
        };
        this.client.on("sync", onSync);
      });

      await this.client.startClient({ initialSyncLimit: 10 });
      await syncPromise;
      console.log("[Matrix E2EE] Initial Sync PREPARED. E2EE active across all encrypted rooms.");

      // Update display name
      try {
        await this.client.setDisplayName(this.displayName);
      } catch (e) {}

      // Join target rooms
      const targetRooms = [
        this.voiceCallRoomId,
        this.alertsRoomId,
        this.teamChatRoomId,
        this.raidRoomId
      ].filter(Boolean);

      for (const roomId of targetRooms) {
        try {
          await this.client.joinRoom(roomId);
          this.roomsJoined.add(roomId);
        } catch (e) {
          console.warn(`[Matrix] Join room ${roomId} notice:`, e.message);
        }
      }

      // Listen for timeline messages (Decrypted automatically by matrix-js-sdk)
      this.client.on(sdk.RoomEvent.Timeline, async (event, room, toStartOfTimeline) => {
        if (toStartOfTimeline || !event || event.getSender() === this.userId) return;
        if (event.getType() !== "m.room.message") return;

        const body = (event.getContent()?.body || "").trim();
        const roomId = room.roomId;
        const sender = event.getSender();

        // 1. Matrix Command (!pop, !time, !turrets, !help, etc.)
        if ((body.startsWith("!") || body.startsWith(".")) && this.commandHandler) {
          try {
            console.log(`[Matrix E2EE Command] Received "${body}" from ${sender} in ${roomId}`);
            const reply = await this.commandHandler(body, "matrix", sender);
            if (reply) {
              await this.sendMessage(roomId, reply);
            }
          } catch (cmdErr) {
            console.error("[Matrix E2EE Command] Error:", cmdErr.message);
          }
        }
        // 2. Matrix -> In-Game TeamChat relay (if typed in TeamChat room without command prefix)
        else if (roomId === this.teamChatRoomId && !body.startsWith("!") && !body.startsWith(".") && this.teamChatRelay) {
          const senderName = sender.split(":")[0].replace(/^@/, "");
          try {
            await this.teamChatRelay(`[Matrix] ${senderName}: ${body}`);
          } catch (relayErr) {}
        }
      });

      this.emit("ready", { userId: this.userId, deviceId: this.savedDeviceId, rooms: Array.from(this.roomsJoined) });
      return true;
    } catch (err) {
      this.isReady = false;
      this.lastError = err.message;
      console.error("[Matrix E2EE] Login error:", err.message);
      this.emit("error", err);
      throw err;
    }
  }

  async ensureLoggedIn() {
    if (!this.client || !this.isReady) {
      await this.login();
    }
  }

  async sendMessage(roomId, text, formattedHtml = null) {
    await this.ensureLoggedIn();
    const content = {
      msgtype: "m.text",
      body: text
    };
    if (formattedHtml) {
      content.format = "org.matrix.custom.html";
      content.formatted_body = formattedHtml;
    }

    try {
      const res = await this.client.sendEvent(roomId, "m.room.message", content);
      return res;
    } catch (err) {
      console.error(`[Matrix E2EE Send Error] Room ${roomId}:`, err.message);
      throw err;
    }
  }

  async sendAlert(title, message, details = {}) {
    const timeStr = new Date().toLocaleTimeString();
    const plainText = `[Rust+ Event] ${title}: ${message} (${timeStr})`;
    
    let html = `<b>🔔 [Rust+ Event] <font color="#ea580c">${escapeHtml(title)}</font></b><br/>`;
    html += `<span>${escapeHtml(message)}</span><br/>`;
    
    const entries = Object.entries(details);
    if (entries.length > 0) {
      html += `<ul>`;
      for (const [k, v] of entries) {
        html += `<li><b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}</li>`;
      }
      html += `</ul>`;
    }
    html += `<font size="-2" color="#7f848e">Timestamp: ${timeStr} | Rust+ Sentinel (E2EE 🔐)</font>`;

    return this.sendMessage(this.alertsRoomId, plainText, html);
  }

  async sendRaidAlert(alarmName, entityId, serverName = "Active Server", extra = {}) {
    const timeStr = new Date().toLocaleTimeString();
    const plainText = `🚨 @room [RAID ALERT] Smart Alarm "${alarmName}" (ID: ${entityId}) TRIGGERED on ${serverName}! (${timeStr})`;
    
    let html = `<font color="#ff0000" size="+1"><b>🚨 @room RAID ALERT TRIGGERED!</b></font><br/>`;
    html += `<b>Alarm Name:</b> <font color="#ff5555">${escapeHtml(alarmName)}</font><br/>`;
    html += `<b>Entity ID:</b> <code>${entityId}</code><br/>`;
    html += `<b>Server:</b> ${escapeHtml(serverName)}<br/>`;
    html += `<b>Time:</b> ${timeStr}<br/>`;
    
    if (Object.keys(extra).length > 0) {
      html += `<br/><b>Details:</b><br/>`;
      for (const [k, v] of Object.entries(extra)) {
        html += `• <b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}<br/>`;
      }
    }
    
    html += `<br/><font color="#ff3333"><b>⚠️ Check base security, defenses and smart switches immediately!</b></font>`;

    // Ephemeral live call voice dispatch: Connect -> Speak -> Disconnect
    try {
      this.speakVoiceAlert(
        `Raid alert! Smart alarm ${alarmName} triggered on ${serverName}. Defend now!`,
        `🚨 RAID ALERT: ${alarmName}`
      ).catch(e => console.warn("[VoiceAlert] Background speak error:", e.message));
    } catch (e) {}

    return this.sendMessage(this.raidRoomId, plainText, html);
  }

  async sendTeamChat(senderName, message, color = "#55ff55") {
    const plainText = `💬 [TeamChat] ${senderName}: ${message}`;
    const html = `💬 <b><font color="${color}">[TeamChat] ${escapeHtml(senderName)}</font>:</b> ${escapeHtml(message)}`;
    return this.sendMessage(this.teamChatRoomId, plainText, html);
  }

  async speakVoiceAlert(text, title = "Tactical Voice Alert", voice = "en-US-ChristopherNeural") {
    console.log(`[Matrix] Dispatching live voice call alert: "${title}" (${text})`);
    return speakAlert(text, title, voice);
  }

  getStatus() {
    return {
      connected: this.isReady && !!this.client,
      e2ee: true,
      deviceId: this.savedDeviceId,
      userId: this.userId,
      homeserver: this.homeserverUrl,
      rooms: {
        voiceCall: this.voiceCallRoomId,
        alerts: this.alertsRoomId,
        teamChat: this.teamChatRoomId,
        raid: this.raidRoomId
      },
      lastError: this.lastError
    };
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

module.exports = MatrixClient;
