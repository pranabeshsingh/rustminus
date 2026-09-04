const path = require("path");
const fs = require("fs");
const CommandProcessor = require("./command-processor");
const DeviceAutomation = require("./device-automation");
const TeamTracker = require("./team-tracker");
const StorageTracker = require("./storage-tracker");
const ExternalAPIs = require("./external-apis");
const AIAssistant = require("./ai-assistant");
const { EventEmitter } = require("events");
const RustPlus = require("@liamcottle/rustplus.js");

const MarkerTypes = {
  0: "Undefined",
  1: "Player",
  2: "Explosion",
  3: "Vending Machine",
  4: "CH47 Chinook",
  5: "Cargo Ship",
  6: "Locked Crate",
  7: "Generic Radius",
  8: "Patrol Helicopter"
};

const MonumentNames = {
  "airfield_display_name": "Airfield",
  "arctic_research_base_display_name": "Arctic Research Base",
  "bandit_town": "Bandit Camp",
  "compound": "Outpost",
  "dome": "The Dome",
  "sphere_tank": "The Dome",
  "ferryterminal": "Ferry Terminal",
  "gas_station": "Oxum's Gas Station",
  "harbor_display_name": "Harbor",
  "harbor_1_display_name": "Harbor 1",
  "harbor_2_display_name": "Harbor 2",
  "junkyard_display_name": "Junkyard",
  "launchsite": "Launch Site",
  "lighthouse_display_name": "Lighthouse",
  "military_tunnel_display_name": "Military Tunnels",
  "mining_outpost_display_name": "Mining Outpost",
  "mining_quarry_stone_display_name": "Stone Quarry",
  "mining_quarry_sulfur_display_name": "Sulfur Quarry",
  "mining_quarry_hqm_display_name": "HQM Quarry",
  "missile_silo_display_name": "Missile Silo",
  "oil_rig_small": "Small Oil Rig",
  "large_oil_rig": "Large Oil Rig",
  "powerplant_display_name": "Power Plant",
  "radtown_display_name": "Water Treatment Plant",
  "satellite_dish_display_name": "Satellite Dish",
  "sewer_display_name": "Sewer Branch",
  "stables_a": "Ranch",
  "stables_b": "Large Barn",
  "supermarket": "Abandoned Supermarket",
  "train_tunnel_display_name": "Train Tunnel Entrance",
  "underwater_lab": "Underwater Lab",
  "water_treatment_plant_display_name": "Water Treatment Plant"
};

class RustPlusManager extends EventEmitter {

  getMarkerTypeName(type) {
    return MarkerTypes[type] || `Event ${type}`;
  }

