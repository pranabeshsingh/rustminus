/**
 * External APIs Integration
 * Handles:
 * - Steam Web API (Profile info, VAC/Game bans, Official Rust Stats)
 * - BattleMetrics API (Player status, tracking, server players)
 */

const https = require("https");

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "RustPlus-Sentinel/1.0", ...headers } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    }).on("error", reject);
  });
}

class ExternalAPIs {
  constructor(configManager) {
    this.configManager = configManager;
    this.trackedPlayers = new Map(); // name/id -> { lastSeenOnline, lastStatus }
  }

  getSteamApiKey() {
    return this.configManager.getConfig()?.externalApis?.steamApiKey || process.env.STEAM_API_KEY || "";
  }

  getBattleMetricsToken() {
    return this.configManager.getConfig()?.externalApis?.battleMetricsToken || process.env.BATTLEMETRICS_TOKEN || "";
  }

  getBattleMetricsServerId() {
    return this.configManager.getConfig()?.externalApis?.battleMetricsServerId || "";
  }

  async resolveSteamId(input) {
    const s = String(input).trim();
    if (/^\d{17}$/.test(s)) return s; // already 64-bit Steam ID

    const apiKey = this.getSteamApiKey();
    if (!apiKey) return null;

    try {
      const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${apiKey}&vanityurl=${encodeURIComponent(s)}`;
      const res = await fetchJson(url);
      if (res?.response?.success === 1 && res.response.steamid) {
        return res.response.steamid;
      }
    } catch (e) {}
    return null;
  }

  async getSteamProfile(steamIdOrName) {
    const apiKey = this.getSteamApiKey();
    if (!apiKey) {
      return "⚠️ Steam API Key not configured in WebUI Settings. Enter your key in Settings -> External APIs.";
    }

    const steamId = await this.resolveSteamId(steamIdOrName);
    if (!steamId) {
      return `⚠️ Could not resolve "${steamIdOrName}" to a 64-bit Steam ID.`;
    }

    try {
      const [sumRes, banRes] = await Promise.all([
        fetchJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamId}`),
        fetchJson(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${apiKey}&steamids=${steamId}`)
      ]);

      const player = sumRes?.response?.players?.[0];
      const bans = banRes?.players?.[0];

      if (!player) return `⚠️ Steam profile for ID ${steamId} not found.`;

      const vacBanned = bans?.VACBanned ? "🔴 VAC BANNED" : "🟢 Clean";
      const gameBans = (bans?.NumberOfGameBans || 0) > 0 ? `🔴 ${bans.NumberOfGameBans} Game Bans` : "🟢 No Game Bans";
      const commBanned = bans?.CommunityBanned ? "🔴 Community Banned" : "🟢 Clean";
      const daysSinceBan = bans?.DaysSinceLastBan ? ` (Last: ${bans.DaysSinceLastBan}d ago)` : "";

      const createdDate = player.timecreated ? new Date(player.timecreated * 1000).toLocaleDateString() : "Private";

      return `🎮 [Steam Profile: ${player.personaname}] ID: ${steamId} | Created: ${createdDate} | VAC: ${vacBanned} | Game Bans: ${gameBans}${daysSinceBan} | Community: ${commBanned}`;
    } catch (e) {
      return `⚠️ Steam API query failed: ${e.message}`;
    }
  }

  async getPlayerStats(steamIdOrName) {
    const apiKey = this.getSteamApiKey();
    if (!apiKey) {
      return "⚠️ Steam API Key not configured in WebUI Settings.";
    }

    const steamId = await this.resolveSteamId(steamIdOrName);
    if (!steamId) return `⚠️ Could not resolve Steam ID for "${steamIdOrName}".`;

    try {
      const url = `https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v0002/?appid=252490&key=${apiKey}&steamid=${steamId}`;
      const res = await fetchJson(url);
      const statsList = res?.playerstats?.stats;

      if (!statsList) {
        return `⚠️ No public Rust stats found for Steam ID ${steamId}. Profile or game details may be Private.`;
      }

      const getStat = (name) => statsList.find(s => s.name === name)?.value || 0;

      const kills = getStat("kill_player");
      const deaths = getStat("deaths");
      const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills;
      const headshots = getStat("headshot");
      const wood = getStat("harvested_wood");
      const stones = getStat("harvested_stones");
      const metal = getStat("harvested_metal_ore");

      return `📈 [Rust Official Stats: ${steamId}] Kills: ${kills.toLocaleString()} | Deaths: ${deaths.toLocaleString()} (K/D: ${kd}) | Headshots: ${headshots.toLocaleString()} | Farm: ${wood.toLocaleString()}w, ${stones.toLocaleString()}s, ${metal.toLocaleString()}m`;
    } catch (e) {
      return `⚠️ Rust stats query failed: ${e.message}`;
    }
  }

  // --- BattleMetrics Handlers ---

  async lookupBattleMetrics(query) {
    const serverId = this.getBattleMetricsServerId();
    const headers = {};
    const token = this.getBattleMetricsToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    try {
      const clean = encodeURIComponent(String(query).replace(/"/g, ""));
      let url = `https://api.battlemetrics.com/players?filter[search]=${clean}&page[size]=5`;
      if (serverId) {
        url += `&filter[servers]=${serverId}`;
      }

      const res = await fetchJson(url, headers);
      const players = res?.data || [];
      if (players.length === 0) {
        return `🔍 [BattleMetrics] No players found matching "${query}". (Note: Streamer Mode servers hide names).`;
      }

      const list = players.map(p => {
        const name = p.attributes?.name || "Unknown";
        const id = p.id;
        return `"${name}" (BM ID: ${id})`;
      }).join(" | ");

      return `🔍 [BattleMetrics Search] ${list}`;
    } catch (e) {
      return `⚠️ BattleMetrics query failed: ${e.message}`;
    }
  }

