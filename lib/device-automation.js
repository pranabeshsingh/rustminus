/**
 * Smart Switch & Device Automation Manager
 * Manages:
 * - Auto-on / Auto-off delays
 * - Day / Night triggers
 * - Team offline / online triggers
 * - Timed switch cycling (!ttoggle, !tauto)
 * - SAM Site auto-on delay with voice warning
 * - Alarm activation history
 */

class DeviceAutomation {
  constructor(rustClient, matrixClient) {
    this.rustClient = rustClient;
    this.matrixClient = matrixClient;

    // Rules Storage
    this.autoRules = new Map(); // entityId -> { type: "on"|"off", delaySec: number, name: string }
    this.dayNightRules = new Map(); // entityId -> { action: "day-on"|"day-off"|"night-on"|"night-off", name: string }
    this.teamOfflineRules = new Map(); // entityId -> { action: "on"|"off"|"toggle", name: string }
    this.teamOnlineRules = new Map(); // entityId -> { action: "on"|"off"|"toggle", name: string }
    this.timedToggles = new Map(); // entityId -> { timer, interval, name, expiresAt }
    
    // SAM Site Delay config
    this.samAutoOnDelaySec = 180; // 3 minutes default
    this.samVoiceWarning = true;
    this.samTimer = null;
    this.samWarningTimer = null;

    // Day/Night offset
    this.dayNightOffsetMinutes = 30;
    this.lastIsDay = null;
    this.lastTeamOnlineCount = null;

    // Alarm History: entityId -> lastTriggeredTimestamp
    this.alarmHistory = new Map();

    // Emergency Raid Lockdown State
    this.isLockdownActive = false;
    this.lockdownTriggeredAt = null;
    this.lockdownReason = null;

    this.initListeners();
  }

  parseTimeString(str) {
    if (!str) return 0;
    const s = String(str).toLowerCase().trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10); // pure seconds

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

  initListeners() {
    // 1. Listen for entity state changes
    this.rustClient.on("entityState", ({ entityId, state, name }) => {
      this.handleEntityStateChanged(entityId, state, name);
    });

    // 2. Listen for time updates for Day/Night triggers
    this.rustClient.on("timeInfo", (timeInfo) => {
      this.handleTimeUpdate(timeInfo);
    });

    // 3. Listen for team updates for Team Online/Offline triggers
    this.rustClient.on("teamInfo", (teamInfo) => {
      this.handleTeamUpdate(teamInfo);
    });
  }

  findSwitchByIdOrName(identifier) {
    if (!this.rustClient.activeServer) return null;
    const switches = this.rustClient.activeServer.switches || [];
    const idNum = Number(identifier);
    if (!isNaN(idNum) && idNum > 0) {
      const sw = switches.find(s => Number(s.id) === idNum);
      if (sw) return sw;
    }
    const clean = String(identifier).toLowerCase().trim();
    return switches.find(s => s.name.toLowerCase() === clean || s.name.toLowerCase().includes(clean)) || null;
  }

  findSwitchesByIdOrName(identifier) {
    if (!this.rustClient.activeServer) return [];
    const switches = this.rustClient.activeServer.switches || [];
    const idNum = Number(identifier);
    if (!isNaN(idNum) && idNum > 0) {
      const sw = switches.filter(s => Number(s.id) === idNum);
      if (sw.length > 0) return sw;
    }
    const clean = String(identifier).toLowerCase().trim();
    return switches.filter(s => s.name.toLowerCase() === clean || s.name.toLowerCase().includes(clean));
  }

