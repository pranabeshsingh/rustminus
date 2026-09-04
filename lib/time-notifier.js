/**
 * TimeNotifier - Day & Night Cycle Alert Manager
 * 
 * Features:
 * - Alerts 5 minutes before Night (Sunset)
 * - Alerts 5 minutes before Day (Sunrise)
 * - Alerts 2 minutes before Day (Sunrise)
 * - Auto-measures game time progression rate for precise real-world countdowns
 * - Broadcasts to In-Game Team Chat, Matrix E2EE Team Chat, Matrix Alert Room, and WebUI Event Log
 */

class TimeNotifier {
  constructor(rustClient, matrixClient, configManager = null) {
    this.rustClient = rustClient;
    this.matrixClient = matrixClient;
    this.configManager = configManager;

    // Alert state tracking to prevent duplicate broadcasts within the same cycle
    this.alertedNight5m = false;
    this.alertedDay5m = false;
    this.alertedDay2m = false;
    this.lastIsDay = null;

    // Rate measurement telemetry
    this.lastSampleTime = null;
    this.lastSampleTimestamp = null;
    this.measuredRate = null; // game hours per real second

    this.initListeners();
  }

  getConfig() {
    const defaultCfg = {
      enabled: true,
      inGameTeamChat: true,
      matrixAlerts: true,
      night5m: true,
      day5m: true,
      day2m: true
    };
    if (this.configManager && typeof this.configManager.getConfig === "function") {
      const cfg = this.configManager.getConfig();
      return { ...defaultCfg, ...(cfg.dayNightAlerts || {}) };
    }
    return defaultCfg;
  }

  saveConfig(newConfig) {
    if (this.configManager && typeof this.configManager.saveConfig === "function") {
      const current = this.configManager.getConfig();
      current.dayNightAlerts = { ...this.getConfig(), ...newConfig };
      this.configManager.saveConfig(current);
    }
  }

  initListeners() {
    if (this.rustClient) {
      this.rustClient.on("timeInfo", (timeInfo) => {
        this.handleTimeUpdate(timeInfo);
      });
    }
  }

