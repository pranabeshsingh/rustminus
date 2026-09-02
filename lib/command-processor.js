class CommandProcessor {
  constructor(rustClient, matrixClient) {
    this.rustClient = rustClient;
    this.matrixClient = matrixClient;
  }

  formatTime(floatHours) {
    if (floatHours === undefined || floatHours === null) return "--:--";
    const hours = Math.floor(floatHours);
    const minutes = Math.floor((floatHours - hours) * 60);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  async handleCommand(rawText, source = "game", sender = "Player") {
    const text = String(rawText || "").trim();
    if (!text.startsWith("!") && !text.startsWith(".")) return null;

    const parts = text.slice(1).split(" ");
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ").trim();

    console.log(`[Command Processor] Handling command "${cmd}" (args: "${args}") from ${source} (${sender})`);

    switch (cmd) {
      case "pop":
      case "players":
      case "player": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to an active Rust server.";
        return new Promise((resolve) => {
          let resolved = false;
          const timer = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              const info = this.rustClient.serverInfo;
              resolve(info ? `👥 [Pop] ${info.players || 0}/${info.maxPlayers || 0} Online | Queue: ${info.queuedPlayers || 0} | ${info.name || "Server"}` : "⚠️ Server population unavailable.");
            }
          }, 1500);

          try {
            this.rustClient.client.getInfo((res) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timer);
              const info = res?.response?.info || this.rustClient.serverInfo;
              resolve(info ? `👥 [Pop] ${info.players || 0}/${info.maxPlayers || 0} Online | Queue: ${info.queuedPlayers || 0} | ${info.name || "Server"}` : "⚠️ Server population unavailable.");
            });
          } catch (e) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve("⚠️ Failed to query population.");
            }
          }
        });
      }

      case "time":
      case "day":
      case "night": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to an active Rust server.";
        return new Promise((resolve) => {
          let resolved = false;
          const timer = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              const t = this.rustClient.timeInfo;
              resolve(t ? `☀️ [Time] ${this.formatTime(t.time)} | Sunrise: ${this.formatTime(t.sunrise)} | Sunset: ${this.formatTime(t.sunset)}` : "⚠️ Time data unavailable.");
            }
          }, 1500);

          try {
            this.rustClient.client.getTime((res) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timer);
              const t = res?.response?.time || this.rustClient.timeInfo;
              if (!t) return resolve("⚠️ Time data unavailable.");
              const isDay = (t.time >= t.sunrise && t.time < t.sunset);
              resolve(`${isDay ? "☀️" : "🌙"} [Time] ${this.formatTime(t.time)} | Sunrise: ${this.formatTime(t.sunrise)} | Sunset: ${this.formatTime(t.sunset)} (${isDay ? "Day" : "Night"})`);
            });
          } catch (e) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve("⚠️ Failed to query in-game time.");
            }
          }
        });
      }

      case "team":
      case "members":
      case "roster": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to an active Rust server.";
        return new Promise((resolve) => {
          let resolved = false;
          const timer = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              const team = this.rustClient.teamInfo;
              resolve(team?.members ? this.formatTeamList(team.members) : "ℹ️ No team members found.");
            }
          }, 1500);

          try {
            this.rustClient.client.getTeamInfo((res) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timer);
              const team = res?.response?.teamInfo || this.rustClient.teamInfo;
              resolve(team?.members ? this.formatTeamList(team.members) : "ℹ️ No team members found.");
            });
          } catch (e) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve("⚠️ Team info query failed.");
            }
          }
        });
      }

      case "events":
      case "monuments":
      case "map": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to an active Rust server.";
        const markers = Array.from(this.rustClient.activeMarkers?.values() || []);
        const events = markers.filter(m => [2, 4, 5, 6, 8].includes(m.type));
        if (events.length === 0) return "🗺️ No active major map events (Cargo, Heli, Chinook, Crates) at this moment.";
        const list = events.map(m => {
          const typeName = this.rustClient.getMarkerTypeName(m.type);
          const grid = this.rustClient.calculateGrid(m.x, m.y, this.rustClient.serverInfo?.mapSize || 4500);
          return `${typeName} @ ${grid}`;
        }).join(" | ");
        return `🗺️ [Active Events] ${list}`;
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
        if (!args) return "Usage: !strobe <switch name or entity id>";
        return await this.strobeSwitch(args);
      }

      case "promote":
      case "leader": {
        if (!args) return "Usage: !promote <steamId or teammate name>";
        return await this.promoteTeammate(args);
      }

      case "speak":
      case "voice": {
        if (!args) return "Usage: !speak <message to broadcast in voice call>";
        if (this.matrixClient) {
          try {
            this.matrixClient.speakVoiceAlert(args, "In-Game Voice Alert");
            return `🔊 Broadcasted "${args}" to Matrix voice call!`;
          } catch (e) {
            return `⚠️ Failed to speak: ${e.message}`;
          }
        }
        return "⚠️ Voice call dispatcher not configured.";
      }

      case "status": {
        const isConn = this.rustClient.client?.isConnected();
        const srvName = this.rustClient.activeServer?.name || "None";
        const matrixStatus = this.matrixClient?.isReady ? "Online 🟢" : "Offline 🔴";
        return `🤖 [Status] Server: ${srvName} (${isConn ? "Connected 🟢" : "Disconnected 🔴"}) | Matrix: ${matrixStatus}`;
      }

      case "info":
      case "server": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to an active Rust server.";
        const info = this.rustClient.serverInfo;
        if (!info) return "⚠️ Server info unavailable.";
        const wipeStr = info.wipeTime ? new Date(info.wipeTime * 1000).toLocaleDateString() : "Unknown";
        return `ℹ️ [Server Info] ${info.name || "Rust Server"} | Map: ${info.map || "Map"} (${info.mapSize || 0}m) | Seed: ${info.seed || "N/A"} | Pop: ${info.players || 0}/${info.maxPlayers || 0} | Wipe: ${wipeStr}`;
      }

      case "vending":
      case "shop":
      case "shops": {
        if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to an active Rust server.";
        const all = Array.from(this.rustClient.activeMarkers?.values() || []);
        const shops = all.filter(m => m.type === 3);
        if (shops.length === 0) return "🛒 No vending machines broadcasted on the map currently.";
        if (!args) {
          return `🛒 [Vending] ${shops.length} active shops on map. Type !vending <item name> to search items.`;
        }
        const query = args.toLowerCase();
        const matches = [];
        for (const shop of shops) {
          const matchedOrders = (shop.sellOrders || []).filter(so => 
            so.itemName.toLowerCase().includes(query) || so.itemShortname.toLowerCase().includes(query)
          );
          if (matchedOrders.length > 0) {
            const itemsList = matchedOrders.map(o => `${o.quantity}x ${o.itemName} for ${o.costPerItem} ${o.currencyName} (${o.amountInStock} in stock)`).join("; ");
            matches.push(`"${shop.name}" @ ${shop.grid}: ${itemsList}`);
          }
        }
        if (matches.length === 0) return `🛒 No shops currently selling "${args}".`;
        return `🛒 [Matches for "${args}"] ` + matches.slice(0, 3).join(" || ");
      }

      case "help":
      case "commands": {
        return "📖 Commands: !info, !pop, !time, !team, !events, !vending <item>, !turrets on/off, !sams on/off, !lights on/off, !doors on/off, !strobe <name>, !promote <name>, !speak <msg>, !status";
      }

      default:
        return null;
    }
  }

  formatTeamList(members) {
    if (!members || members.length === 0) return "ℹ️ No team members found.";
    const mapSize = this.rustClient.serverInfo?.mapSize || 4500;
    const list = members.map(m => {
      const grid = (m.x !== undefined && m.y !== undefined) ? `[${this.rustClient.calculateGrid(m.x, m.y, mapSize)}]` : "";
      const status = m.isAlive ? (m.isOnline ? "🟢 Alive" : "🟡 Sleeping") : "🔴 Dead";
      return `${m.name || m.steamId} ${status} ${grid}`;
    }).join(" | ");
    return `🛡️ [Team] ${list}`;
  }

  async toggleCategory(category, targetVal) {
    if (!this.rustClient.activeServer || !this.rustClient.client?.isConnected()) {
      return "⚠️ Not connected to active Rust server.";
    }

    const switches = this.rustClient.activeServer.switches || [];
    const targets = switches.filter(s => s.category === category || s.name.toLowerCase().includes(category.toLowerCase().replace(/s$/, "")));

    if (targets.length === 0) {
      return `ℹ️ No smart switches found for category "${category}". Pair them in-game first!`;
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
    const switches = this.rustClient.activeServer.switches || [];
    const sw = switches.find(s => String(s.id) === identifier || s.name.toLowerCase().includes(identifier.toLowerCase()));
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
            steamId: targetSteamId
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