  handleEntityStateChanged(entityId, state, name) {
    const eId = Number(entityId);
    
    // Check Auto-On / Auto-Off rule
    const rule = this.autoRules.get(eId);
    if (rule) {
      if (!state && rule.type === "on") {
        // Switch turned OFF, trigger auto-ON timer
        console.log(`[Automation] Triggering Auto-ON for ${rule.name} (ID: ${eId}) in ${rule.delaySec}s`);
        setTimeout(async () => {
          try {
            await this.rustClient.toggleEntity(eId, true);
            console.log(`[Automation] Auto-ON executed for ${rule.name} (ID: ${eId})`);
          } catch (e) {
            console.error(`[Automation] Auto-ON failed: ${e.message}`);
          }
        }, rule.delaySec * 1000);
      } else if (state && rule.type === "off") {
        // Switch turned ON, trigger auto-OFF timer
        console.log(`[Automation] Triggering Auto-OFF for ${rule.name} (ID: ${eId}) in ${rule.delaySec}s`);
        setTimeout(async () => {
          try {
            await this.rustClient.toggleEntity(eId, false);
            console.log(`[Automation] Auto-OFF executed for ${rule.name} (ID: ${eId})`);
          } catch (e) {
            console.error(`[Automation] Auto-OFF failed: ${e.message}`);
          }
        }, rule.delaySec * 1000);
      }
    }

    // Check SAM site auto-on delay
    const swName = (name || "").toLowerCase();
    const isSam = swName.includes("sam");
    if (isSam && !state && this.samAutoOnDelaySec > 0) {
      this.scheduleSamAutoOn(eId, name);
    } else if (isSam && state) {
      this.clearSamTimer();
    }
  }

  scheduleSamAutoOn(entityId, switchName) {
    this.clearSamTimer();
    const delayMs = this.samAutoOnDelaySec * 1000;
    console.log(`[Automation] SAM auto-on scheduled in ${this.samAutoOnDelaySec}s for "${switchName}"`);

    // Schedule 10s voice warning before auto-on
    if (this.samVoiceWarning && this.samAutoOnDelaySec > 10) {
      const warningDelayMs = (this.samAutoOnDelaySec - 10) * 1000;
      this.samWarningTimer = setTimeout(() => {
        if (this.matrixClient) {
          try {
            this.matrixClient.speakVoiceAlert(
              "Tactical Alert: Air defense SAM sites activating in ten seconds.",
              "SAM Site Warning"
            );
          } catch (e) {}
        }
      }, warningDelayMs);
    }

    this.samTimer = setTimeout(async () => {
      try {
        console.log(`[Automation] Executing SAM auto-on for ${entityId}`);
        await this.rustClient.toggleEntity(entityId, true);
        if (this.matrixClient) {
          this.matrixClient.sendAlert("⚡ SAM Sites Re-Armed", `Air defense SAM switch "${switchName}" automatically turned back ON.`);
        }
      } catch (e) {
        console.error(`[Automation] SAM auto-on error: ${e.message}`);
      }
    }, delayMs);
  }

  clearSamTimer() {
    if (this.samTimer) {
      clearTimeout(this.samTimer);
      this.samTimer = null;
    }
    if (this.samWarningTimer) {
      clearTimeout(this.samWarningTimer);
      this.samWarningTimer = null;
    }
  }

  handleTimeUpdate(timeInfo) {
    if (!timeInfo || timeInfo.time === undefined || timeInfo.sunrise === undefined || timeInfo.sunset === undefined) return;
    
    // Offset calculation (offset minutes converted to fractional hours)
    const offsetHours = this.dayNightOffsetMinutes / 60;
    const sunrise = timeInfo.sunrise - offsetHours;
    const sunset = timeInfo.sunset + offsetHours;
    const isDay = (timeInfo.time >= sunrise && timeInfo.time < sunset);

    if (this.lastIsDay === null) {
      this.lastIsDay = isDay;
      return;
    }

    // State transition detected
    if (this.lastIsDay !== isDay) {
      this.lastIsDay = isDay;
      console.log(`[Automation] Day/Night Cycle Transition detected: isDay=${isDay}`);

      for (const [entityId, rule] of this.dayNightRules.entries()) {
        let targetState = null;
        if (isDay) {
          if (rule.action === "day-on") targetState = true;
          else if (rule.action === "day-off") targetState = false;
          else if (rule.action === "night-on") targetState = false;
          else if (rule.action === "night-off") targetState = true;
        } else {
          // Night
          if (rule.action === "night-on") targetState = true;
          else if (rule.action === "night-off") targetState = false;
          else if (rule.action === "day-on") targetState = false;
          else if (rule.action === "day-off") targetState = true;
        }

        if (targetState !== null) {
          this.rustClient.toggleEntity(entityId, targetState).catch(() => {});
        }
      }
    }
  }

