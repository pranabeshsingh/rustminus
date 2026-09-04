const { EventEmitter } = require("events");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const AndroidFCM = require("@liamcottle/push-receiver/src/android/fcm");
const PushReceiverClient = require("@liamcottle/push-receiver/src/client");

class FCMService extends EventEmitter {
  constructor(configManager, rustManager, matrixClient) {
    super();
    this.configManager = configManager;
    this.rustManager = rustManager;
    this.matrixClient = matrixClient;

    this.fcmClient = null;
    this.isListening = false;
    this.lastError = null;
    this.incomingLogs = [];
  }

  logPairing(type, message, rawData = null) {
    const entry = {
      id: `fcm_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      type,
      message,
      rawData,
      timestamp: new Date().toISOString()
    };
    this.incomingLogs.unshift(entry);
    if (this.incomingLogs.length > 100) this.incomingLogs.pop();
    this.emit("pairingLog", entry);
  }

  async registerFCM() {
    console.log("[FCM] Registering Android FCM client...");
    const apiKey = "AIzaSyB5y2y-Tzqb4-I4Qnlsh_9naYv_TD8pCvY";
    const projectId = "rust-companion-app";
    const gcmSenderId = "976529667804";
    const gmsAppId = "1:976529667804:android:d6f1ddeb4403b338fea619";
    const androidPackageName = "com.facepunch.rust.companion";
    const androidPackageCert = "E28D05345FB78A7A1A63D70F4A302DBF426CA5AD";

    const fcmCredentials = await AndroidFCM.register(
      apiKey,
      projectId,
      gcmSenderId,
      gmsAppId,
      androidPackageName,
      androidPackageCert
    );

    console.log("[FCM] FCM registration successful. Fetching Expo push token...");
    const expoResponse = await axios.post("https://exp.host/--/api/v2/push/getExpoPushToken", {
      type: "fcm",
      deviceId: uuidv4(),
      development: false,
      appId: "com.facepunch.rust.companion",
      deviceToken: fcmCredentials.fcm.token,
      projectId: "49451aca-a822-41e6-ad59-955718d0ff9c"
    });

    const expoPushToken = expoResponse.data.data.expoPushToken;
    console.log("[FCM] Expo push token obtained:", expoPushToken);

    const config = this.configManager.getConfig();
    config.fcm = {
      ...config.fcm,
      fcm_credentials: fcmCredentials,
      expo_push_token: expoPushToken
    };
    this.configManager.saveConfig(config);

    this.logPairing("info", `FCM Registered successfully. Expo Token: ${expoPushToken}`);
    return { fcmCredentials, expoPushToken };
  }

  async linkWithCompanionAuthToken(authToken) {
    const config = this.configManager.getConfig();
    if (!config.fcm?.expo_push_token) {
      await this.registerFCM();
    }
    const expoPushToken = config.fcm.expo_push_token;

    console.log("[FCM] Registering with Facepunch Companion API (Token length: " + (authToken?.length || 0) + ")...");
    try {
      const response = await axios.post("https://companion-rust.facepunch.com:443/api/push/register", {
        AuthToken: authToken.trim(),
        DeviceId: "rustplus-manager",
        PushKind: 3,
        PushToken: expoPushToken
      }, { timeout: 10000 });

      config.fcm.rustplus_auth_token = authToken.trim();
      this.configManager.saveConfig(config);
      this.logPairing("info", "Linked successfully with Facepunch Companion API!");
      return { success: true, data: response.data };
    } catch (err) {
      const detail = err.response?.data?.message || err.response?.data || err.message;
      console.error("[FCM] Facepunch Companion registration failed:", detail);
      throw new Error(`Facepunch registration failed (${err.response?.status || 500}): ${typeof detail === "object" ? JSON.stringify(detail) : detail}`);
    }
  }

  async startListener() {
    if (this.isListening) return;

    let config = this.configManager.getConfig();
    if (!config.fcm?.fcm_credentials) {
      console.log("[FCM] No FCM credentials found. Automatically registering now...");
      await this.registerFCM();
      config = this.configManager.getConfig();
    }

    const { androidId, securityToken } = config.fcm.fcm_credentials.gcm;

    console.log("[FCM] Connecting PushReceiverClient listener...");
    this.fcmClient = new PushReceiverClient(androidId, securityToken, []);

    this.fcmClient.on("ON_DATA_RECEIVED", (data) => {
      this.handleIncomingNotification(data);
    });

    this.fcmClient.on("error", (err) => {
      console.error("[FCM] PushReceiverClient Error:", err);
      this.lastError = err.message;
      this.emit("status", { isListening: this.isListening, error: this.lastError });
    });

    await this.fcmClient.connect();
    this.isListening = true;
    this.lastError = null;
    config.fcm.enabled = true;
    this.configManager.saveConfig(config);

    console.log("[FCM] FCM Pairing Listener ACTIVE and listening for Rust+ notifications.");
    this.logPairing("listener", "Pairing Listener started. Waiting for in-game Pair actions...");
    this.emit("status", { isListening: true });
  }

  async stopListener() {
    if (this.fcmClient) {
      try {
        this.fcmClient.destroy();
      } catch (e) {
        console.warn("[FCM] Error stopping client:", e.message);
      }
      this.fcmClient = null;
    }
    this.isListening = false;
    const config = this.configManager.getConfig();
    config.fcm.enabled = false;
    this.configManager.saveConfig(config);
    this.logPairing("listener", "Pairing Listener stopped.");
    this.emit("status", { isListening: false });
  }

  handleIncomingNotification(data) {
    try {
      console.log("[FCM Notification Received]", JSON.stringify(data));
      let payload = null;

      // Extract JSON payload from push receiver appData array or data object
      const appMap = {};
      if (Array.isArray(data.appData)) {
        for (const item of data.appData) {
          if (item && item.key) appMap[item.key] = item.value;
        }
      }

      if (appMap.body) {
        try { payload = JSON.parse(appMap.body); } catch (e) { payload = appMap.body; }
      } else if (appMap.message) {
        try { payload = JSON.parse(appMap.message); } catch (e) { payload = appMap.message; }
      } else if (data.data?.body) {
        try { payload = JSON.parse(data.data.body); } catch (e) {}
      } else if (data.data?.message) {
        try { payload = JSON.parse(data.data.message); } catch (e) {}
      } else if (data.data?.custom) {
        try { payload = JSON.parse(data.data.custom); } catch (e) {}
      } else if (data.data) {
        payload = data.data;
      } else if (Object.keys(appMap).length > 0) {
        payload = appMap;
      } else {
        payload = data;
      }

      const notifType = payload.type || payload.channelId || (payload.ip && payload.playerToken ? "server" : (payload.entityId ? "entity" : "unknown"));

      // 1. In-game "Pair with Server" Notification
      if (notifType === "server" || (payload.ip && payload.port && payload.playerToken)) {
        const srvData = payload.body || payload;
        const serverName = srvData.name || srvData.title || `Rust Server ${srvData.ip}:${srvData.port}`;
        const serverIp = srvData.ip;
        const serverPort = Number(srvData.port);
        const playerId = String(srvData.playerId || srvData.playerSteamId);
        const playerToken = Number(srvData.playerToken);

        console.log(`[FCM Auto-Pair] Captured Server: "${serverName}" (${serverIp}:${serverPort})`);

        const servers = this.rustManager.getServers();
        let server = servers.find(s => s.ip === serverIp && Number(s.port) === serverPort);

        if (server) {
          server.name = serverName;
          server.playerId = playerId;
          server.playerToken = playerToken;
          server.isActive = true;
        } else {
          server = {
            id: `srv_${Date.now()}`,
            name: serverName,
            ip: serverIp,
            port: serverPort,
            playerId,
            playerToken,
            useFacepunchProxy: false,
            isActive: true,
            switches: [],
            alarms: []
          };
          servers.push(server);
        }

        // Set all other servers inactive
        servers.forEach(s => { s.isActive = (s.id === server.id); });
        this.rustManager.saveServers(servers);

        this.logPairing("server", `Auto-paired Server: "${serverName}" (${serverIp}:${serverPort})`, srvData);
        this.emit("serverPairing", server);

        // Auto-connect to newly paired server
        this.rustManager.activateServer(server.id).catch(e => console.error("[FCM] Error auto-connecting server:", e.message));

        if (this.matrixClient) {
          this.matrixClient.sendAlert("🔗 Auto-Paired Rust Server", `Successfully paired server "${serverName}"`, {
            "Server IP": `${serverIp}:${serverPort}`,
            "Player SteamID": playerId,
            "Status": "Active and Connecting"
          }).catch(e => console.error("[Matrix Alert] Error:", e.message));
        }
        return;
      }

      // 2. In-game "Pair Device" (Smart Switch, Smart Alarm, Storage Monitor)
      if (notifType === "entity" || payload.entityId || payload.body?.entityId) {
        const entData = payload.body || payload;
        const entityId = Number(entData.entityId);
        const rawType = Number(entData.entityType || 1); // 1 = Switch, 2 = Alarm, 3 = Storage
        const entityName = entData.entityName || entData.name || `Smart Device ${entityId}`;

        console.log(`[FCM Auto-Pair] Captured Entity: "${entityName}" (ID: ${entityId}, Type: ${rawType})`);

        const servers = this.rustManager.getServers();
        // Find matching server by ip/port or use active server
        let targetServer = servers.find(s => s.isActive) || servers[0];
        if (entData.ip && entData.port) {
          const match = servers.find(s => s.ip === entData.ip && Number(s.port) === Number(entData.port));
          if (match) targetServer = match;
        }

        if (targetServer) {
          if (rawType === 2) {
            // Alarm
            if (!targetServer.alarms) targetServer.alarms = [];
            const existing = targetServer.alarms.find(a => Number(a.id) === entityId);
            if (existing) {
              existing.name = entityName;
            } else {
              targetServer.alarms.push({ id: entityId, name: entityName, type: "alarm", state: false });
            }
          } else {
            // Switch / other
            if (!targetServer.switches) targetServer.switches = [];
            const existing = targetServer.switches.find(s => Number(s.id) === entityId);
            if (existing) {
              existing.name = entityName;
            } else {
              let category = "Other";
              const lower = entityName.toLowerCase();
              if (lower.includes("turret")) category = "Turrets";
              else if (lower.includes("sam")) category = "SAMs";
              else if (lower.includes("light")) category = "Lights";
              else if (lower.includes("door")) category = "Doors";

              targetServer.switches.push({
                id: entityId,
                name: entityName,
                category,
                type: "switch",
                state: false
              });
            }
          }

          this.rustManager.saveServers(servers);
          this.rustManager.subscribeEntity(entityId);

          this.logPairing("entity", `Auto-paired Device: "${entityName}" (ID: ${entityId}) to ${targetServer.name}`, entData);
          this.emit("entityPairing", { serverId: targetServer.id, entityId, name: entityName, type: rawType });

          if (this.matrixClient) {
            this.matrixClient.sendAlert("⚡ Auto-Paired Smart Device", `Paired ${entityName} (ID: ${entityId})`, {
              "Device Name": entityName,
              "Entity ID": entityId,
              "Type": rawType === 2 ? "Smart Alarm" : "Smart Switch",
              "Server": targetServer.name
            }).catch(e => console.error("[Matrix Alert] Error:", e.message));
          }
        }
        return;
      }

      // 3. Smart Alarm Notification via FCM Push
      if (notifType === "alarm" || payload.title?.toLowerCase().includes("alarm") || payload.body?.title?.toLowerCase().includes("alarm")) {
        const title = payload.title || payload.body?.title || "Smart Alarm";
        const message = payload.message || payload.body?.message || "Smart Alarm triggered in base!";
        const entityId = payload.entityId || payload.body?.entityId || "N/A";

        console.log(`[FCM RAID ALERT] Alarm notification: "${title}" - "${message}"`);
        this.logPairing("alarm", `🚨 RAID ALERT: ${title} - ${message}`, payload);

        if (this.rustManager?.deviceAutomation) {
          this.rustManager.deviceAutomation.triggerLockdown(title, entityId, "fcm").catch(() => {});
        }

        if (this.matrixClient) {
          this.matrixClient.sendRaidAlert(title, entityId, this.rustManager.activeServer?.name || "Base", {
            "Notification": message,
            "Source": "Facepunch FCM Push"
          }).catch(e => console.error("[Matrix Raid Alert] Error:", e.message));
        }
        return;
      }

      // Other push notifications
      this.logPairing("notification", `FCM Push received: ${JSON.stringify(payload)}`, payload);
    } catch (err) {
      console.error("[FCM] Error processing incoming notification:", err);
      this.logPairing("error", `Error processing notification: ${err.message}`, data);
    }
  }

  getStatus() {
    const config = this.configManager.getConfig();
    return {
      isListening: this.isListening,
      hasCredentials: !!config.fcm?.fcm_credentials,
      hasExpoToken: !!config.fcm?.expo_push_token,
      expoPushToken: config.fcm?.expo_push_token || null,
      hasCompanionToken: !!config.fcm?.rustplus_auth_token,
      lastError: this.lastError
    };
  }
}

module.exports = FCMService;
