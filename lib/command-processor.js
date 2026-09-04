const { GameDatabase, TurretInterferenceTracker } = require("./game-database");
const https = require("https");

class CommandProcessor {
  constructor(rustClient, matrixClient, options = {}) {
    this.rustClient = rustClient;
    this.matrixClient = matrixClient;

    this.deviceAutomation = options.deviceAutomation || null;
    this.teamTracker = options.teamTracker || null;
    this.storageTracker = options.storageTracker || null;
    this.externalApis = options.externalApis || null;
    this.aiAssistant = options.aiAssistant || null;
    this.timeNotifier = options.timeNotifier || null;
    this.turretTracker = new TurretInterferenceTracker();

    // Active Timers: id -> { timer, msg, expiresAt, sender, source }
    this.activeReminders = new Map();

    // Active Stopwatches: name -> startTimeMs
    this.activeStopwatches = new Map();

    // Bot Configuration Overrides
    this.prefixMessage = "";
    this.isMuted = false;
    this.muteTimer = null;
    this.responseDelayMs = 0;
  }

  formatTime(floatHours) {
    if (floatHours === undefined || floatHours === null) return "--:--";
    const hours = Math.floor(floatHours);
    const minutes = Math.floor((floatHours - hours) * 60);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  formatDuration(sec) {
    if (sec <= 0) return "0s";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);
    return parts.join(" ");
  }

  parseTimeString(str) {
    if (!str) return 0;
    const s = String(str).toLowerCase().trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);