  handleTeamUpdate(teamInfo) {
    if (!teamInfo || !Array.isArray(teamInfo.members)) return;
    const onlineCount = teamInfo.members.filter(m => m.isOnline).length;

    if (this.lastTeamOnlineCount === null) {
      this.lastTeamOnlineCount = onlineCount;
      return;
    }

    // Team became completely offline (onlineCount === 0)
    if (this.lastTeamOnlineCount > 0 && onlineCount === 0) {
      console.log("[Automation] All team members are now OFFLINE. Triggering offline rules...");
      for (const [entityId, rule] of this.teamOfflineRules.entries()) {
        const val = (rule.action === "on" || rule.action === "toggle");
        this.rustClient.toggleEntity(entityId, val).catch(() => {});
      }
    }
    // Team member came online (onlineCount > 0)
    else if (this.lastTeamOnlineCount === 0 && onlineCount > 0) {
      console.log("[Automation] First team member came ONLINE. Triggering online rules...");
      for (const [entityId, rule] of this.teamOnlineRules.entries()) {
        const val = (rule.action === "on" || rule.action === "toggle");
        this.rustClient.toggleEntity(entityId, val).catch(() => {});
      }
      // If team offline toggle rule was set, revert it back off
      for (const [entityId, rule] of this.teamOfflineRules.entries()) {
        if (rule.action === "toggle") {
          this.rustClient.toggleEntity(entityId, false).catch(() => {});
        }
      }
    }

    this.lastTeamOnlineCount = onlineCount;
  }

  // --- COMMAND METHODS ---

  setAutoRule(nameOrId, type, timeStr) {
    const sw = this.findSwitchByIdOrName(nameOrId);
    if (!sw) return `⚠️ Switch "${nameOrId}" not found.`;
    const sec = this.parseTimeString(timeStr);
    if (sec <= 0) return `⚠️ Invalid time format "${timeStr}". Example: 5m, 1h30m, 30s.`;

    this.autoRules.set(Number(sw.id), {
      type, // "on" or "off"
      delaySec: sec,
      name: sw.name
    });

    return `⚙️ Set Auto-${type.toUpperCase()} for "${sw.name}" after ${this.formatDuration(sec)}.`;
  }

  clearAutoRule(nameOrId) {
    if (!nameOrId) {
      this.autoRules.clear();
      return "⚙️ Cleared all Auto-On / Auto-Off device rules.";
    }
    const sw = this.findSwitchByIdOrName(nameOrId);
    if (!sw) return `⚠️ Switch "${nameOrId}" not found.`;
    this.autoRules.delete(Number(sw.id));
    return `⚙️ Cleared Auto rule for "${sw.name}".`;
  }

  listAutoRules() {
    if (this.autoRules.size === 0) return "ℹ️ No automatic switch rules currently configured.";
    const list = Array.from(this.autoRules.values()).map(r => `"${r.name}": Auto-${r.type.toUpperCase()} (${this.formatDuration(r.delaySec)})`).join(" | ");
    return `⚙️ [Auto Rules] ${list}`;
  }

  setDayNightRule(nameOrId, action) {
    const sw = this.findSwitchByIdOrName(nameOrId);
    if (!sw) return `⚠️ Switch "${nameOrId}" not found.`;

    this.dayNightRules.set(Number(sw.id), {
      action,
      name: sw.name
    });

    return `☀️/🌙 Configured "${sw.name}" to trigger on: ${action.toUpperCase()}`;
  }

