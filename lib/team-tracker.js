/**
 * Team Telemetry & Tactical Tracker
 * Manages:
 * - Real-time coordinates & grid sectors
 * - Proximity and distance calculations from caller
 * - AFK detection (5-min standstill notification in team chat, moved after X mins notification)
 * - Death history tracking (last 5 deaths per teammate)
 * - Leader locator and map note pins
 * - Wipe playtime and stats tracking
 */

const fs = require("fs");
const path = require("path");

class TeamTracker {
  constructor(rustClient) {
    this.rustClient = rustClient;
    this.statsFile = path.join(__dirname, "..", "data", "team_stats.json");

    this.afkThresholdSec = 300; // 5 minutes standstill = AFK
    this.movementThresholdMeters = 2.0; // Distance delta considered movement

    // In-memory telemetry: steamId -> { name, x, y, lastMoveTime, lastSeenOnline, isOnline, isAlive, lastDeathTime, isAfkAlerted }
    this.memberLastKnown = new Map();
    this.deathHistory = new Map(); // steamId -> Array of { x, y, grid, timestamp }
    this.wipeStats = this.loadWipeStats(); // steamId -> { name, playTimeSec, afkTimeSec, totalDeaths, distanceMeters }

    this.initListeners();
  }

  loadWipeStats() {
    try {
      if (fs.existsSync(this.statsFile)) {
        return JSON.parse(fs.readFileSync(this.statsFile, "utf8"));
      }
    } catch (e) {
      console.warn("[TeamTracker] Could not load team_stats.json:", e.message);
    }
    return {};
  }