    let totalSeconds = 0;
    const matches = s.matchAll(/(\d+)\s*([dhms])/g);
    let matchedAny = false;
    for (const match of matches) {
      matchedAny = true;
      const val = parseInt(match[1], 10);
      const unit = match[2];
      if (unit === "d") totalSeconds += val * 86400;
      else if (unit === "h") totalSeconds += val * 3600;
      else if (unit === "m") totalSeconds += val * 60;
      else if (unit === "s") totalSeconds += val;
    }
    return matchedAny ? totalSeconds : 0;
  }

  async handleCommand(rawText, source = "game", sender = "Player") {
    const text = String(rawText || "").trim();
    if (!text.startsWith("!") && !text.startsWith(".")) return null;

    if (this.isMuted && !text.startsWith("!unsilent") && !text.startsWith("!unmute")) {
      return null;
    }

    const parts = text.slice(1).split(" ");
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ").trim();

    console.log(`[Command Processor] Handling command "${cmd}" (args: "${args}") from ${source} (${sender})`);

    // Delay if configured
    if (this.responseDelayMs > 0) {
      await new Promise(r => setTimeout(r, this.responseDelayMs));
    }

    const response = await this.execute(cmd, args, source, sender);
    if (!response) return null;

    return this.prefixMessage ? `${this.prefixMessage} ${response}` : response;
  }

  async execute(cmd, args, source, sender) {
    switch (cmd) {
      // =========================================================================
      // 1. POPULATION & SERVER INFO
      // =========================================================================
      case "pop":
      case "players":
      case "player": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to an active Rust server.";
        const info = this.rustClient.serverInfo;
        return info ? `👥 [Pop] ${info.players || 0}/${info.maxPlayers || 0} Online | Queue: ${info.queuedPlayers || 0} | ${info.name || "Server"}` : "⚠️ Server population unavailable.";
      }

      case "time": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to an active Rust server.";
        const t = this.rustClient.timeInfo;
        if (!t) return "⚠️ Time data unavailable.";
        const cd = this.timeNotifier ? this.timeNotifier.calculateCountdown(t) : null;
        const isDay = (t.time >= t.sunrise && t.time < t.sunset);
        const countdownStr = cd ? (isDay ? `Night in ~${Math.round(cd.minUntil)}m` : `Day in ~${Math.round(cd.minUntil)}m`) : "";
        return `${isDay ? "☀️" : "🌙"} [Time] ${this.formatTime(t.time)} | Sunrise: ${this.formatTime(t.sunrise)} | Sunset: ${this.formatTime(t.sunset)} (${isDay ? "Day" : "Night"}${countdownStr ? ` • ${countdownStr}` : ""})`;
      }

      case "day": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to Rust server.";
        const t = this.rustClient.timeInfo;
        if (!t) return "⚠️ Time data unavailable.";
        const cd = this.timeNotifier ? this.timeNotifier.calculateCountdown(t) : null;
        if (t.time >= t.sunrise && t.time < t.sunset) {
          const mins = cd ? Math.round(cd.minUntil) : Math.round((t.sunset - t.time) * 60 / (t.timeScale || 1));
          return `☀️ [Day Time] Day is active (${this.formatTime(t.time)}). Night begins in ~${mins}m at ${this.formatTime(t.sunset)}.`;
        } else {
          const mins = cd ? Math.round(cd.minUntil) : Math.round(((t.time < t.sunrise ? t.sunrise - t.time : 24 - t.time + t.sunrise)) * 60 / (t.timeScale || 1));
          return `🌙 [Night Time] Day arrives in ~${mins}m at ${this.formatTime(t.sunrise)}.`;
        }
      }

      case "night": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to Rust server.";
        const t = this.rustClient.timeInfo;
        if (!t) return "⚠️ Time data unavailable.";
        const cd = this.timeNotifier ? this.timeNotifier.calculateCountdown(t) : null;
        if (t.time < t.sunrise || t.time >= t.sunset) {
          const mins = cd ? Math.round(cd.minUntil) : Math.round(((t.time < t.sunrise ? t.sunrise - t.time : 24 - t.time + t.sunrise)) * 60 / (t.timeScale || 1));
          return `🌙 [Night Active] Current clock: ${this.formatTime(t.time)}. Sunrise in ~${mins}m at ${this.formatTime(t.sunrise)}.`;
        } else {
          const mins = cd ? Math.round(cd.minUntil) : Math.round((t.sunset - t.time) * 60 / (t.timeScale || 1));
          return `☀️ [Day Active] Night starts in ~${mins}m at ${this.formatTime(t.sunset)}.`;
        }
      }

      case "daynight":
      case "cycle": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to Rust server.";
        const t = this.rustClient.timeInfo;
        if (!t) return "⚠️ Time data unavailable.";
        const cd = this.timeNotifier ? this.timeNotifier.calculateCountdown(t) : null;
        const cfg = this.timeNotifier ? this.timeNotifier.getConfig() : {};
        if (args === "on" && this.timeNotifier) {
          this.timeNotifier.saveConfig({ enabled: true });
          return "🔔 [Day/Night Alerts] Enabled! (5m before night, 5m before day, 2m before day).";
        }
        if (args === "off" && this.timeNotifier) {
          this.timeNotifier.saveConfig({ enabled: false });
          return "🔕 [Day/Night Alerts] Disabled.";
        }
        const isDay = t.time >= t.sunrise && t.time < t.sunset;
        const target = isDay ? `Night in ~${Math.round(cd?.minUntil || 0)}m (${this.formatTime(t.sunset)})` : `Sunrise in ~${Math.round(cd?.minUntil || 0)}m (${this.formatTime(t.sunrise)})`;
        const alertStatus = cfg.enabled ? "Enabled 🟢 (5m Night, 5m Day, 2m Day)" : "Disabled 🔴";
        return `🌓 [Day/Night Cycle] Clock: ${this.formatTime(t.time)} | ${target} | Alerts: ${alertStatus}`;
      }

      case "now":
      case "current": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to Rust server.";
        const info = this.rustClient.serverInfo;
        const t = this.rustClient.timeInfo;
        const srvName = info?.name || "Rust Server";
        const popStr = info ? `${info.players}/${info.maxPlayers}` : "?";
        const timeStr = t ? this.formatTime(t.time) : "--:--";
        const isDay = t ? (t.time >= t.sunrise && t.time < t.sunset) : true;
        const text = `🕒 [Now] Pop: ${popStr} | Time: ${timeStr} (${isDay ? "Day" : "Night"}) | ${srvName}`;

        // Optional LiveKit voice dispatch
        if (this.matrixClient) {
          try {
            this.matrixClient.speakVoiceAlert(`Current status: ${popStr} players online. Clock is ${timeStr}.`, "Server Status");
          } catch (e) {}
        }
        return text;
      }

      case "info":
      case "server": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to Rust server.";
        const info = this.rustClient.serverInfo;
        if (!info) return "⚠️ Server info unavailable.";
        const wipeStr = info.wipeTime ? new Date(info.wipeTime * 1000).toLocaleDateString() : "Unknown";
        return `ℹ️ [Server] ${info.name || "Rust"} | Map: ${info.map || "Procedural"} (${info.mapSize || 0}m) | Seed: ${info.seed || "N/A"} | Pop: ${info.players || 0}/${info.maxPlayers || 0} | Wipe: ${wipeStr}`;
      }

      case "size": {
        const size = this.rustClient.serverInfo?.mapSize || 4500;
        return `🗺️ [Map Size] Server world size is ${size} meters (${(size / 1000).toFixed(1)}km).`;
      }

      case "wipe": {
        const wipeTime = this.rustClient.serverInfo?.wipeTime;
        if (!wipeTime) return "ℹ️ Wipe date is unknown.";
        const agoSec = Math.max(0, Math.floor(Date.now() / 1000 - wipeTime));
        return `🗓️ [Wipe Age] Server wiped ${this.formatDuration(agoSec)} ago (${new Date(wipeTime * 1000).toLocaleDateString()}).`;
      }

      case "uptime": {
        return `⏱️ [Bot Uptime] Rust Sentinel online for ${this.formatDuration(Math.floor(process.uptime()))}.`;
      }

      // =========================================================================
      // 2. SMART SWITCHES & AUTOMATIONS
      // =========================================================================
      case "on": {
        if (!args) return "Usage: !on <switch name or entity id>";
        return await this.toggleSwitch(args, true);
      }

      case "off": {
        if (!args) return "Usage: !off <switch name or entity id>";
        return await this.toggleSwitch(args, false);
      }

      case "toggle":
      case "tog": {
        if (!args) return "Usage: !toggle <switch name or entity id>";
        return await this.flipSwitch(args);
      }

      case "turrets": {
        const sub = args.toLowerCase();
        if (sub !== "on" && sub !== "off") return "Usage: !turrets on | !turrets off";
        return await this.toggleCategory("Turrets", sub === "on");
      }

      case "sams":
      case "sam": {
        const sub = args.toLowerCase();
        if (sub !== "on" && sub !== "off") return "Usage: !sams on | !sams off";
        return await this.toggleCategory("SAMs", sub === "on");
      }

      case "lights":
      case "light": {
        const sub = args.toLowerCase();
        if (sub !== "on" && sub !== "off") return "Usage: !lights on | !lights off";
        return await this.toggleCategory("Lights", sub === "on");
      }

      case "doors":
      case "door": {
        const sub = args.toLowerCase();
        if (sub !== "on" && sub !== "off") return "Usage: !doors on | !doors off";
        return await this.toggleCategory("Doors", sub === "on");
      }

      case "strobe": {
        if (!args) return "Usage: !strobe <switch name or id>";
        return await this.strobeSwitch(args);
      }

      // Automation Rules
      case "auto-on": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        const parts = args.split(" ");
        if (parts.length < 2) return "Usage: !auto-on <time> <switch name>";
        return this.deviceAutomation.setAutoRule(parts.slice(1).join(" "), "on", parts[0]);
      }

      case "auto-off": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        const parts = args.split(" ");
        if (parts.length < 2) return "Usage: !auto-off <time> <switch name>";
        return this.deviceAutomation.setAutoRule(parts.slice(1).join(" "), "off", parts[0]);
      }

      case "auto-clear":
      case "auto-clear-all": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        return this.deviceAutomation.clearAutoRule(args);
      }

      case "auto-list": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        return this.deviceAutomation.listAutoRules();
      }

      case "day-on":
      case "day-off":
      case "night-on":
      case "night-off": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        if (!args) return `Usage: !${cmd} <switch name>`;
        return this.deviceAutomation.setDayNightRule(args, cmd);
      }

      case "daynight-clear": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        return this.deviceAutomation.clearDayNightRule(args);
      }

      case "teamoffline-on":
      case "teamoffline-off":
      case "teamoffline-toggle":
      case "teamoffline-tog": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        if (!args) return `Usage: !${cmd} <switch name>`;
        const action = cmd.includes("on") ? "on" : (cmd.includes("off") ? "off" : "toggle");
        return this.deviceAutomation.setTeamOfflineRule(args, action);
      }

      case "teamoffline-clear": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        return this.deviceAutomation.clearTeamRules(args);
      }

      case "teamonline-on":
      case "teamonline-off":
      case "teamonline-toggle":
      case "teamonline-tog": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        if (!args) return `Usage: !${cmd} <switch name>`;
        const action = cmd.includes("on") ? "on" : (cmd.includes("off") ? "off" : "toggle");
        return this.deviceAutomation.setTeamOnlineRule(args, action);
      }

      case "ttoggle":
      case "ttog": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        const parts = args.split(" ");
        if (parts.length < 2) return "Usage: !ttoggle <time> <switch name>";
        return this.deviceAutomation.startTimedToggle(parts.slice(1).join(" "), parts[0], true);
      }

      case "ton": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        const parts = args.split(" ");
        if (parts.length < 2) return "Usage: !ton <time> <switch name>";
        return this.deviceAutomation.startTimedToggle(parts.slice(1).join(" "), parts[0], true);
      }

      case "toff": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        const parts = args.split(" ");
        if (parts.length < 2) return "Usage: !toff <time> <switch name>";
        return this.deviceAutomation.startTimedToggle(parts.slice(1).join(" "), parts[0], false);
      }

      case "tauto": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        const parts = args.split(" ");
        if (parts.length < 3) return "Usage: !tauto <on_time> <off_time> <switch name>";
        return this.deviceAutomation.startAutoCycle(parts.slice(2).join(" "), parts[0], parts[1]);
      }

      case "t-clear": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        return this.deviceAutomation.clearTimedToggle(args);
      }

      case "sam-delay": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        if (!args) return `🚀 SAM Auto-On Delay is currently ${this.deviceAutomation.samAutoOnDelaySec}s.`;
        return this.deviceAutomation.setSamDelay(args);
      }

      case "sam-voice":
      case "sam-voice-enable": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        this.deviceAutomation.samVoiceWarning = true;
        return "🔊 SAM 10-second voice warning ENABLED.";
      }

      case "sam-voice-disable": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        this.deviceAutomation.samVoiceWarning = false;
        return "🔇 SAM voice warning DISABLED.";
      }

      case "alarms":
      case "activated": {
        if (!this.deviceAutomation) return "⚠️ Automation engine unavailable.";
        return this.deviceAutomation.getAlarmHistory();
      }

      // =========================================================================
      // 3. TEAM & TACTICAL TELEMETRY
      // =========================================================================
      case "team":
      case "members": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to Rust server.";
        const team = this.rustClient.teamInfo;
        return team?.members ? this.formatTeamList(team.members) : "ℹ️ No team members found.";
      }

      case "clan":
      case "roster":
      case "alumni": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        return this.teamTracker.getRosterSummary();
      }

      case "motd": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to Rust server.";
        if (args) {
          try {
            await this.rustClient.setClanMotd(args);
            return `📢 [Clan MOTD Updated] "${args}"`;
          } catch (e) {
            return `⚠️ Failed to update Clan MOTD: ${e.message}`;
          }
        }
        if (this.rustClient.clanInfo?.motd) {
          return `📢 [Clan MOTD] "${this.rustClient.clanInfo.motd}"`;
        }
        return "ℹ️ No Clan MOTD set. Use !motd <new message> to set one.";
      }

      case "locate":
      case "loc": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        if (!args) return "Usage: !locate <teammate name>";
        return this.teamTracker.locateMember(args);
      }

      case "proximity":
      case "prox": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        return this.teamTracker.getProximity(sender);
      }

      case "nearby": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        return this.teamTracker.getNearby(sender);
      }

      case "afk": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        return this.teamTracker.getAfkList(args);
      }

      case "afk-all": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        return this.teamTracker.getAfkList();
      }

      case "alive":
      case "alive-all": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        return this.teamTracker.getAliveLongest();
      }

      case "death": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        const target = args || sender;
        return this.teamTracker.getLastDeath(target, 1);
      }

      case "death-all": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        const target = args || sender;
        return this.teamTracker.getAllDeaths(target);
      }

      case "lead":
      case "leader":
      case "teamleader": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        if (args) {
          return await this.promoteTeammate(args);
        }
        return this.teamTracker.getTeamLeaderInfo();
      }

      case "promote": {
        if (!args) return "Usage: !promote <teammate name or steamId>";
        return await this.promoteTeammate(args);
      }

      case "kick": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        if (!args) return "Usage: !kick <teammate name>";
        return await this.teamTracker.kickMember(args);
      }

      case "online": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        return this.teamTracker.getOnlineMembers();
      }

      case "offline": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        return this.teamTracker.getOfflineMembers();
      }

      case "teamstats":
      case "playtime": {
        if (!this.teamTracker) return "⚠️ Team tracker unavailable.";
        return this.teamTracker.getTeamStats(args);
      }

      // =========================================================================
      // 4. STORAGE MONITORS & UPKEEP
      // =========================================================================
      case "contents":
      case "contentsi": {
        if (!this.storageTracker) return "⚠️ Storage tracker unavailable.";
        if (!args) return "Usage: !contents <container name or id>";
        return await this.storageTracker.getContents(args, cmd === "contentsi");
      }

      case "contains":
      case "containsi": {
        if (!this.storageTracker) return "⚠️ Storage tracker unavailable.";
        if (!args) return "Usage: !contains <item name>";
        return this.storageTracker.searchContains(args, cmd === "containsi");
      }

      case "upkeep": {
        if (!this.storageTracker) return "⚠️ Storage tracker unavailable.";
        return this.storageTracker.getUpkeep(args);
      }

      case "multitc":
      case "tcs": {
        if (!this.storageTracker) return "⚠️ Storage tracker unavailable.";
        return this.storageTracker.getMultiTcSummary();
      }

      case "boom": {
        if (!this.storageTracker) return "⚠️ Storage tracker unavailable.";
        return this.storageTracker.getBoomSummary();
      }

      case "sulfur":
      case "gp": {
        if (!this.storageTracker) return "⚠️ Storage tracker unavailable.";
        return this.storageTracker.getSulfurSummary();
      }

      case "armory": {
        if (!this.storageTracker) return "⚠️ Storage tracker unavailable.";
        return this.storageTracker.getArmorySummary();
      }

      case "recbox":
      case "recsafebox": {
        if (!this.storageTracker) return "⚠️ Storage tracker unavailable.";
        if (!args) return `Usage: !${cmd} <box name>`;
        return this.storageTracker.getRecycleBox(args, cmd === "recsafebox");
      }

      case "monitor": {
        if (!this.storageTracker) return "⚠️ Storage tracker unavailable.";
        if (!args) return "Usage: !monitor <container name>";
        return this.storageTracker.toggleMonitor(args);
      }

      // =========================================================================
      // 5. RUSTLABS RAIDING & CRAFTING CALCULATORS
      // =========================================================================
      case "c4": {
        if (!args) return "Usage: !c4 <building block or item name>";
        const d = GameDatabase.getDurability(args, "explosive", false);
        const match = d.match(/C4:\s*(\d+)/i);
        if (match) return `💥 [C4] ${args.toUpperCase()} requires ${match[1]}x C4 (${d})`;
        return d;
      }

      case "rocket": {
        if (!args) return "Usage: !rocket <building block or item name>";
        const d = GameDatabase.getDurability(args, "explosive", false);
        const match = d.match(/Rockets:\s*(\d+)/i);
        if (match) return `🚀 [Rocket] ${args.toUpperCase()} requires ${match[1]}x Rockets (${d})`;
        return d;
      }

      case "satchel": {
        if (!args) return "Usage: !satchel <building block or item name>";
        const d = GameDatabase.getDurability(args, "explosive", false);
        const match = d.match(/Satchels:\s*(\d+)/i);
        if (match) return `🧨 [Satchel] ${args.toUpperCase()} requires ${match[1]}x Satchels (${d})`;
        return d;
      }

      case "explo": {
        if (!args) return "Usage: !explo <building block or item name>";
        const d = GameDatabase.getDurability(args, "explosive", false);
        const match = d.match(/Explo Ammo:\s*(\d+)/i);
        if (match) return `💥 [Explosive Ammo] ${args.toUpperCase()} requires ${match[1]}x Explosive 5.56 (${d})`;
        return d;
      }

      case "durability":
      case "db": {
        if (!args) return "Usage: !durability <building block or item name>";
        return GameDatabase.getDurability(args, "explosive", false);
      }

      case "db-bullet":
      case "durability-bullet": {
        if (!args) return "Usage: !db-bullet <item name>";
        return GameDatabase.getDurability(args, "bullet", false);
      }

      case "db-melee":
      case "durability-melee": {
        if (!args) return "Usage: !db-melee <item name>";
        return GameDatabase.getDurability(args, "melee", false);
      }

      case "db-melee-soft":
      case "durability-melee-soft": {
        if (!args) return "Usage: !db-melee-soft <item name>";
        return GameDatabase.getDurability(args, "melee", true);
      }

      case "db-siege":
      case "durability-siege": {
        if (!args) return "Usage: !db-siege <item name>";
        return GameDatabase.getDurability(args, "siege", false);
      }

      case "craft": {
        if (!args) return "Usage: !craft <quantity> <item name> (e.g. !craft 10 rockets)";
        const match = args.match(/^(\d+)\s+(.+)$/);
        const count = match ? match[1] : 1;
        const item = match ? match[2] : args;
        return GameDatabase.getCraft(item, count);
      }

      case "mix": {
        if (!args) return "Usage: !mix <item name> (e.g. !mix pure ore tea)";
        return GameDatabase.getMix(args);
      }

      case "recycle":
      case "rec": {
        if (!args) return "Usage: !recycle <quantity> <item> (e.g. !recycle 20 tech trash)";
        return GameDatabase.getRecycle(args, false);
      }

      case "recyclesafe":
      case "recsafe": {
        if (!args) return "Usage: !recyclesafe <quantity> <item>";
        return GameDatabase.getRecycle(args, true);
      }

      case "monument": {
        if (!args) return "Usage: !monument <name> (e.g. !monument launch)";
        return GameDatabase.getMonumentInfo(args);
      }

      case "keycard": {
        if (!args) return "Usage: !keycard <green|blue|red>";
        return GameDatabase.getKeycardMonuments(args);
      }

      case "rad":
      case "radiation": {
        if (!args) return "Usage: !rad <monument name>";
        return GameDatabase.getRadiationInfo(args);
      }

      case "turret-add": {
        const floor = parseFloat(args) || 1;
        const caller = this.rustClient.teamInfo?.members?.find(m => m.name === sender) || this.rustClient.teamInfo?.members?.[0];
        const x = caller ? caller.x : 0;
        const y = caller ? caller.y : 0;
        const res = this.turretTracker.addTurret(x, y, floor);
        const warning = res.hasInterference ? "⚠️ WARNING: Exceeds 12 turrets in 40m radius!" : "🟢 Safe.";
        return `🔫 [Turret #${res.total} Added @ Floor ${floor}] 40m Nearby: ${res.nearbyCount}/12. ${warning}`;
      }

      case "turret-check": {
        const floor = parseFloat(args) || 1;
        const caller = this.rustClient.teamInfo?.members?.find(m => m.name === sender) || this.rustClient.teamInfo?.members?.[0];
        const x = caller ? caller.x : 0;
        const y = caller ? caller.y : 0;
        const res = this.turretTracker.checkInterference(x, y, floor);
        const status = res.hasInterference ? "🔴 INTERFERENCE DETECTED" : "🟢 No Interference";
        return `🔫 [Turret Check @ Floor ${floor}] Turrets in 40m Sphere: ${res.count}/12 (${status}) | Nearest: ${res.closestMeters}m`;
      }

      case "turret-clear": {
        this.turretTracker.clear();
        return "🔫 Cleared all registered Auto Turrets.";
      }

      // =========================================================================
      // 6. UTILITIES, TIMERS, NOTES & FUN
      // =========================================================================
      case "timer":
      case "reminder": {
        const parts = args.split(" ");
        if (parts.length < 2) return "Usage: !timer <time> <message> (e.g. !timer 15m Crate Unlocked)";
        const sec = this.parseTimeString(parts[0]);
        if (sec <= 0) return `⚠️ Invalid time "${parts[0]}".`;
        const msg = parts.slice(1).join(" ");
        const id = `tm_${Date.now()}`;

        const timeout = setTimeout(() => {
          const alertMsg = `⏰ [TIMER ALERT for ${sender}] ${msg}!`;
          console.log(`[Timer] ${alertMsg}`);
          this.rustClient.sendTeamChat(alertMsg).catch(() => {});
          if (this.matrixClient) {
            this.matrixClient.sendAlert(`⏰ Timer Expired`, msg, { "Set By": sender });
          }
          this.activeReminders.delete(id);
        }, sec * 1000);

        this.activeReminders.set(id, {
          timeout,
          msg,
          expiresAt: Date.now() + sec * 1000,
          sender
        });

        return `⏰ Set timer for ${this.formatDuration(sec)}: "${msg}".`;
      }

      case "timers":
      case "reminders": {
        if (this.activeReminders.size === 0) return "ℹ️ No active timers.";
        const list = Array.from(this.activeReminders.values()).map(r => {
          const leftSec = Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000));
          return `"${r.msg}" (${this.formatDuration(leftSec)} left)`;
        }).join(" | ");
        return `⏰ [Active Timers] ${list}`;
      }

      case "timers-clear":
      case "reminders-clear": {
        for (const r of this.activeReminders.values()) {
          clearTimeout(r.timeout);
        }
        this.activeReminders.clear();
        return "⏰ Cleared all active timers.";
      }

      case "note": {
        if (!this.aiAssistant) return "⚠️ Notes system unavailable.";
        const parts = args.split(" ");
        if (parts.length < 2) return "Usage: !note <name> <message>";
        return this.aiAssistant.saveNote(parts[0], parts.slice(1).join(" "));
      }

      case "notes": {
        if (!this.aiAssistant) return "⚠️ Notes system unavailable.";
        return this.aiAssistant.getNotes(args);
      }

      case "notes-clear": {
        if (!this.aiAssistant) return "⚠️ Notes system unavailable.";
        return this.aiAssistant.clearNotes(args);
      }

      case "startwatch": {
        const name = args || "default";
        this.activeStopwatches.set(name, Date.now());
        return `⏱️ Started stopwatch "${name}".`;
      }

      case "stopwatch": {
        const name = args || "default";
        const start = this.activeStopwatches.get(name);
        if (!start) return `⚠️ Stopwatch "${name}" was not started.`;
        const elapsedSec = Math.round((Date.now() - start) / 1000);
        this.activeStopwatches.delete(name);
        return `⏱️ Stopped stopwatch "${name}": ${this.formatDuration(elapsedSec)}.`;
      }

      case "watches": {
        if (this.activeStopwatches.size === 0) return "ℹ️ No running stopwatches.";
        const list = Array.from(this.activeStopwatches.entries()).map(([k, v]) => {
          const sec = Math.round((Date.now() - v) / 1000);
          return `"${k}": ${this.formatDuration(sec)}`;
        }).join(" | ");
        return `⏱️ [Stopwatches] ${list}`;
      }

      case "calc":
      case "calculate": {
        if (!args) return "Usage: !calc <expression>";
        try {
          const sanitized = args.replace(/[^0-9+\-*/().% ]/g, "");
          if (!sanitized) return "⚠️ Invalid mathematical expression.";
          const result = Function(`"use strict"; return (${sanitized});`)();
          return `🔢 [Calc] ${args} = ${result}`;
        } catch (e) {
          return "⚠️ Error calculating expression.";
        }
      }

      case "roll":
      case "rand":
      case "random": {
        let min = 1;
        let max = 100;
        if (args) {
          const parts = args.split(/[- ]+/);
          if (parts.length === 1) max = parseInt(parts[0], 10) || 100;
          if (parts.length >= 2) {
            min = parseInt(parts[0], 10) || 1;
            max = parseInt(parts[1], 10) || 100;
          }
        }
        const rolled = Math.floor(Math.random() * (max - min + 1)) + min;
        return `🎲 [Roll ${min}-${max}] Result: ${rolled}`;
      }

      case "fortune": {
        const quotes = [
          "Check your airlock, someone is camping outside.",
          "An offline raid awaits those who neglect their honeycomb.",
          "A sulfur node in the snow is worth two in the desert.",
          "He who flies the minicopter low fears no SAM site.",
          "Good fortune comes to those who check TC upkeep.",
          "The best defense is an unexpected shotgun trap behind the garage door.",
          "Trust no naked with an eoka pistol in his sash."
        ];
        return `🥠 [Fortune] "${quotes[Math.floor(Math.random() * quotes.length)]}"`;
      }

      case "silent":
      case "mute": {
        const sec = this.parseTimeString(args) || 60;
        this.isMuted = true;
        if (this.muteTimer) clearTimeout(this.muteTimer);
        this.muteTimer = setTimeout(() => {
          this.isMuted = false;
        }, sec * 1000);
        return `🤫 Bot silenced for ${this.formatDuration(sec)}. Use !unsilent to unmute.`;
      }

      case "unsilent":
      case "unmute": {
        this.isMuted = false;
        if (this.muteTimer) clearTimeout(this.muteTimer);
        return "🔊 Bot unmuted.";
      }

      case "prefix": {
        if (!args) return `Current bot prefix: "${this.prefixMessage}"`;
        this.prefixMessage = args;
        return `Set prefix to: "${args}"`;
      }

      case "prefix-clear": {
        this.prefixMessage = "";
        return "Cleared bot prefix.";
      }

      case "delay": {
        const sec = this.parseTimeString(args);
        this.responseDelayMs = Math.min(10000, sec * 1000);
        return `⏱️ Response delay set to ${this.responseDelayMs / 1000}s.`;
      }

      case "speak":
      case "voice": {
        if (!args) return "Usage: !speak <message>";
        if (this.matrixClient) {
          try {
            this.matrixClient.speakVoiceAlert(args, "In-Game Broadcast");
            return `🔊 Broadcasted "${args}" to Matrix voice call!`;
          } catch (e) {
            return `⚠️ Voice alert error: ${e.message}`;
          }
        }
        return "⚠️ Voice call dispatcher not configured.";
      }

      // =========================================================================
      // 7. STEAM & BATTLEMETRICS
      // =========================================================================
      case "steamid": {
        if (!this.externalApis) return "⚠️ External API engine unavailable.";
        if (!args) return "Usage: !steamid <player name or 64-bit Steam ID>";
        return await this.externalApis.getSteamProfile(args);
      }

      case "stats": {
        if (!this.externalApis) return "⚠️ External API engine unavailable.";
        const target = args || sender;
        return await this.externalApis.getPlayerStats(target);
      }

      case "whois":
      case "whoisid": {
        if (!this.externalApis) return "⚠️ External API engine unavailable.";
        if (!args) return "Usage: !whois <player name>";
        return await this.externalApis.lookupBattleMetrics(args);
      }

      case "track": {
        if (!this.externalApis) return "⚠️ External API engine unavailable.";
        if (!args) return this.externalApis.getTrackStatus();
        return this.externalApis.trackPlayer(args);
      }

      case "trackclear": {
        if (!this.externalApis) return "⚠️ External API engine unavailable.";
        return this.externalApis.clearTrackedPlayers();
      }

      case "trackstatus": {
        if (!this.externalApis) return "⚠️ External API engine unavailable.";
        return this.externalApis.getTrackStatus();
      }

      // =========================================================================
      // 8. AI ASSISTANT (!ai)
      // =========================================================================
      case "ai":
      case "assistant": {
        if (!this.aiAssistant) return "ℹ️ AI Assistant is currently disabled in WebUI settings.";
        if (!args) return "Usage: !ai <question about raid costs, base state, crafting, or Rust>";
        return await this.aiAssistant.ask(args, source);
      }

      case "ai-help": {
        return "🤖 RustPlus AI Assistant: Can answer tactical raid questions, sulfur calculations, and base status. Configure or enable it in WebUI Settings.";
      }

      // =========================================================================
      // 9. STATUS & DIRECTORY
      // =========================================================================
      case "status": {
        const isConn = this.rustClient.client?.isConnected();
        const srvName = this.rustClient.activeServer?.name || "None";
        const matrixStatus = this.matrixClient?.isReady ? "Online 🟢" : "Offline 🔴";
        return `🤖 [Status] Server: ${srvName} (${isConn ? "Connected 🟢" : "Disconnected 🔴"}) | Matrix: ${matrixStatus}`;
      }

      case "help":
      case "commands": {
        return "📖 Commands: !pop, !time, !day, !night, !daynight, !clan, !team, !locate <name>, !nearby, !proximity, !afk, !death, !upkeep, !multitc, !boom, !sulfur, !armory, !motd, !contents <box>, !contains <item>, !turrets on/off, !sams on/off, !on/off <name>, !ttoggle <time> <name>, !durability <item>, !craft <qty> <item>, !recycle <item>, !note <name> <msg>, !steamid <name>, !ai <msg>, !status";
      }

      default: {
        // Check if command is a switch name directly (e.g. "!turrets" or "!lights")
        if (this.deviceAutomation) {
          const sw = this.deviceAutomation.findSwitchByIdOrName(cmd);
          if (sw) {
            return await this.flipSwitch(sw.id);
          }
        }
        return null;
      }
    }
  }

  formatTeamList(members) {
    if (!members || members.length === 0) return "ℹ️ No team members found.";
    const mapSize = this.rustClient.serverInfo?.mapSize || 4500;
    const list = members.map(m => {
      const grid = (m.x !== undefined && m.y !== undefined) ? `[${this.rustClient.calculateGrid(m.x, m.y, mapSize)}]` : "";
      const status = m.isAlive ? (m.isOnline ? "🟢" : "🟡") : "🔴";
      return `${status} ${m.name || m.steamId} ${grid}`;
    }).join(" | ");
    return `🛡️ [Team] ${list}`;
  }

  async toggleSwitch(identifier, targetVal) {
    if (!this.rustClient.activeServer || !this.rustClient.client?.isConnected()) {
      return "⚠️ Not connected to active Rust server.";
    }

    const sw = this.deviceAutomation?.findSwitchByIdOrName(identifier);
    if (!sw) return `⚠️ Switch "${identifier}" not found in paired devices.`;

    try {
      await this.rustClient.toggleEntity(sw.id, targetVal);
      return `⚡ Set "${sw.name}" to ${targetVal ? "ON" : "OFF"}.`;
    } catch (e) {
      return `⚠️ Failed to toggle switch: ${e.message}`;
    }
  }

  async flipSwitch(identifier) {
    if (!this.rustClient.activeServer || !this.rustClient.client?.isConnected()) {
      return "⚠️ Not connected to active Rust server.";
    }

    const sw = this.deviceAutomation?.findSwitchByIdOrName(identifier);
    if (!sw) return `⚠️ Switch "${identifier}" not found in paired devices.`;

    const targetVal = !sw.state;
    try {
      await this.rustClient.toggleEntity(sw.id, targetVal);
      return `⚡ Toggled "${sw.name}" to ${targetVal ? "ON" : "OFF"}.`;
    } catch (e) {
      return `⚠️ Failed to flip switch: ${e.message}`;
    }
  }

  async toggleCategory(category, targetVal) {
    if (!this.rustClient.activeServer || !this.rustClient.client?.isConnected()) {
      return "⚠️ Not connected to active Rust server.";
    }

    const switches = this.rustClient.activeServer.switches || [];
    const targets = switches.filter(s => s.category === category || s.name.toLowerCase().includes(category.toLowerCase().replace(/s$/, "")));

    if (targets.length === 0) {
      return `ℹ️ No smart switches found for category "${category}". Pair them with the Wire Tool first!`;
    }

    let successCount = 0;
    for (const sw of targets) {
      try {
        await this.rustClient.toggleEntity(sw.id, targetVal);
        successCount++;
      } catch (e) {}
    }

    return `⚡ Set ${successCount}/${targets.length} ${category} to ${targetVal ? "ON" : "OFF"}.`;
  }

  async strobeSwitch(identifier) {
    if (!this.rustClient.activeServer || !this.rustClient.client?.isConnected()) {
      return "⚠️ Not connected to active Rust server.";
    }
    const sw = this.deviceAutomation?.findSwitchByIdOrName(identifier);
    if (!sw) return `⚠️ Switch "${identifier}" not found in server profile.`;

    try {
      this.rustClient.client.strobe(Number(sw.id), 120, true);
      return `✨ Strobing switch "${sw.name}" (ID: ${sw.id})!`;
    } catch (e) {
      return `⚠️ Strobe failed: ${e.message}`;
    }
  }

  async promoteTeammate(identifier) {
    if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to active Rust server.";
    const team = this.rustClient.teamInfo;
    const member = team?.members?.find(m => String(m.steamId) === identifier || m.name.toLowerCase().includes(identifier.toLowerCase()));

    const targetSteamId = member ? member.steamId : identifier;
    return new Promise((resolve) => {
      try {
        this.rustClient.client.sendRequest({
          promoteToLeader: {
            steamId: String(targetSteamId)
          }
        }, (res) => {
          if (res?.response?.error) {
            resolve(`⚠️ Promote failed: ${res.response.error.error}`);
          } else {
            resolve(`👑 Promoted ${member ? member.name : targetSteamId} to Team Leader!`);
          }
        });
      } catch (e) {
        resolve(`⚠️ Error promoting to leader: ${e.message}`);
      }
    });
  }
}

module.exports = CommandProcessor;