  clearDayNightRule(nameOrId) {
    if (!nameOrId) {
      this.dayNightRules.clear();
      return "☀️/🌙 Cleared all Day/Night switch automations.";
    }
    const sw = this.findSwitchByIdOrName(nameOrId);
    if (!sw) return `⚠️ Switch "${nameOrId}" not found.`;
    this.dayNightRules.delete(Number(sw.id));
    return `☀️/🌙 Cleared Day/Night automation for "${sw.name}".`;
  }

  setTeamOfflineRule(nameOrId, action) {
    const sw = this.findSwitchByIdOrName(nameOrId);
    if (!sw) return `⚠️ Switch "${nameOrId}" not found.`;

    this.teamOfflineRules.set(Number(sw.id), { action, name: sw.name });
    return `🛡️ Set Team-Offline trigger: "${sw.name}" turns ${action.toUpperCase()} when all teammates log off.`;
  }

  setTeamOnlineRule(nameOrId, action) {
    const sw = this.findSwitchByIdOrName(nameOrId);
    if (!sw) return `⚠️ Switch "${nameOrId}" not found.`;

    this.teamOnlineRules.set(Number(sw.id), { action, name: sw.name });
    return `🛡️ Set Team-Online trigger: "${sw.name}" turns ${action.toUpperCase()} when first teammate logs on.`;
  }

  clearTeamRules(nameOrId) {
    if (!nameOrId) {
      this.teamOfflineRules.clear();
      this.teamOnlineRules.clear();
      return "🛡️ Cleared all Team Online/Offline switch triggers.";
    }
    const sw = this.findSwitchByIdOrName(nameOrId);
    if (!sw) return `⚠️ Switch "${nameOrId}" not found.`;
    this.teamOfflineRules.delete(Number(sw.id));
    this.teamOnlineRules.delete(Number(sw.id));
    return `🛡️ Cleared Team Online/Offline triggers for "${sw.name}".`;
  }

  startTimedToggle(nameOrId, timeStr, targetState = true) {
    const sw = this.findSwitchByIdOrName(nameOrId);
    if (!sw) return `⚠️ Switch "${nameOrId}" not found.`;
    const sec = this.parseTimeString(timeStr);
    if (sec <= 0) return `⚠️ Invalid duration "${timeStr}".`;

    // Turn ON/OFF now
    this.rustClient.toggleEntity(sw.id, targetState).catch(() => {});

    // Clear existing
    if (this.timedToggles.has(Number(sw.id))) {
      clearTimeout(this.timedToggles.get(Number(sw.id)).timer);
    }

    const timer = setTimeout(() => {
      this.rustClient.toggleEntity(sw.id, !targetState).catch(() => {});
      this.timedToggles.delete(Number(sw.id));
      console.log(`[TimedToggle] Reverted ${sw.name} back to ${!targetState ? "ON" : "OFF"}`);
    }, sec * 1000);

    this.timedToggles.set(Number(sw.id), {
      timer,
      name: sw.name,
      expiresAt: Date.now() + (sec * 1000)
    });

    return `⏱️ Set "${sw.name}" to ${targetState ? "ON" : "OFF"} for ${this.formatDuration(sec)}.`;
  }

  startAutoCycle(nameOrId, onTimeStr, offTimeStr) {
    const sw = this.findSwitchByIdOrName(nameOrId);
    if (!sw) return `⚠️ Switch "${nameOrId}" not found.`;
    const onSec = this.parseTimeString(onTimeStr);
    const offSec = this.parseTimeString(offTimeStr);
    if (onSec <= 0 || offSec <= 0) return "⚠️ Invalid on/off times. Example: !tauto 3m 1m FarmSwitch";

    // Clear existing
    this.clearTimedToggle(sw.id);

    let currentState = true;
    this.rustClient.toggleEntity(sw.id, true).catch(() => {});

    const cycle = () => {
      currentState = !currentState;
      this.rustClient.toggleEntity(sw.id, currentState).catch(() => {});
      const nextDelay = currentState ? onSec : offSec;
      const nextTimer = setTimeout(cycle, nextDelay * 1000);
      this.timedToggles.set(Number(sw.id), {
        timer: nextTimer,
        name: sw.name,
        expiresAt: null
      });
    };

    const firstTimer = setTimeout(cycle, onSec * 1000);
    this.timedToggles.set(Number(sw.id), {
      timer: firstTimer,
      name: sw.name,
      expiresAt: null
    });

    return `🔄 Started auto-cycling "${sw.name}": ON for ${this.formatDuration(onSec)}, OFF for ${this.formatDuration(offSec)}.`;
  }

