/**
 * MonumentTracker - Oil Rig & Cargo Ship Event and Crate Countdown Tracker
 * 
 * Features:
 * - Tracks Large Oil Rig and Small Oil Rig crate hacks via Smart Alarms wired to in-game RF Receivers
 * - Tracks Cargo Ship entrances, crate unlocks, and departure timers via Smart Alarms and Map Markers
 * - Automatically differentiates monument RF alarms from base raid alarms to prevent false base lockdowns
 * - Ticks countdowns and broadcasts milestones (15m start, 10m, 5m, 2m, 0m unlocked)
 * - Broadcasts to In-Game Team Chat (clean formatting), Facepunch Clan Chat, Matrix E2EE, and WebUI
 * - Provides !oil, !rig, !loil, !smoil, !cargo, and !monuments commands
 */

class MonumentTracker {
  constructor(rustClient, matrixClient) {
    this.rustClient = rustClient;
    this.matrixClient = matrixClient;

    this.monuments = {
      large_oil: {
        id: "large_oil",
        name: "Large Oil Rig",
        shortname: "loil",
        rfFrequency: 4765,
        status: "idle", // idle | hacking | unlocked | cooldown
        hackStartedAt: null,
        crateUnlocksAt: null,
        unlockedAt: null,
        durationSec: 900, // 15 minutes
        cooldownDurationSec: 2100, // 35 minutes
        notifiedStages: new Set(),
        triggerSource: null
      },
      small_oil: {
        id: "small_oil",
        name: "Small Oil Rig",
        shortname: "smoil",
        rfFrequency: 4768,
        status: "idle", // idle | hacking | unlocked | cooldown
        hackStartedAt: null,
        crateUnlocksAt: null,
        unlockedAt: null,
        durationSec: 900, // 15 minutes
        cooldownDurationSec: 2100, // 35 minutes
        notifiedStages: new Set(),
        triggerSource: null
      },
      cargo: {
        id: "cargo",
        name: "Cargo Ship",
        shortname: "cargo",
        status: "idle", // idle | active | hacking | leaving
        onMap: false,
        grid: null,
        spawnTime: null,
        crateUnlocksAt: null,
        hackStartedAt: null,
        notifiedStages: new Set(),
        triggerSource: null
      },
      excavator: {
        id: "excavator",
        name: "Giant Excavator",
        shortname: "exac",
        rfFrequency: 4777,
        status: "idle", // idle | active | cooldown
        startedAt: null,
        durationSec: 120, // 2 minutes per diesel fuel cycle
        cooldownDurationSec: 600,
        notifiedStages: new Set(),
        triggerSource: null
      }
    };

    this.initListeners();
    this.startTicker();
  }

  initListeners() {
    if (!this.rustClient) return;

    // Listen for entity state changes (e.g. Smart Alarm wired to RF receiver turned ON)
    this.rustClient.on("entityState", ({ entityId, state, name }) => {
      if (state) {
        this.checkAndHandleAlarm(entityId, name);
      }
    });

    // Listen for entityChanged broadcasts
    this.rustClient.on("entityChanged", ({ entityId, payload }) => {
      if (payload && payload.value) {
        // Find alarm name from active server
        const alarm = this.findAlarmById(entityId);
        if (alarm) {
          this.checkAndHandleAlarm(entityId, alarm.name);
        }
      }
    });
  }

  findAlarmById(entityId) {
    if (!this.rustClient.activeServer) return null;
    const num = Number(entityId);
    return (this.rustClient.activeServer.alarms || []).find(a => Number(a.id) === num) || null;
  }

  /**
   * Identifies whether a given alarm name or string relates to Large Oil, Small Oil, Cargo, or Excavator.
   */
  isMonumentAlarm(name, extraText = "") {
    const combined = `${name || ""} ${extraText || ""}`.toLowerCase();
    return (
      combined.includes("oil") ||
      combined.includes("smoil") ||
      combined.includes("loil") ||
      combined.includes("rig") ||
      combined.includes("cargo") ||
      combined.includes("exac") ||
      combined.includes("excav") ||
      combined.includes("4765") ||
      combined.includes("4768") ||
      combined.includes("4777")
    );
  }

  /**
   * Determine monument key from text identifiers (SMOIL, OIL, CARGO, EXAC).
   */
  classifyMonument(text) {
    const s = String(text || "").toLowerCase().trim();
    if (s === "smoil" || s.startsWith("smoil") || s.includes("small") || s.includes("4768") || s.includes("s-oil") || s.includes("s_oil") || s.includes("s rig")) {
      return "small_oil";
    }
    if (s === "oil" || s.startsWith("oil") || s.includes("large") || s.includes("loil") || s.includes("4765") || s.includes("l-oil") || s.includes("l_oil") || s.includes("l rig")) {
      return "large_oil";
    }
    if (s === "cargo" || s.includes("cargo")) {
      return "cargo";
    }
    if (s === "exac" || s.startsWith("exac") || s.includes("excav") || s.includes("4777")) {
      return "excavator";
    }
    if (s.includes("oil") || s.includes("rig")) {
      return "large_oil";
    }
    return null;
  }