  trackPlayer(nameOrId) {
    const q = String(nameOrId).trim();
    this.trackedPlayers.set(q, {
      name: q,
      addedAt: Date.now()
    });
    return `🎯 [Tracker] Now tracking player "${q}". Alerts will trigger on server status changes.`;
  }

  clearTrackedPlayers() {
    this.trackedPlayers.clear();
    return "🎯 [Tracker] Cleared all tracked players.";
  }

  getTrackStatus() {
    if (this.trackedPlayers.size === 0) return "ℹ️ No players currently tracked. Use !track <name>";
    const names = Array.from(this.trackedPlayers.keys()).join(", ");
    return `🎯 [Tracked Players (${this.trackedPlayers.size})] ${names}`;
  }

  async getSteamProfileDetails(steamIdOrName) {
    const apiKey = this.getSteamApiKey();
    if (!apiKey) return { error: "Steam API Key not configured. Please enter your key in Settings." };
    const steamId = await this.resolveSteamId(steamIdOrName);
    if (!steamId) return { error: `Could not resolve "${steamIdOrName}" to a 64-bit Steam ID.` };

    try {
      const [sumRes, banRes] = await Promise.all([
        fetchJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamId}`),
        fetchJson(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${apiKey}&steamids=${steamId}`)
      ]);

      const player = sumRes?.response?.players?.[0];
      const bans = banRes?.players?.[0];
      if (!player) return { error: `Steam profile for ID ${steamId} not found or private.` };

      return {
        success: true,
        steamId,
        personaname: player.personaname,
        avatar: player.avatarfull || player.avatar,
        profileurl: player.profileurl,
        timecreated: player.timecreated ? new Date(player.timecreated * 1000).toLocaleDateString() : "Private",
        vacBanned: !!bans?.VACBanned,
        numberOfVACBans: bans?.NumberOfVACBans || 0,
        gameBans: bans?.NumberOfGameBans || 0,
        communityBanned: !!bans?.CommunityBanned,
        daysSinceLastBan: bans?.DaysSinceLastBan || 0
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  getWatchlist() {
    return Array.from(this.trackedPlayers.values());
  }

  removeFromWatchlist(nameOrId) {
    const q = String(nameOrId).trim();
    this.trackedPlayers.delete(q);
    return true;
  }
}

module.exports = ExternalAPIs;