  clearTimedToggle(nameOrId) {
    if (!nameOrId) {
      for (const t of this.timedToggles.values()) {
        clearTimeout(t.timer);
      }
      this.timedToggles.clear();
      return "⏱️ Cleared all timed toggles.";
    }
    const sw = this.findSwitchByIdOrName(nameOrId);
    if (!sw) return `⚠️ Switch "${nameOrId}" not found.`;
    const t = this.timedToggles.get(Number(sw.id));
    if (t) {
      clearTimeout(t.timer);
      this.timedToggles.delete(Number(sw.id));
      return `⏱️ Cleared timed toggle for "${sw.name}".`;
    }
    return `ℹ️ No active timed toggle for "${sw.name}".`;
  }

  setSamDelay(sec) {
    const val = parseInt(sec, 10);
    if (isNaN(val) || val < 0) return `⚠️ Invalid delay "${sec}". Set 0 to disable.`;
    this.samAutoOnDelaySec = val;
    return `🚀 SAM Auto-On Delay set to ${val === 0 ? "DISABLED" : val + "s"}.`;
  }

  recordAlarmActivation(entityId, name) {
    this.alarmHistory.set(Number(entityId), {
      name,
      timestamp: Date.now()
    });
  }

  getAlarmHistory() {
    if (this.alarmHistory.size === 0) return "ℹ️ No recent smart alarm activations recorded.";
    const list = Array.from(this.alarmHistory.values()).map(a => {
      const ago = Math.round((Date.now() - a.timestamp) / 1000);
      return `🚨 "${a.name}": ${this.formatDuration(ago)} ago`;
    }).join(" | ");
    return `🚨 [Alarm History] ${list}`;
  }

  async triggerLockdown(alarmName = "Base Alarm", entityId = null, source = "alarm") {
    this.isLockdownActive = true;
    this.lockdownTriggeredAt = Date.now();
    this.lockdownReason = `Alarm "${alarmName}" (ID: ${entityId || "N/A"})`;

    console.log(`[DeviceAutomation] 🚨 EMERGENCY COMPOUND LOCKDOWN TRIGGERED: ${this.lockdownReason}`);

    const results = {
      turretsOn: 0,
      samsOn: 0,
      doorsClosed: 0,
      strobesActive: 0
    };

    const server = this.rustClient.activeServer;
    if (server && this.rustClient.client?.isConnected()) {
      const switches = server.switches || [];

      // 1. Turn ON all turrets
      const turrets = switches.filter(s => s.category === "turrets" || s.name.toLowerCase().includes("turret"));
      for (const sw of turrets) {
        try {
          await this.rustClient.toggleEntity(sw.id, true);
          results.turretsOn++;
        } catch (e) {}
      }

      // 2. Turn ON all SAM sites
      const sams = switches.filter(s => s.category === "sams" || s.name.toLowerCase().includes("sam"));
      for (const sw of sams) {
        try {
          await this.rustClient.toggleEntity(sw.id, true);
          results.samsOn++;
        } catch (e) {}
      }

      // 3. Close all doors (door controllers set to false/closed)
      const doors = switches.filter(s => s.category === "doors" || s.name.toLowerCase().includes("door") || s.name.toLowerCase().includes("gate"));
      for (const sw of doors) {
        try {
          await this.rustClient.toggleEntity(sw.id, false);
          results.doorsClosed++;
        } catch (e) {}
      }

      // 4. Strobe / turn on lights
      const lights = switches.filter(s => s.category === "lights" || s.name.toLowerCase().includes("light") || s.name.toLowerCase().includes("strobe") || s.name.toLowerCase().includes("siren"));
      for (const sw of lights) {
        try {
          await this.rustClient.toggleEntity(sw.id, true);
          results.strobesActive++;
        } catch (e) {}
      }
    }

    const alertChat = `🚨 [COMPOUND LOCKDOWN] Alarm "${alarmName}" triggered! Turrets: ON (${results.turretsOn}) | SAMs: ON (${results.samsOn}) | Doors: CLOSED (${results.doorsClosed}). DEFEND BASE!`;
    this.rustClient.sendTeamChat(alertChat).catch(() => {});
    if (this.rustClient.clanInfo?.clanId) {
      this.rustClient.sendClanMessage(alertChat).catch(() => {});
    }

    this.rustClient.emit("lockdown", {
      active: true,
      alarmName,
      entityId,
      source,
      results,
      timestamp: this.lockdownTriggeredAt
    });

    return {
      success: true,
      active: true,
      alarmName,
      results,
      formattedText: alertChat
    };
  }