  getMonumentName(token) {
    if (!token) return "Monument";
    if (MonumentNames[token]) return MonumentNames[token];
    return token
      .replace(/_display_name$/i, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  getItemInfo(itemId) {
    if (!itemId && itemId !== 0) return { name: "Unknown Item", shortname: "unknown" };
    if (!this.itemsMap) {
      try {
        const itemsPath = path.join(__dirname, "..", "data", "items.json");
        if (fs.existsSync(itemsPath)) {
          this.itemsMap = JSON.parse(fs.readFileSync(itemsPath, "utf8"));
        }
      } catch (e) {
        console.warn("[RustPlus] Could not load items.json:", e.message);
        this.itemsMap = {};
      }
    }
    const idStr = String(itemId);
    const idUnsigned = String(Number(itemId) >>> 0);
    const found = (this.itemsMap && (this.itemsMap[idStr] || this.itemsMap[idUnsigned])) || null;
    if (found) {
      return {
        name: found.name || idStr,
        shortname: found.shortname || "unknown",
        description: found.description || ""
      };
    }
    return { name: `Item ${itemId}`, shortname: `item_${itemId}`, description: "" };
  }

  constructor(matrixClient, getServersCallback, saveServersCallback, configManager = null) {
    super();
    this.matrixClient = matrixClient;
    this.configManager = configManager;
    this.getServers = getServersCallback;
    this.saveServers = saveServersCallback;

    this.activeServer = null;
    this.client = null;
    this.connectionStatus = "disconnected"; // disconnected | connecting | connected | error
    this.serverInfo = null;
    this.teamInfo = null;
    this.timeInfo = null;
    this.cachedMap = null;
    this.cachedMapImage = null;
    this.activeMarkers = new Map(); // id -> marker
    this.pollInterval = null;
    this.recentEvents = [];
    this.lastError = null;
    this.itemsMap = null;

    // Tactical & Automation Modules
    this.deviceAutomation = new DeviceAutomation(this, matrixClient);
    this.teamTracker = new TeamTracker(this);
    this.storageTracker = new StorageTracker(this, matrixClient);
    this.externalApis = new ExternalAPIs(configManager);
    this.aiAssistant = new AIAssistant(configManager, this);

    this.commandProcessor = new CommandProcessor(this, matrixClient, {
      deviceAutomation: this.deviceAutomation,
      teamTracker: this.teamTracker,
      storageTracker: this.storageTracker,
      externalApis: this.externalApis,
      aiAssistant: this.aiAssistant
    });
  }

  logEvent(type, title, message, details = {}) {
    const item = {
      id: `evt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      type,
      title,
      message,
      details,
      timestamp: new Date().toISOString()
    };
    this.recentEvents.unshift(item);
    if (this.recentEvents.length > 100) {
      this.recentEvents.pop();
    }
    this.emit("event", item);
  }

  calculateGrid(x, y, mapSize = 4500) {
    if (x === undefined || y === undefined || x === null || y === null) return "Unknown";
    const size = Number(mapSize) || 4500;
    const cellCount = 26;
    const cellSize = size / cellCount;
    const gridCols = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    const clampedX = Math.max(0, Math.min(size - 0.1, Number(x)));
    const clampedY = Math.max(0, Math.min(size - 0.1, Number(y)));

    const colIndex = Math.floor(clampedX / cellSize);
    const rowIndex = Math.floor((size - clampedY) / cellSize);

    const col = gridCols[colIndex] || "Z";
    return `${col}${rowIndex}`;
  }

  async activateServer(serverId) {
    const servers = this.getServers();
    const server = servers.find(s => s.id === serverId);
    if (!server) {
      throw new Error(`Server profile ${serverId} not found`);
    }

    // Set active
    servers.forEach(s => { s.isActive = (s.id === serverId); });
    this.saveServers(servers);
    this.activeServer = server;

    await this.connect();
    return this.activeServer;
  }

  async disconnect() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.client) {
      try {
        this.client.disconnect();
      } catch (e) {
        console.warn("[RustPlus] Error disconnecting client:", e.message);
      }
      this.client = null;
    }

    this.connectionStatus = "disconnected";
    this.activeMarkers.clear();
    this.emit("status", { status: this.connectionStatus, server: this.activeServer });
  }

  async connect() {
    await this.disconnect();

    if (!this.activeServer) {
      const servers = this.getServers();
      this.activeServer = servers.find(s => s.isActive) || null;
      if (!this.activeServer) {
        console.log("[RustPlus] No active server selected to connect.");
        return;
      }
    }

    const { ip, port, playerId, playerToken, useFacepunchProxy, name } = this.activeServer;
    console.log(`[RustPlus] Connecting to ${name} (${ip}:${port})...`);
    this.connectionStatus = "connecting";
    this.lastError = null;
    this.emit("status", { status: this.connectionStatus, server: this.activeServer });

    try {
      this.client = new RustPlus(ip, Number(port), String(playerId), Number(playerToken), !!useFacepunchProxy);

      this.client.on("connecting", () => {
        this.connectionStatus = "connecting";
        this.emit("status", { status: this.connectionStatus, server: this.activeServer });
      });

      this.client.on("connected", async () => {
        console.log(`[RustPlus] Connected successfully to ${this.activeServer.name}!`);
        this.connectionStatus = "connected";
        this.lastError = null;
        this.emit("status", { status: this.connectionStatus, server: this.activeServer });

        this.logEvent("connection", "Connected to Server", `Connected to ${this.activeServer.name} (${this.activeServer.ip}:${this.activeServer.port})`);

        // Fetch initial state
        await this.refreshData();

        // Subscribe to all configured smart switches / alarms
        this.subscribeConfiguredEntities();

        // Start map marker and event tracker polling loop (every 15s)
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.pollInterval = setInterval(() => {
          this.pollMapMarkers();
        }, 15000);

        // Immediate first poll
        this.pollMapMarkers();
      });

      this.client.on("disconnected", () => {
        console.log("[RustPlus] Disconnected from server.");
        this.connectionStatus = "disconnected";
        this.emit("status", { status: this.connectionStatus, server: this.activeServer });
        this.logEvent("connection", "Disconnected", `Disconnected from ${this.activeServer?.name || "Server"}`);
      });

      this.client.on("error", (err) => {
        console.error("[RustPlus] Connection Error:", err.message || err);
        this.connectionStatus = "error";
        this.lastError = err.message || String(err);
        this.emit("status", { status: this.connectionStatus, server: this.activeServer, error: this.lastError });
      });

      this.client.on("message", (message) => {
        this.emit("message", message);
        this.handleIncomingMessage(message);
      });

      this.client.connect();
    } catch (err) {
      console.error("[RustPlus] Setup Error:", err);
      this.connectionStatus = "error";
      this.lastError = err.message;
      this.emit("status", { status: this.connectionStatus, server: this.activeServer, error: this.lastError });
    }
  }

  async refreshData() {
    if (!this.client || !this.client.isConnected()) return;

    try {
      await this.fetchServerInfo();
    } catch (e) {
      console.warn("[RustPlus] Error fetching server info:", e.message);
    }

    try {
      await this.fetchTimeInfo();
    } catch (e) {
      console.warn("[RustPlus] Error fetching time info:", e.message);
    }

    try {
      await this.fetchTeamInfo();
    } catch (e) {
      console.warn("[RustPlus] Error fetching team info:", e.message);
    }

    try {
      await this.fetchMapMarkers();
    } catch (e) {
      console.warn("[RustPlus] Error fetching map markers:", e.message);
    }

    try {
      await this.fetchMapData(false);
    } catch (e) {
      console.warn("[RustPlus] Error fetching map data:", e.message);
    }
  }

  async fetchServerInfo() {
    if (!this.client || !this.client.isConnected()) {
      throw new Error("Not connected to Rust+ server");
    }
    const res = await this.client.getInfo();
    const info = res?.info || res?.response?.info;
    if (info) {
      this.serverInfo = info;
      this.emit("serverInfo", this.serverInfo);
      return this.serverInfo;
    }
    return this.serverInfo;
  }

  async fetchTimeInfo() {
    if (!this.client || !this.client.isConnected()) {
      throw new Error("Not connected to Rust+ server");
    }
    const res = await this.client.getTime();
    const time = res?.time || res?.response?.time;
    if (time) {
      this.timeInfo = time;
      this.emit("timeInfo", this.timeInfo);
      return this.timeInfo;
    }
    return this.timeInfo;
  }

  async fetchTeamInfo() {
    if (!this.client || !this.client.isConnected()) {
      throw new Error("Not connected to Rust+ server");
    }
    const res = await this.client.getTeamInfo();
    const teamInfo = res?.teamInfo || res?.response?.teamInfo;
    if (teamInfo) {
      this.teamInfo = teamInfo;
      this.emit("teamInfo", this.teamInfo);
      return this.teamInfo;
    }
    return this.teamInfo;
  }

  subscribeConfiguredEntities() {
    if (!this.activeServer || !this.client || !this.client.isConnected()) return;

    const allEntities = [
      ...(this.activeServer.switches || []),
      ...(this.activeServer.alarms || [])
    ];

    for (const entity of allEntities) {
      if (entity.id) {
        this.client.getEntityInfo(Number(entity.id), (res) => {
          if (res?.response?.entityInfo?.payload) {
            const val = !!res.response.entityInfo.payload.value;
            entity.state = val;
            this.emit("entityState", { serverId: this.activeServer.id, entityId: entity.id, state: val });
          }
        });
      }
    }
  }

  subscribeEntity(entityId) {
    if (!this.client || !this.client.isConnected()) return;
    try {
      this.client.getEntityInfo(Number(entityId), (res) => {
        if (res?.response?.entityInfo?.payload) {
          const val = !!res.response.entityInfo.payload.value;
          this.emit("entityState", { serverId: this.activeServer?.id, entityId, state: val });
        }
      });
    } catch (e) {
      console.warn(`[RustPlus] Failed to subscribe to entity ${entityId}:`, e.message);
    }
  }

  async handleIncomingMessage(message) {
    if (!message) return;

    // 1. In-game Team Chat message broadcast
    let teamMsg = null;
    if (message.broadcast?.teamMessage?.message) {
      teamMsg = message.broadcast.teamMessage.message;
    } else if (message.broadcast?.teamMessage) {
      teamMsg = message.broadcast.teamMessage;
    }

    if (teamMsg) {
      const senderName = teamMsg.name || (teamMsg.steamId ? String(teamMsg.steamId) : "Teammate");
      const content = String(teamMsg.message || (typeof teamMsg === "string" ? teamMsg : "")).trim();
      const color = teamMsg.color || "#55ff55";

      console.log(`[RustPlus TeamChat] ${senderName}: "${content}"`);
      this.logEvent("teamChat", `Team Chat: ${senderName}`, content, { sender: senderName });
      this.emit("teamMessage", { sender: senderName, message: content, color, time: Date.now() });

      // Forward to Matrix Team Chat room
      if (this.matrixClient) {
        try {
          await this.matrixClient.sendTeamChat(senderName, content, color);
        } catch (e) {
          console.error("[Matrix Relay] Failed to forward team chat:", e.message);
        }
      }

      // Check and handle in-game commands (!pop, !time, !turrets, !help, etc.)
      if ((content.startsWith("!") || content.startsWith(".")) && this.commandProcessor) {
        try {
          console.log(`[Command Processor] Executing command: "${content}" from ${senderName}`);
          const reply = await this.commandProcessor.handleCommand(content, "in-game", senderName);
          if (reply) {
            console.log(`[Command Reply] Dispatching team chat response: "${reply}"`);
            await this.sendTeamChat(reply);
            if (this.matrixClient) {
              await this.matrixClient.sendTeamChat("Rust+ Sentinel", reply, "#00ffff");
            }
          }
        } catch (err) {
          console.error("[Command Processor] Execution error:", err.message);
        }
      }
    }

    // 2. Team Changed Broadcast (Player Death / Respawn / Member changes)
    if (message.broadcast?.teamChanged) {
      console.log("[RustPlus TeamChanged] Team state updated");
      const teamInfo = message.broadcast.teamChanged.teamInfo;
      if (teamInfo) {
        this.teamInfo = teamInfo;
        this.emit("teamInfo", teamInfo);

        // Check if any teammate died
        if (Array.isArray(teamInfo.members)) {
          for (const m of teamInfo.members) {
            if (m && !m.isAlive && m.deathTime && (Date.now() / 1000 - m.deathTime < 30)) {
              const grid = this.calculateGrid(m.x, m.y, this.serverInfo?.mapSize || 4500);
              console.log(`[Team Alert] Teammate ${m.name || m.steamId} died at grid ${grid}!`);
              this.logEvent("death", `Teammate Died: ${m.name}`, `Teammate died at grid ${grid}`, { member: m.name, grid });
              if (this.matrixClient) {
                this.matrixClient.sendAlert(`💀 Teammate Died: ${m.name}`, `Teammate was killed at sector ${grid}.`, {
                  "Player": m.name || m.steamId,
                  "Grid": grid,
                  "Server": this.activeServer?.name || "Active Server"
                }).catch(() => {});
              }
            }
          }
        }
      }
    }

    // 3. Entity Changed Broadcast (Smart Switch / Smart Alarm)
    if (message.broadcast?.entityChanged) {
      const { entityId, payload } = message.broadcast.entityChanged;
      const state = !!payload?.value;
      console.log(`[RustPlus Entity] Entity ${entityId} changed state to ${state}`);
      this.emit("entityChanged", { entityId, payload });

      if (this.activeServer) {
        const servers = this.getServers();
        const server = servers.find(s => s.id === this.activeServer.id);
        if (server) {
          let matched = false;
          let isAlarm = false;
          let entityName = `Device ${entityId}`;

          if (server.switches) {
            const sw = server.switches.find(s => Number(s.id) === Number(entityId));
            if (sw) {
              sw.state = state;
              entityName = sw.name;
              matched = true;
            }
          }

          if (server.alarms) {
            const al = server.alarms.find(a => Number(a.id) === Number(entityId));
            if (al) {
              al.state = state;
              entityName = al.name;
              isAlarm = true;
              matched = true;
            }
          }

          this.saveServers(servers);
          this.activeServer = server;

          this.emit("entityState", { serverId: server.id, entityId, state, name: entityName });

          // If Smart Alarm triggered (state === true), send High-Priority Raid Ping!
          if (isAlarm && state) {
            this.logEvent("raid", "🚨 RAID ALARM TRIGGERED", `Smart Alarm "${entityName}" triggered!`, { entityId, server: server.name });
            if (this.matrixClient) {
              try {
                await this.matrixClient.sendRaidAlert(entityName, entityId, server.name, {
                  "Status": "ACTIVE RAID DETECTED",
                  "Trigger Time": new Date().toLocaleString()
                });
              } catch (e) {
                console.error("[Matrix Raid Alert] Failed to dispatch raid alert:", e.message);
              }
            }
          } else {
            this.logEvent("entity", "Entity State Changed", `${entityName} (ID: ${entityId}) turned ${state ? "ON" : "OFF"}`);
          }
        }
      }
    }

    // 3. Team changed broadcast
    if (message.broadcast?.teamChanged?.teamInfo) {
      this.teamInfo = message.broadcast.teamChanged.teamInfo;
      this.emit("teamInfo", this.teamInfo);
    }
  }

  async fetchMapMarkers() {
    if (!this.client || !this.client.isConnected()) {
      throw new Error("Not connected to Rust+ server");
    }

    const res = await this.client.getMapMarkers();
    const rawMarkers = res?.mapMarkers?.markers || res?.response?.mapMarkers?.markers || [];
    const mapSize = this.serverInfo?.mapSize || 4500;

    const currentMap = new Map();
    const formattedMarkers = [];
    const events = [];
    const vendingMachines = [];

    for (const m of rawMarkers) {
      const typeName = this.getMarkerTypeName(m.type);
      const grid = this.calculateGrid(m.x, m.y, mapSize);
      let sellOrders = [];

      if (Array.isArray(m.sellOrders)) {
        sellOrders = m.sellOrders.map((so) => {
          const item = this.getItemInfo(so.itemId);
          const currency = this.getItemInfo(so.currencyId);
          return {
            itemId: so.itemId,
            itemName: item.name,
            itemShortname: item.shortname,
            quantity: so.quantity,
            currencyId: so.currencyId,
            currencyName: currency.name,
            currencyShortname: currency.shortname,
            costPerItem: so.costPerItem,
            amountInStock: so.amountInStock,
            itemIsBlueprint: !!so.itemIsBlueprint,
            currencyIsBlueprint: !!so.currencyIsBlueprint,
            itemCondition: so.itemCondition,
            itemConditionMax: so.itemConditionMax
          };
        });
      }

      const formatted = {
        id: m.id,
        type: m.type,
        typeName,
        x: m.x,
        y: m.y,
        grid,
        steamId: m.steamId ? String(m.steamId) : null,
        rotation: m.rotation || 0,
        radius: m.radius || 0,
        name: m.name || (m.type === 3 ? "Vending Machine" : typeName),
        outOfStock: !!m.outOfStock,
        sellOrders
      };

      currentMap.set(m.id, formatted);
      formattedMarkers.push(formatted);

      if ([2, 4, 5, 6, 8].includes(m.type)) {
        events.push(formatted);
      } else if (m.type === 3) {
        vendingMachines.push(formatted);
      }

      // Check if this is a newly detected world event
      if (!this.activeMarkers.has(m.id) && [2, 4, 5, 6, 8].includes(m.type)) {
        console.log(`[RustPlus Event] Detected ${typeName} at ${grid} (ID: ${m.id})`);
        
        let emoji = "🔔";
        if (m.type === 5) emoji = "🚢";
        else if (m.type === 8) emoji = "🚁";
        else if (m.type === 4) emoji = "🛩️";
        else if (m.type === 6) emoji = "📦";
        else if (m.type === 2) emoji = "💥";

        const title = `${emoji} ${typeName} Active`;
        const msg = `${typeName} detected near grid ${grid}.`;

        this.logEvent("map", title, msg, {
          Grid: grid,
          Type: typeName,
          Server: this.activeServer?.name || "Rust Server"
        });

        this.emit("mapMarkerSpawn", { marker: formatted, typeName, grid });

        if (this.matrixClient) {
          this.matrixClient.sendAlert(title, msg, {
            "Event": typeName,
            "Grid Location": grid,
            "Coordinates": `X: ${Math.round(m.x)}, Y: ${Math.round(m.y)}`,
            "Server": this.activeServer?.name || "Active Server"
          }).catch(e => console.error("[Matrix Alert] Error sending alert:", e.message));
        }
      }
    }

    this.activeMarkers = currentMap;
    const result = {
      markers: formattedMarkers,
      events,
      vendingMachines,
      count: formattedMarkers.length
    };
    this.emit("markers", result);
    return result;
  }

  async pollMapMarkers() {
    if (!this.client || !this.client.isConnected()) return;
    try {
      await this.fetchMapMarkers();
    } catch (e) {
      console.warn("[RustPlus] Error polling markers:", e.message);
    }
  }

  async getEntityInfo(entityId) {
    if (!this.client || !this.client.isConnected()) {
      throw new Error("Cannot get entity info: Not connected to Rust+ server");
    }
    return new Promise((resolve, reject) => {
      this.client.getEntityInfo(Number(entityId), (res) => {
        if (res?.response?.error) {
          return reject(new Error(res.response.error.error || "Failed to get entity info"));
        }
        resolve(res?.response?.entityInfo || res?.entityInfo || null);
      });
    });
  }

  async toggleEntity(entityId, targetValue) {
    if (!this.client || !this.client.isConnected()) {
      throw new Error("Cannot toggle entity: Not connected to Rust+ server");
    }

    return new Promise((resolve, reject) => {
      this.client.setEntityValue(Number(entityId), !!targetValue, (res) => {
        if (res?.response?.error) {
          return reject(new Error(res.response.error.error || "Failed to set entity value"));
        }

        // Update local state
        if (this.activeServer) {
          const servers = this.getServers();
          const server = servers.find(s => s.id === this.activeServer.id);
          if (server && server.switches) {
            const sw = server.switches.find(s => Number(s.id) === Number(entityId));
            if (sw) sw.state = !!targetValue;
            this.saveServers(servers);
            this.activeServer = server;
          }
        }

        this.emit("entityState", {
          serverId: this.activeServer?.id,
          entityId: Number(entityId),
          state: !!targetValue
        });

        this.logEvent("switch", "Switch Toggled", `Entity ${entityId} toggled to ${targetValue ? "ON" : "OFF"}`);
        resolve({ success: true, entityId, state: !!targetValue });
      });
    });
  }

  async sendTeamChat(message) {
    if (!this.client || !this.client.isConnected()) {
      throw new Error("Cannot send team chat: Not connected to Rust+ server");
    }

    return new Promise((resolve, reject) => {
      this.client.sendTeamMessage(message, (res) => {
        if (res?.response?.error) {
          return reject(new Error(res.response.error.error || "Failed to send team message"));
        }
        resolve({ success: true });
      });
    });
  }

  
  async strobeEntity(entityId, timeoutMilliseconds = 120) {
    if (!this.client || !this.client.isConnected()) {
      throw new Error("Cannot strobe: Not connected to Rust+ server");
    }
    this.client.strobe(Number(entityId), timeoutMilliseconds, true);
    this.logEvent("switch", "Switch Strobed", `Entity ${entityId} started strobing.`);
    return { success: true, entityId };
  }

  async promoteToLeader(steamId) {
    if (!this.client || !this.client.isConnected()) {
      throw new Error("Cannot promote: Not connected to Rust+ server");
    }
    return new Promise((resolve, reject) => {
      this.client.sendRequest({
        promoteToLeader: {
          steamId: String(steamId)
        }
      }, (res) => {
        if (res?.response?.error) {
          return reject(new Error(res.response.error.error || "Failed to promote leader"));
        }
        resolve({ success: true, steamId });
      });
    });
  }

  async fetchMapData(forceRefresh = false) {
    return this.getMapData(forceRefresh);
  }

  async getMapData(forceRefresh = false) {
    if (!forceRefresh && this.cachedMap) {
      return this.cachedMap;
    }
    if (!this.client || !this.client.isConnected()) {
      if (this.cachedMap) return this.cachedMap;
      throw new Error("Cannot get map: Not connected to Rust+ server");
    }

    const res = await this.client.getMap();
    const map = res?.map || res?.response?.map;
    if (!map) {
      const err = res?.error?.error || res?.response?.error?.error || "Failed to fetch map data";
      throw new Error(err);
    }

    // Format monument names
    if (Array.isArray(map.monuments)) {
      const size = this.serverInfo?.mapSize || map.width || 4500;
      map.monuments = map.monuments.map(m => ({
        token: m.token,
        name: this.getMonumentName(m.token),
        x: m.x,
        y: m.y,
        grid: this.calculateGrid(m.x, m.y, size)
      }));
    }

    this.cachedMap = map;
    if (map.jpgImage) {
      this.cachedMapImage = Buffer.isBuffer(map.jpgImage)
        ? map.jpgImage
        : Buffer.from(map.jpgImage, "base64");
    }

    this.emit("mapData", this.cachedMap);
    return this.cachedMap;
  }

  getStatus() {
    return {
      connected: this.connectionStatus === "connected",
      status: this.connectionStatus,
      activeServer: this.activeServer,
      serverInfo: this.serverInfo,
      teamInfo: this.teamInfo,
      timeInfo: this.timeInfo,
      hasMap: !!this.cachedMap,
      markerCount: this.activeMarkers ? this.activeMarkers.size : 0,
      lastError: this.lastError
    };
  }
}

module.exports = RustPlusManager;