  saveWipeStats() {
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify(this.wipeStats, null, 2), "utf8");
    } catch (e) {}
  }

  initListeners() {
    this.rustClient.on("teamInfo", (teamInfo) => {
      this.processTeamInfo(teamInfo);
    });

    // Check AFK status periodically every 15 seconds
    setInterval(() => {
      this.checkAfkStatus();
    }, 15000);

    // Save stats periodically every 60 seconds
    setInterval(() => {
      this.updateOngoingStats();
      this.saveWipeStats();
    }, 60000);
  }

  async broadcastTeamMessage(message) {
    console.log(`[TeamTracker] AFK Announcement: "${message}"`);
    let inGameSent = false;
    if (this.rustClient.client && this.rustClient.client.isConnected()) {
      try {
        await this.rustClient.sendTeamChat(message);
        inGameSent = true;
      } catch (e) {
        console.warn("[TeamTracker] Failed to send in-game team chat:", e.message);
      }
    }

    // If in-game chat is not connected, dispatch directly to Matrix team chat
    if (!inGameSent && this.rustClient.matrixClient) {
      try {
        await this.rustClient.matrixClient.sendTeamChat("Rust+ Sentinel", message, "#55ff55");
      } catch (e) {
        console.warn("[TeamTracker] Failed to send Matrix team chat:", e.message);
      }
    }
  }

  async checkAfkStatus() {
    const now = Date.now();
    for (const [steamId, data] of this.memberLastKnown.entries()) {
      if (!data.isOnline || !data.isAlive) continue;
      const idleSec = Math.floor((now - data.lastMoveTime) / 1000);
      if (idleSec >= this.afkThresholdSec && !data.isAfkAlerted) {
        data.isAfkAlerted = true;
        const name = data.name || steamId;
        const msg = `💤 ${name} has not moved in 5 mins.`;
        await this.broadcastTeamMessage(msg);
        this.rustClient.logEvent("team", "Teammate AFK", `${name} has not moved in 5 mins.`, { steamId, name });
      }
    }
  }

  processTeamInfo(teamInfo) {
    if (!teamInfo || !Array.isArray(teamInfo.members)) return;
    const now = Date.now();
    const mapSize = this.rustClient.serverInfo?.mapSize || 4500;

    for (const m of teamInfo.members) {
      const steamId = String(m.steamId);
      const name = m.name || steamId;
      const prev = this.memberLastKnown.get(steamId);

      // Initialize stats if missing
      if (!this.wipeStats[steamId]) {
        this.wipeStats[steamId] = {
          name,
          playTimeSec: 0,
          afkTimeSec: 0,
          totalDeaths: 0,
          distanceMeters: 0
        };
      } else {
        this.wipeStats[steamId].name = name;
      }

      if (!prev) {
        this.memberLastKnown.set(steamId, {
          name,
          x: m.x,
          y: m.y,
          lastMoveTime: now,
          lastSeenOnline: m.isOnline ? now : null,
          isOnline: !!m.isOnline,
          isAlive: !!m.isAlive,
          lastDeathTime: m.deathTime || 0,
          isAfkAlerted: false
        });
        continue;
      }

      prev.name = name;

      // Check online / offline transition
      if (!prev.isOnline && m.isOnline) {
        // Player just reconnected
        prev.lastMoveTime = now;
        prev.isAfkAlerted = false;
        prev.x = m.x;
        prev.y = m.y;
      } else if (prev.isOnline && !m.isOnline) {
        // Player logged off
        prev.isAfkAlerted = false;
      }

      // Check respawn transition
      if (!prev.isAlive && m.isAlive) {
        // Player respawned at bed/bag
        prev.lastMoveTime = now;
        prev.isAfkAlerted = false;
        prev.x = m.x;
        prev.y = m.y;
      }

      // Movement check (when player is online and alive)
      if (m.isOnline && m.isAlive) {
        const dx = m.x - prev.x;
        const dy = m.y - prev.y;
        const movedDist = Math.sqrt(dx * dx + dy * dy);

        if (movedDist > this.movementThresholdMeters) {
          // Movement detected!
          if (prev.isAfkAlerted) {
            const idleSec = Math.floor((now - prev.lastMoveTime) / 1000);
            const idleMin = Math.max(5, Math.round(idleSec / 60));
            const msg = `🚶 ${name} moved after ${idleMin} mins.`;
            this.broadcastTeamMessage(msg);
            this.rustClient.logEvent("team", "Teammate Active", `${name} moved after ${idleMin} mins.`, { steamId, name, idleMin });
            prev.isAfkAlerted = false;
          }

          prev.x = m.x;
          prev.y = m.y;
          prev.lastMoveTime = now;
          this.wipeStats[steamId].distanceMeters = Math.round(this.wipeStats[steamId].distanceMeters + movedDist);
        } else {
          // Standing still
          const idleSec = Math.floor((now - prev.lastMoveTime) / 1000);
          if (idleSec >= this.afkThresholdSec && !prev.isAfkAlerted) {
            prev.isAfkAlerted = true;
            const msg = `💤 ${name} has not moved in 5 mins.`;
            this.broadcastTeamMessage(msg);
            this.rustClient.logEvent("team", "Teammate AFK", `${name} has not moved in 5 mins.`, { steamId, name });
          }
        }
      }

      // Update online / alive states
      if (m.isOnline) {
        prev.lastSeenOnline = now;
      }
      prev.isOnline = !!m.isOnline;
      prev.isAlive = !!m.isAlive;

      // Check death
      if (m.deathTime && m.deathTime !== prev.lastDeathTime && !m.isAlive) {
        prev.lastDeathTime = m.deathTime;
        prev.isAfkAlerted = false;
        this.wipeStats[steamId].totalDeaths = (this.wipeStats[steamId].totalDeaths || 0) + 1;

        const grid = this.rustClient.calculateGrid(m.x, m.y, mapSize);
        if (!this.deathHistory.has(steamId)) {
          this.deathHistory.set(steamId, []);
        }
        const hist = this.deathHistory.get(steamId);
        hist.unshift({
          x: m.x,
          y: m.y,
          grid,
          timestamp: now
        });
        if (hist.length > 5) hist.pop();
        console.log(`[TeamTracker] Recorded death for ${name} at ${grid}`);
      }
    }
  }

  updateOngoingStats() {
    const now = Date.now();
    for (const [steamId, data] of this.memberLastKnown.entries()) {
      if (data.isOnline) {
        const stats = this.wipeStats[steamId];
        if (stats) {
          stats.playTimeSec += 60;
          const idleSec = Math.floor((now - data.lastMoveTime) / 1000);
          if (idleSec >= this.afkThresholdSec) {
            stats.afkTimeSec += 60;
          }
        }
      }
    }
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

  findMember(query) {
    const team = this.rustClient.teamInfo?.members || [];
    const q = String(query || "").toLowerCase().trim();
    return team.find(m => String(m.steamId) === q || (m.name && m.name.toLowerCase().includes(q))) || null;
  }

  // --- COMMAND HANDLERS ---

  locateMember(nameOrId) {
    if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to Rust server.";
    const member = this.findMember(nameOrId);
    if (!member) return `⚠️ Teammate "${nameOrId}" not found in current roster.`;
    const mapSize = this.rustClient.serverInfo?.mapSize || 4500;
    const grid = this.rustClient.calculateGrid(member.x, member.y, mapSize);
    const status = member.isAlive ? (member.isOnline ? "🟢 Alive" : "🟡 Sleeping") : "🔴 Dead";
    return `📍 [Locate] ${member.name} (${status}): Grid [${grid}] (X: ${Math.round(member.x)}, Y: ${Math.round(member.y)})`;
  }

  getProximity(callerName) {
    const team = this.rustClient.teamInfo?.members || [];
    if (team.length <= 1) return "ℹ️ No other teammates online to calculate proximity.";

    const caller = this.findMember(callerName) || team[0];
    const mapSize = this.rustClient.serverInfo?.mapSize || 4500;

    const list = [];
    for (const m of team) {
      if (String(m.steamId) === String(caller.steamId)) continue;
      const dist = Math.round(Math.sqrt(Math.pow(caller.x - m.x, 2) + Math.pow(caller.y - m.y, 2)));
      const grid = this.rustClient.calculateGrid(m.x, m.y, mapSize);
      list.push({
        name: m.name || m.steamId,
        dist,
        grid,
        isOnline: m.isOnline,
        isAlive: m.isAlive
      });
    }

    list.sort((a, b) => a.dist - b.dist);
    const formatted = list.map(item => `${item.name} (${item.dist}m @ ${item.grid})`).join(" | ");
    return `📏 [Proximity from ${caller.name}] ${formatted}`;
  }

  getNearby(callerName) {
    const team = this.rustClient.teamInfo?.members || [];
    if (team.length <= 1) return "ℹ️ No other teammates online to calculate nearest.";
    const caller = this.findMember(callerName) || team[0];
    const mapSize = this.rustClient.serverInfo?.mapSize || 4500;

    let nearest = null;
    let minDistance = Infinity;

    for (const m of team) {
      if (String(m.steamId) === String(caller.steamId)) continue;
      const dist = Math.round(Math.sqrt(Math.pow(caller.x - m.x, 2) + Math.pow(caller.y - m.y, 2)));
      if (dist < minDistance) {
        minDistance = dist;
        nearest = m;
      }
    }

    if (!nearest) return "ℹ️ No nearby teammates found.";
    const grid = this.rustClient.calculateGrid(nearest.x, nearest.y, mapSize);
    return `🎯 [Closest Teammate] ${nearest.name} is ${minDistance}m away at [${grid}].`;
  }

  getAfkList(nameOrId) {
    const team = this.rustClient.teamInfo?.members || [];
    const now = Date.now();

    if (nameOrId) {
      const member = this.findMember(nameOrId);
      if (!member) return `⚠️ Teammate "${nameOrId}" not found.`;
      if (!member.isOnline) return `🟡 ${member.name} is currently OFFLINE.`;
      const data = this.memberLastKnown.get(String(member.steamId));
      const idleSec = data ? Math.floor((now - data.lastMoveTime) / 1000) : 0;
      if (idleSec >= this.afkThresholdSec) {
        return `💤 [AFK] ${member.name} has not moved in ${this.formatDuration(idleSec)}.`;
      } else {
        return `🟢 [Active] ${member.name} was active ${this.formatDuration(idleSec)} ago.`;
      }
    }

    const afkList = [];
    for (const m of team) {
      if (!m.isOnline) continue;
      const steamId = String(m.steamId);
      const data = this.memberLastKnown.get(steamId);
      const idleSec = data ? Math.floor((now - data.lastMoveTime) / 1000) : 0;
      if (idleSec >= this.afkThresholdSec) {
        afkList.push({ name: m.name || steamId, idleSec });
      }
    }

    if (afkList.length === 0) return "🟢 No team members are currently AFK.";
    afkList.sort((a, b) => b.idleSec - a.idleSec);
    const list = afkList.map(a => `${a.name} (AFK ${this.formatDuration(a.idleSec)})`).join(" | ");
    return `💤 [AFK Teammates] ${list}`;
  }

  getAliveLongest() {
    const team = this.rustClient.teamInfo?.members || [];
    const aliveMembers = team.filter(m => m.isAlive && m.spawnTime);
    if (aliveMembers.length === 0) return "ℹ️ No living team members found.";

    aliveMembers.sort((a, b) => a.spawnTime - b.spawnTime);
    const champ = aliveMembers[0];
    const aliveSec = Math.floor(Date.now() / 1000 - champ.spawnTime);
    return `👑 [Longest Alive] ${champ.name} has been alive for ${this.formatDuration(aliveSec)}!`;
  }

  getLastDeath(nameOrId, index = 1) {
    const member = this.findMember(nameOrId);
    if (!member) return `⚠️ Teammate "${nameOrId}" not found.`;
    const steamId = String(member.steamId);
    const hist = this.deathHistory.get(steamId) || [];

    if (hist.length === 0) return `ℹ️ No recorded deaths for ${member.name} during this session.`;
    const idx = Math.min(Math.max(1, index), hist.length) - 1;
    const death = hist[idx];
    const agoSec = Math.floor((Date.now() - death.timestamp) / 1000);

    return `💀 [Death #${idx + 1}] ${member.name} died at Grid [${death.grid}] (${this.formatDuration(agoSec)} ago) [X: ${Math.round(death.x)}, Y: ${Math.round(death.y)}]`;
  }

  getAllDeaths(nameOrId) {
    const member = this.findMember(nameOrId);
    if (!member) return `⚠️ Teammate "${nameOrId}" not found.`;
    const steamId = String(member.steamId);
    const hist = this.deathHistory.get(steamId) || [];
    if (hist.length === 0) return `ℹ️ No recorded deaths for ${member.name}.`;

    const list = hist.map((d, i) => `#${i + 1}: Grid [${d.grid}] (${this.formatDuration(Math.floor((Date.now() - d.timestamp) / 1000))} ago)`).join(" | ");
    return `💀 [Death History for ${member.name}] ${list}`;
  }

  getTeamLeaderInfo() {
    const team = this.rustClient.teamInfo;
    if (!team) return "⚠️ Team info unavailable.";
    const mapSize = this.rustClient.serverInfo?.mapSize || 4500;
    const leader = team.members?.find(m => String(m.steamId) === String(team.leaderSteamId));

    if (!leader) return "👑 Team leader could not be determined.";
    const grid = this.rustClient.calculateGrid(leader.x, leader.y, mapSize);

    let noteInfo = "";
    if (Array.isArray(team.leaderMapNotes) && team.leaderMapNotes.length > 0) {
      const note = team.leaderMapNotes[0];
      const noteGrid = this.rustClient.calculateGrid(note.x, note.y, mapSize);
      noteInfo = ` | Leader Pin: [${noteGrid}]`;
    }

    return `👑 [Team Leader] ${leader.name} @ [${grid}]${noteInfo}`;
  }

  getOnlineMembers() {
    const team = this.rustClient.teamInfo?.members || [];
    const online = team.filter(m => m.isOnline);
    if (online.length === 0) return "ℹ️ All team members are currently offline.";
    const list = online.map(m => m.name || m.steamId).join(", ");
    return `🟢 [Online Teammates (${online.length}/${team.length})] ${list}`;
  }

  getOfflineMembers() {
    const team = this.rustClient.teamInfo?.members || [];
    const offline = team.filter(m => !m.isOnline);
    if (offline.length === 0) return "ℹ️ All team members are currently online!";
    const list = offline.map(m => m.name || m.steamId).join(", ");
    return `🟡 [Offline Teammates (${offline.length}/${team.length})] ${list}`;
  }

  getTeamStats(nameOrId) {
    if (nameOrId) {
      const member = this.findMember(nameOrId);
      if (!member) return `⚠️ Member "${nameOrId}" not found.`;
      const s = this.wipeStats[String(member.steamId)] || { playTimeSec: 0, afkTimeSec: 0, totalDeaths: 0, distanceMeters: 0 };
      return `📊 [Stats: ${member.name}] Playtime: ${this.formatDuration(s.playTimeSec)} | AFK: ${this.formatDuration(s.afkTimeSec)} | Deaths: ${s.totalDeaths || 0} | Distance: ${s.distanceMeters.toLocaleString()}m`;
    }

    const entries = Object.values(this.wipeStats);
    if (entries.length === 0) return "ℹ️ No wipe statistics recorded yet.";
    const totalPlay = entries.reduce((acc, v) => acc + v.playTimeSec, 0);
    const totalDeaths = entries.reduce((acc, v) => acc + (v.totalDeaths || 0), 0);
    return `📊 [Team Wipe Stats] Members: ${entries.length} | Combined Playtime: ${this.formatDuration(totalPlay)} | Total Deaths: ${totalDeaths}`;
  }

  async kickMember(nameOrId) {
    if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to Rust server.";
    const member = this.findMember(nameOrId);
    if (!member) return `⚠️ Teammate "${nameOrId}" not found in roster.`;

    return new Promise((resolve) => {
      try {
        this.rustClient.client.sendRequest({
          kickMember: {
            steamId: String(member.steamId)
          }
        }, (res) => {
          if (res?.response?.error) {
            resolve(`⚠️ Kick failed: ${res.response.error.error}`);
          } else {
            resolve(`👢 Successfully kicked ${member.name} from the team!`);
          }
        });
      } catch (e) {
        resolve(`⚠️ Error kicking member: ${e.message}`);
      }
    });
  }

  getTelemetryState() {
    const now = Date.now();
    const mapSize = this.rustClient.serverInfo?.mapSize || 4500;
    const members = [];
    for (const [steamId, data] of this.memberLastKnown.entries()) {
      const idleSec = Math.floor((now - data.lastMoveTime) / 1000);
      members.push({
        steamId,
        name: data.name,
        x: data.x,
        y: data.y,
        grid: this.rustClient.calculateGrid(data.x, data.y, mapSize),
        isOnline: data.isOnline,
        isAlive: data.isAlive,
        lastMoveTime: data.lastMoveTime,
        idleSec,
        idleDuration: this.formatDuration(idleSec),
        isAfk: idleSec >= this.afkThresholdSec,
        isAfkAlerted: data.isAfkAlerted
      });
    }

    const deaths = [];
    for (const [steamId, list] of this.deathHistory.entries()) {
      const member = this.memberLastKnown.get(steamId);
      for (const d of list) {
        deaths.push({
          steamId,
          name: member?.name || steamId,
          x: d.x,
          y: d.y,
          grid: d.grid,
          timestamp: d.timestamp,
          agoDuration: this.formatDuration(Math.floor((now - d.timestamp) / 1000))
        });
      }
    }
    deaths.sort((a, b) => b.timestamp - a.timestamp);

    const leaderboard = Object.entries(this.wipeStats).map(([steamId, stats]) => ({
      steamId,
      ...stats,
      playTimeFormatted: this.formatDuration(stats.playTimeSec),
      afkTimeFormatted: this.formatDuration(stats.afkTimeSec)
    }));
    const afkMap = {};
    for (const m of members) {
      afkMap[m.steamId] = {
        isAfk: m.isAfk,
        idleDurationFormatted: m.idleDuration,
        idleSec: m.idleSec
      };
    }

    return {
      members,
      afk: afkMap,
      deaths: deaths.slice(0, 15).map(d => ({ ...d, timeAgo: `${d.agoDuration} ago` })),
      recentDeaths: deaths.slice(0, 15),
      leaderboard: leaderboard.map(l => ({
        ...l,
        playtimeFormatted: l.playTimeFormatted,
        afkFormatted: l.afkTimeFormatted,
        deathsCount: l.deaths || 0,
        distanceFormatted: `${Math.round(l.distanceTraveledMeters || 0)}m`
      })),
      wipeLeaderboard: leaderboard
    };
  }
}

module.exports = TeamTracker;