  formatHours(val) {
    if (val === undefined || val === null) return "--:--";
    let h = Math.floor(val);
    let m = Math.floor((val - h) * 60);
    if (h >= 24) h %= 24;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  calculateCountdown(timeInfo) {
    if (!timeInfo || timeInfo.time === undefined) return null;

    const time = Number(timeInfo.time);
    const sunrise = Number(timeInfo.sunrise !== undefined ? timeInfo.sunrise : 7.5);
    const sunset = Number(timeInfo.sunset !== undefined ? timeInfo.sunset : 20.0);
    const dayLengthMin = Number(timeInfo.dayLengthMinutes) > 0 ? Number(timeInfo.dayLengthMinutes) : 60;

    const isDay = (time >= sunrise && time < sunset);

    // Update measured rate between samples
    const now = Date.now();
    if (this.lastSampleTimestamp && this.lastSampleTime !== null) {
      const dtRealSec = (now - this.lastSampleTimestamp) / 1000;
      let dtGameHours = time - this.lastSampleTime;
      if (dtGameHours < 0) dtGameHours += 24; // midnight wrap
      if (dtRealSec >= 5 && dtGameHours > 0 && dtGameHours < 2) {
        const sampleRate = dtGameHours / dtRealSec;
        this.measuredRate = this.measuredRate 
          ? (this.measuredRate * 0.7 + sampleRate * 0.3)
          : sampleRate;
      }
    }
    this.lastSampleTime = time;
    this.lastSampleTimestamp = now;

    // Rate in game hours per real second
    const effectiveRate = (this.measuredRate && this.measuredRate > 0)
      ? this.measuredRate
      : (24 / (dayLengthMin * 60));

    let hoursUntil = 0;
    if (isDay) {
      hoursUntil = sunset - time;
      if (hoursUntil < 0) hoursUntil += 24;
    } else {
      hoursUntil = (time < sunrise) ? (sunrise - time) : (24 - time + sunrise);
    }

    const secUntil = Math.max(0, hoursUntil / effectiveRate);
    const minUntil = secUntil / 60;

    return {
      isDay,
      time,
      sunrise,
      sunset,
      hoursUntil,
      secUntil,
      minUntil,
      effectiveRate,
      sunriseStr: this.formatHours(sunrise),
      sunsetStr: this.formatHours(sunset),
      timeStr: this.formatHours(time)
    };
  }

  handleTimeUpdate(timeInfo) {
    const data = this.calculateCountdown(timeInfo);
    if (!data) return;

    const cfg = this.getConfig();
    if (!cfg.enabled) return;

    const { isDay, secUntil, sunriseStr, sunsetStr, timeStr } = data;

    // Handle initial connection state
    if (this.lastIsDay === null) {
      this.lastIsDay = isDay;
      // Mark as already alerted if connecting very close to transition to avoid stale alert
      if (isDay && secUntil < 120) this.alertedNight5m = true;
      if (!isDay && secUntil < 90) {
        this.alertedDay5m = true;
        this.alertedDay2m = true;
      }
      return;
    }

    // State transition detection (Day <-> Night)
    if (this.lastIsDay !== isDay) {
      this.lastIsDay = isDay;
      if (isDay) {
        // Night has ended, Day has begun!
        this.alertedDay5m = false;
        this.alertedDay2m = false;
        this.alertedNight5m = false;
        console.log(`[TimeNotifier] Sunrise detected at ${timeStr}. Day is now active.`);
      } else {
        // Day has ended, Night has begun!
        this.alertedNight5m = false;
        this.alertedDay5m = false;
        this.alertedDay2m = false;
        console.log(`[TimeNotifier] Sunset detected at ${timeStr}. Night is now active.`);
      }
    }

    // Trigger 1: 5 minutes left to be Night (Sunset)
    // 5 minutes = 300 seconds (window 305s down to 30s)
    if (isDay && cfg.night5m) {
      if (secUntil <= 305 && secUntil >= 30 && !this.alertedNight5m) {
        this.alertedNight5m = true;
        const msg = `☀️ ⏳ [Daylight Alert] Night begins in 5 minutes! (Sunset at ${sunsetStr})`;
        this.broadcastAlert("night5m", "☀️ 5 Minutes to Night", msg, {
          remainingMins: 5,
          sunset: sunsetStr,
          currentClock: timeStr
        });
      }
    }

    // Trigger 2: 5 minutes left to be Day (Sunrise)
    // 5 minutes = 300 seconds (window 305s down to 150s)
    if (!isDay && cfg.day5m) {
      if (secUntil <= 305 && secUntil >= 150 && !this.alertedDay5m) {
        this.alertedDay5m = true;
        const msg = `🌙 ⏳ [Dawn Alert] Daylight arrives in 5 minutes! (Sunrise at ${sunriseStr})`;
        this.broadcastAlert("day5m", "🌙 5 Minutes to Day", msg, {
          remainingMins: 5,
          sunrise: sunriseStr,
          currentClock: timeStr
        });
      }
    }

    // Trigger 3: 2 minutes left to be Day (Sunrise)
    // 2 minutes = 120 seconds (window 125s down to 10s)
    if (!isDay && cfg.day2m) {
      if (secUntil <= 125 && secUntil >= 10 && !this.alertedDay2m) {
        this.alertedDay2m = true;
        const msg = `🌅 ⏳ [Dawn Alert] Daylight arrives in 2 minutes! (Sunrise at ${sunriseStr})`;
        this.broadcastAlert("day2m", "🌅 2 Minutes to Day", msg, {
          remainingMins: 2,
          sunrise: sunriseStr,
          currentClock: timeStr
        });
      }
    }
  }

  async broadcastAlert(alertKey, title, message, details = {}) {
    console.log(`[TimeNotifier] Alert "${alertKey}": ${message}`);
    const cfg = this.getConfig();

    // 1. Log event in RustPlus manager
    if (this.rustClient && typeof this.rustClient.logEvent === "function") {
      this.rustClient.logEvent("time", title, message, details);
    }

    // 2. Broadcast to In-Game Team Chat
    if (cfg.inGameTeamChat && this.rustClient && typeof this.rustClient.sendTeamChat === "function") {
      try {
        if (this.rustClient.client && this.rustClient.client.isConnected()) {
          await this.rustClient.sendTeamChat(message);
        }
      } catch (err) {
        console.warn(`[TimeNotifier] In-game team chat failed:`, err.message);
      }
    }

    // 3. Broadcast to Matrix Team Chat & Alerts Room
    if (cfg.matrixAlerts && this.matrixClient) {
      try {
        if (typeof this.matrixClient.sendTeamChat === "function") {
          await this.matrixClient.sendTeamChat("Rust+ Sentinel", message, "#f59e0b");
        }
        if (typeof this.matrixClient.sendAlert === "function") {
          await this.matrixClient.sendAlert(title, message, {
            "In-Game Clock": details.currentClock || "--:--",
            "Target Time": details.sunset || details.sunrise || "--:--",
            "Countdown": `~${details.remainingMins} real minutes`
          });
        }
      } catch (err) {
        console.warn(`[TimeNotifier] Matrix dispatch failed:`, err.message);
      }
    }
  }

  getStatus() {
    const t = this.rustClient?.timeInfo;
    const cd = t ? this.calculateCountdown(t) : null;
    return {
      config: this.getConfig(),
      isDay: cd ? cd.isDay : null,
      currentClock: cd ? cd.timeStr : "--:--",
      sunrise: cd ? cd.sunriseStr : "--:--",
      sunset: cd ? cd.sunsetStr : "--:--",
      minsUntilTransition: cd ? Math.round(cd.minUntil * 10) / 10 : null,
      transitionType: cd ? (cd.isDay ? "Night" : "Day") : null,
      alertedNight5m: this.alertedNight5m,
      alertedDay5m: this.alertedDay5m,
      alertedDay2m: this.alertedDay2m
    };
  }
}

module.exports = TimeNotifier;