  async cancelLockdown() {
    this.isLockdownActive = false;
    this.lockdownTriggeredAt = null;
    this.lockdownReason = null;

    const cancelMsg = `🟢 [LOCKDOWN CANCELLED] Stand down. Base defense alert resolved.`;
    this.rustClient.sendTeamChat(cancelMsg).catch(() => {});
    if (this.rustClient.clanInfo?.clanId) {
      this.rustClient.sendClanMessage(cancelMsg).catch(() => {});
    }

    this.rustClient.emit("lockdown", {
      active: false,
      timestamp: Date.now()
    });

    return cancelMsg;
  }

  getLockdownStatus() {
    return {
      active: this.isLockdownActive,
      triggeredAt: this.lockdownTriggeredAt,
      reason: this.lockdownReason,
      timeAgo: this.lockdownTriggeredAt ? `${this.formatDuration(Math.floor((Date.now() - this.lockdownTriggeredAt) / 1000))} ago` : null
    };
  }

  getState() {
    const autoRulesObj = Object.fromEntries(this.autoRules.entries());
    const dayNightObj = Object.fromEntries(this.dayNightRules.entries());
    const teamOfflineObj = Object.fromEntries(this.teamOfflineRules.entries());
    const teamOnlineObj = Object.fromEntries(this.teamOnlineRules.entries());

    return {
      autoRules: autoRulesObj,
      autoRulesList: Array.from(this.autoRules.entries()).map(([id, r]) => ({ entityId: id, ...r })),
      dayNightRules: dayNightObj,
      dayNightRulesList: Array.from(this.dayNightRules.entries()).map(([id, r]) => ({ entityId: id, ...r })),
      teamOfflineRules: teamOfflineObj,
      teamOfflineRulesList: Array.from(this.teamOfflineRules.entries()).map(([id, r]) => ({ entityId: id, ...r })),
      teamOnlineRules: teamOnlineObj,
      teamOnlineRulesList: Array.from(this.teamOnlineRules.entries()).map(([id, r]) => ({ entityId: id, ...r })),
      samConfig: {
        rearmDelaySec: this.samAutoOnDelaySec,
        delaySec: this.samAutoOnDelaySec,
        voiceAlertEnabled: this.samVoiceWarning,
        voiceWarning: this.samVoiceWarning
      },
      alarmHistory: Array.from(this.alarmHistory.entries()).map(([id, d]) => {
        const agoSec = Math.floor((Date.now() - d.timestamp) / 1000);
        return {
          entityId: id,
          ...d,
          agoSec,
          timeAgo: `${this.formatDuration(agoSec)} ago`
        };
      })
    };
  }
}

module.exports = DeviceAutomation;