  checkAndHandleAlarm(entityId, alarmName) {
    if (!alarmName) return false;
    if (!this.isMonumentAlarm(alarmName)) return false;

    const monumentKey = this.classifyMonument(alarmName);
    if (!monumentKey) return false;

    console.log(`[MonumentTracker] RF Smart Alarm triggered for ${monumentKey}: "${alarmName}" (ID: ${entityId})`);
    this.startTimer(monumentKey, `Smart Alarm: "${alarmName}"`);
    return true;
  }

  handleAlarmTrigger(entityId, title, message) {
    const text = `${title} ${message}`;
    const monumentKey = this.classifyMonument(text);
    if (monumentKey) {
      this.startTimer(monumentKey, `FCM Push: "${title}"`);
      return true;
    }
    return false;
  }

  /**
   * Called by fetchMapMarkers when Cargo Ship is detected on the map.
   */
  handleCargoMarker(marker, isPresent) {
    const c = this.monuments.cargo;
    if (isPresent && marker) {
      const isNew = !c.onMap;
      c.onMap = true;
      c.grid = marker.grid || c.grid || "Water";

      if (isNew) {
        c.spawnTime = Date.now();
        c.status = "active";
        const title = "🚢 Cargo Ship Approaching Island";
        const msg = `Cargo Ship detected on radar at Grid [${c.grid}]. Ready for boarding!`;
        this.broadcastMonumentAlert(title, msg, { Monument: "Cargo Ship", Grid: c.grid });
      }
    } else if (!isPresent && c.onMap) {
      c.onMap = false;
      c.status = "idle";
      c.crateUnlocksAt = null;
      c.hackStartedAt = null;
      const title = "🚢 Cargo Ship Departed";
      const msg = "Cargo Ship has left the island perimeter.";
      this.broadcastMonumentAlert(title, msg, { Monument: "Cargo Ship", Status: "Departed" });
    }
  }

  /**
   * Start or restart a monument crate timer.
   */
  startTimer(monumentKey, source = "Manual") {
    const mon = this.monuments[monumentKey];
    if (!mon) return null;

    const now = Date.now();
    // Debounce: if already started in the last 60 seconds, ignore duplicate triggers
    if (mon.status === "hacking" && mon.hackStartedAt && (now - mon.hackStartedAt < 60000)) {
      return mon;
    }

    mon.status = "hacking";
    mon.hackStartedAt = now;
    mon.crateUnlocksAt = now + (mon.durationSec || 900) * 1000;
    mon.unlockedAt = null;
    mon.notifiedStages = new Set();
    mon.triggerSource = source;

    const emoji = monumentKey === "cargo" ? "🚢" : "🛢️";
    const title = `${emoji} [${mon.name}] Locked Crate Hack Initiated!`;
    const details = monumentKey === "cargo"
      ? "Locked Crate hack started on Cargo Ship. Unlocks in 15m00s!"
      : `${mon.name} Locked Crate initiated (RF: ${mon.rfFrequency || "Active"}). Crate unlocks in 15m00s | Heavy scientists inbound!`;

    this.broadcastMonumentAlert(title, details, {
      Monument: mon.name,
      Status: "Hacking in progress",
      UnlocksIn: "15 minutes",
      Source: source
    });

    return mon;
  }

  /**
   * Reset / cancel a monument timer.
   */
  cancelTimer(monumentKey) {
    const mon = this.monuments[monumentKey];
    if (!mon) return false;

    mon.status = "idle";
    mon.hackStartedAt = null;
    mon.crateUnlocksAt = null;
    mon.unlockedAt = null;
    mon.notifiedStages.clear();

    const title = `[${mon.name}] Timer Cancelled`;
    const msg = `${mon.name} countdown timer was manually reset to idle.`;
    this.broadcastMonumentAlert(title, msg, { Monument: mon.name, Status: "Idle" });
    return true;
  }

  startTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => {
      this.tick();
    }, 1000);
  }

  tick() {
    const now = Date.now();

    for (const [key, mon] of Object.entries(this.monuments)) {
      if (mon.status === "hacking" && mon.crateUnlocksAt) {
        const remainingSec = Math.max(0, Math.round((mon.crateUnlocksAt - now) / 1000));

        // 10 minutes remaining
        if (remainingSec <= 600 && remainingSec > 590 && !mon.notifiedStages.has("10m")) {
          mon.notifiedStages.add("10m");
          this.broadcastMonumentAlert(
            `⏳ [${mon.name}] 10 Minutes Remaining`,
            `${mon.name} crate unlocks in 10 minutes (${this.formatTimeLeft(remainingSec)}).`,
            { Monument: mon.name, TimeLeft: "10m" }
          );
        }

        // 5 minutes remaining
        if (remainingSec <= 300 && remainingSec > 290 && !mon.notifiedStages.has("5m")) {
          mon.notifiedStages.add("5m");
          this.broadcastMonumentAlert(
            `⏳ [${mon.name}] 5 Minutes Warning!`,
            `${mon.name} crate unlocks in 5 minutes (${this.formatTimeLeft(remainingSec)})! Prep boats/copters for extraction.`,
            { Monument: mon.name, TimeLeft: "5m" }
          );
        }

        // 2 minutes remaining
        if (remainingSec <= 120 && remainingSec > 110 && !mon.notifiedStages.has("2m")) {
          mon.notifiedStages.add("2m");
          this.broadcastMonumentAlert(
            `⚠️ [${mon.name}] 2 Minutes Left!`,
            `${mon.name} crate unlocks in 2 minutes! Clear heavy scientists now!`,
            { Monument: mon.name, TimeLeft: "2m" }
          );
        }

        // 0 seconds - UNLOCKED!
        if (remainingSec <= 0 && !mon.notifiedStages.has("0m")) {
          mon.notifiedStages.add("0m");
          mon.status = "unlocked";
          mon.unlockedAt = now;

          this.broadcastMonumentAlert(
            `🔓 [${mon.name}] CRATE IS UNLOCKED!`,
            `${mon.name} locked crate is now UNLOCKED! Loot the crate immediately!`,
            { Monument: mon.name, Status: "UNLOCKED" }
          );
        }
      }

      // Transition from unlocked to cooldown after 5 minutes
      if (mon.status === "unlocked" && mon.unlockedAt && (now - mon.unlockedAt > 300000)) {
        mon.status = "cooldown";
      }

      // Transition from cooldown to idle after cooldown duration (35 mins)
      if (mon.status === "cooldown" && mon.unlockedAt && (now - mon.unlockedAt > (mon.cooldownDurationSec || 2100) * 1000)) {
        mon.status = "idle";
        mon.hackStartedAt = null;
        mon.crateUnlocksAt = null;
        mon.unlockedAt = null;
        mon.notifiedStages.clear();
      }
    }
  }

  formatTimeLeft(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m${s < 10 ? "0" : ""}${s}s`;
  }

  broadcastMonumentAlert(title, message, details = {}) {
    console.log(`[MonumentTracker] ${title} - ${message}`);

    // Clean plain text for in-game chat (strip emojis)
    const cleanMsg = `${title}: ${message}`.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, "").replace(/\s{2,}/g, " ").trim();

    if (this.rustClient?.client?.isConnected()) {
      this.rustClient.sendTeamChat(cleanMsg).catch(e => console.warn("[MonumentTracker] Team chat error:", e.message));
      if (this.rustClient.clanInfo) {
        this.rustClient.sendClanMessage(cleanMsg).catch(() => {});
      }
    }

    if (this.matrixClient) {
      this.matrixClient.sendAlert(title, message, details).catch(() => {});
    }

    if (this.rustClient) {
      this.rustClient.logEvent("monument", title, message, details);
      this.rustClient.emit("monumentUpdate", this.getStatus());
    }
  }

  getStatus() {
    const now = Date.now();
    const result = {};

    for (const [key, mon] of Object.entries(this.monuments)) {
      let remainingSec = 0;
      let remainingFormatted = "Ready / Idle";

      if (mon.status === "hacking" && mon.crateUnlocksAt) {
        remainingSec = Math.max(0, Math.round((mon.crateUnlocksAt - now) / 1000));
        remainingFormatted = `Unlocks in ${this.formatTimeLeft(remainingSec)}`;
      } else if (mon.status === "unlocked") {
        remainingFormatted = "UNLOCKED (Loot Now!)";
      } else if (mon.status === "cooldown") {
        const cdLeft = Math.max(0, Math.round(((mon.unlockedAt || now) + (mon.cooldownDurationSec || 2100) * 1000 - now) / 1000));
        remainingFormatted = `Respawning in ~${Math.round(cdLeft / 60)}m`;
      } else if (key === "cargo" && mon.onMap) {
        remainingFormatted = `Active on map @ [${mon.grid || "Water"}]`;
      }

      result[key] = {
        name: mon.name,
        shortname: mon.shortname,
        rfFrequency: mon.rfFrequency || null,
        status: mon.status,
        onMap: !!mon.onMap,
        grid: mon.grid || null,
        remainingSec,
        formatted: remainingFormatted,
        source: mon.triggerSource || "None"
      };
    }

    return result;
  }

  formatChatSummary() {
    const s = this.getStatus();
    const loil = `Large Oil: ${s.large_oil.formatted}`;
    const smoil = `Small Oil: ${s.small_oil.formatted}`;
    const cargo = `Cargo: ${s.cargo.formatted}`;
    const exac = s.excavator && s.excavator.status !== "idle" ? ` | Excavator: ${s.excavator.formatted}` : "";
    return `[Monument Timers] ${loil} | ${smoil} | ${cargo}${exac}`;
  }
}

module.exports = MonumentTracker;
