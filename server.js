const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const WebSocket = require("ws");

const MatrixClient = require("./lib/matrix");
const RustPlusManager = require("./lib/rustplus-client");
const FCMService = require("./lib/fcm-service");
const { GameDatabase } = require("./lib/game-database");

const CONFIG_FILE = path.join(__dirname, "data", "config.json");
const SERVERS_FILE = path.join(__dirname, "data", "servers.json");
const PORT = process.env.PORT || 3000;

// Config Manager
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    console.error("[Config] Error reading config file:", err.message);
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  } catch (err) {
    console.error("[Config] Error saving config file:", err.message);
  }
}

const configManager = {
  getConfig: readConfig,
  saveConfig: saveConfig
};

// Servers Manager
function readServers() {
  try {
    return JSON.parse(fs.readFileSync(SERVERS_FILE, "utf8"));
  } catch (err) {
    console.error("[Servers] Error reading servers file:", err.message);
    return [];
  }
}

function saveServers(srvs) {
  try {
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(srvs, null, 2), "utf8");
  } catch (err) {
    console.error("[Servers] Error saving servers file:", err.message);
  }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

// Broadcast to all connected WebSocket clients
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, timestamp: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// Persistent File Session Store
const FileStore = require("session-file-store")(session);
const sessionMiddleware = session({
  store: new FileStore({
    path: path.join(__dirname, "data", "sessions"),
    ttl: 30 * 24 * 60 * 60, // 30 days
    retries: 0,
    logFn: () => {}
  }),
  secret: readConfig().sessionSecret || "rustplus-matrix-manager-session-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: "lax"
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

// Initialize Matrix Client
const initialConfig = readConfig();
const matrixClient = new MatrixClient(initialConfig.matrix || {});

// Initialize RustPlus Manager
const rustManager = new RustPlusManager(matrixClient, readServers, saveServers, configManager);

// Matrix E2EE Commands & TeamChat Relay
matrixClient.setCommandHandler(async (cmd, src, sender) => {
  return await rustManager.commandProcessor.handleCommand(cmd, src, sender);
});
matrixClient.setTeamChatRelay(async (msg) => {
  return await rustManager.sendTeamChat(msg);
});

// Initialize FCM Service
const fcmService = new FCMService(configManager, rustManager, matrixClient);

// Event Bridges & WebSocket broadcasts
rustManager.on("status", (data) => broadcast("rustplus_status", data));
rustManager.on("serverInfo", (data) => broadcast("server_info", data));
rustManager.on("timeInfo", (data) => broadcast("time_info", data));
rustManager.on("teamInfo", (data) => broadcast("team_info", data));
rustManager.on("markers", (data) => broadcast("markers_data", data));
rustManager.on("mapData", (data) => broadcast("map_updated", {
  width: data.width,
  height: data.height,
  oceanMargin: data.oceanMargin,
  monuments: data.monuments,
  background: data.background
}));
rustManager.on("entityState", (data) => broadcast("entity_state", data));
rustManager.on("teamMessage", (data) => broadcast("team_message", data));
rustManager.on("mapMarkerSpawn", (data) => broadcast("map_event", data));
rustManager.on("event", (data) => broadcast("event_log", data));

fcmService.on("status", (data) => broadcast("fcm_status", data));
fcmService.on("pairingLog", (data) => broadcast("pairing_log", data));
fcmService.on("serverPairing", (data) => {
  broadcast("server_paired", data);
  broadcast("servers_list", readServers());
});
fcmService.on("entityPairing", (data) => {
  broadcast("entity_paired", data);
  broadcast("servers_list", readServers());
});

// WebSocket connection handler
wss.on("connection", (ws) => {
  const currentStatus = {
    rustplus: rustManager.getStatus(),
    servers: readServers(),
    activeServer: rustManager.activeServer,
    serverInfo: rustManager.serverInfo,
    teamInfo: rustManager.teamInfo,
    timeInfo: rustManager.timeInfo,
    markers: Array.from(rustManager.activeMarkers?.values() || []),
    hasMap: !!rustManager.cachedMap,
    fcm: fcmService.getStatus(),
    matrix: matrixClient.getStatus(),
    recentEvents: rustManager.recentEvents,
    pairingLogs: fcmService.incomingLogs
  };

  ws.send(JSON.stringify({ type: "init", payload: currentStatus, timestamp: Date.now() }));
});

// Auth Routes (Public)
app.post("/api/auth/login", (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: "Password is required" });
  }

  const cfg = readConfig();
  if (!cfg.adminPasswordHash) {
    return res.status(500).json({ error: "Admin password hash not configured" });
  }

  const matches = bcrypt.compareSync(password, cfg.adminPasswordHash);
  if (matches) {
    req.session.authenticated = true;
    req.session.user = "admin";
    req.session.save((err) => {
      if (err) return res.status(500).json({ error: "Failed to save session" });
      return res.json({ success: true, user: "admin" });
    });
  } else {
    return res.status(401).json({ error: "Invalid password" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get("/api/auth/check", (req, res) => {
  res.json({ authenticated: !!req.session?.authenticated });
});

// Auth Protection Middleware for API
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized. Please log in." });
}

// Protected API Routes
app.use("/api", requireAuth);

// Status & Overview
app.get("/api/status", (req, res) => {
  res.json({
    rustplus: rustManager.getStatus(),
    activeServer: rustManager.activeServer,
    serverInfo: rustManager.serverInfo,
    teamInfo: rustManager.teamInfo,
    timeInfo: rustManager.timeInfo,
    fcm: fcmService.getStatus(),
    matrix: matrixClient.getStatus(),
    uptime: process.uptime()
  });
});

app.get("/api/events", (req, res) => {
  res.json({ events: rustManager.recentEvents });
});

// Settings API (AI Assistant & External Integrations)
app.get("/api/settings", (req, res) => {
  const cfg = readConfig();
  const ai = cfg.ai || {
    enabled: false,
    provider: "gemini",
    apiKey: "",
    model: "gemini-1.5-flash",
    customPrompt: ""
  };
  const externalApis = cfg.externalApis || {
    steamApiKey: "",
    battleMetricsToken: "",
    battleMetricsServerId: ""
  };

  const maskKey = (k) => {
    if (!k || typeof k !== "string") return "";
    if (k.length <= 8) return "********";
    return k.slice(0, 4) + "..." + k.slice(-4);
  };

  res.json({
    success: true,
    ai: {
      enabled: !!ai.enabled,
      provider: ai.provider || "gemini",
      apiKeyMasked: maskKey(ai.apiKey),
      hasApiKey: !!ai.apiKey,
      model: ai.model || (ai.provider === "groq" ? "qwen/qwen3.8-27b" : ai.provider === "openai" ? "gpt-4o-mini" : "gemini-1.5-flash"),
      customPrompt: ai.customPrompt || ""
    },
    dayNightAlerts: cfg.dayNightAlerts || {
      enabled: true,
      inGameTeamChat: true,
      matrixAlerts: true,
      night5m: true,
      day5m: true,
      day2m: true
    },
    externalApis: {
      steamApiKeyMasked: maskKey(externalApis.steamApiKey),
      hasSteamApiKey: !!externalApis.steamApiKey,
      battleMetricsTokenMasked: maskKey(externalApis.battleMetricsToken),
      hasBattleMetricsToken: !!externalApis.battleMetricsToken,
      battleMetricsServerId: externalApis.battleMetricsServerId || ""
    }
  });
});

app.get("/api/time/status", (req, res) => {
  if (!rustManager.timeNotifier) {
    return res.json({ success: false, error: "Time notifier not initialized" });
  }
  res.json({ success: true, ...rustManager.timeNotifier.getStatus() });
});

app.post("/api/settings", (req, res) => {
  const { ai, externalApis, dayNightAlerts } = req.body;
  const cfg = readConfig();

  if (!cfg.ai) {
    cfg.ai = {
      enabled: false,
      provider: "gemini",
      apiKey: "",
      model: "gemini-1.5-flash",
      customPrompt: ""
    };
  }
  if (!cfg.externalApis) {
    cfg.externalApis = {
      steamApiKey: "",
      battleMetricsToken: "",
      battleMetricsServerId: ""
    };
  }
  if (!cfg.dayNightAlerts) {
    cfg.dayNightAlerts = {
      enabled: true,
      inGameTeamChat: true,
      matrixAlerts: true,
      night5m: true,
      day5m: true,
      day2m: true
    };
  }

  if (ai && typeof ai === "object") {
    if (typeof ai.enabled === "boolean") cfg.ai.enabled = ai.enabled;
    if (ai.provider && (ai.provider === "groq" || ai.provider === "gemini" || ai.provider === "openai")) cfg.ai.provider = ai.provider;
    if (ai.model && typeof ai.model === "string") cfg.ai.model = ai.model.trim();
    if (ai.customPrompt !== undefined) cfg.ai.customPrompt = String(ai.customPrompt).trim();
    if (ai.apiKey && typeof ai.apiKey === "string" && !ai.apiKey.includes("...")) {
      cfg.ai.apiKey = ai.apiKey.trim();
    }
  }

  if (dayNightAlerts && typeof dayNightAlerts === "object") {
    if (typeof dayNightAlerts.enabled === "boolean") cfg.dayNightAlerts.enabled = dayNightAlerts.enabled;
    if (typeof dayNightAlerts.inGameTeamChat === "boolean") cfg.dayNightAlerts.inGameTeamChat = dayNightAlerts.inGameTeamChat;
    if (typeof dayNightAlerts.matrixAlerts === "boolean") cfg.dayNightAlerts.matrixAlerts = dayNightAlerts.matrixAlerts;
    if (typeof dayNightAlerts.night5m === "boolean") cfg.dayNightAlerts.night5m = dayNightAlerts.night5m;
    if (typeof dayNightAlerts.day5m === "boolean") cfg.dayNightAlerts.day5m = dayNightAlerts.day5m;
    if (typeof dayNightAlerts.day2m === "boolean") cfg.dayNightAlerts.day2m = dayNightAlerts.day2m;
  }

  if (externalApis && typeof externalApis === "object") {
    if (externalApis.steamApiKey && typeof externalApis.steamApiKey === "string" && !externalApis.steamApiKey.includes("...")) {
      cfg.externalApis.steamApiKey = externalApis.steamApiKey.trim();
    }
    if (externalApis.battleMetricsToken && typeof externalApis.battleMetricsToken === "string" && !externalApis.battleMetricsToken.includes("...")) {
      cfg.externalApis.battleMetricsToken = externalApis.battleMetricsToken.trim();
    }
    if (externalApis.battleMetricsServerId !== undefined) {
      cfg.externalApis.battleMetricsServerId = String(externalApis.battleMetricsServerId).trim();
    }
  }

  saveConfig(cfg);
  rustManager.logEvent("settings", "Settings Updated", "AI Assistant, Day/Night Alerts, and External Integration settings updated.");
  res.json({ success: true, message: "Settings saved successfully." });
});

// ==========================================
// TACTICAL & STORAGE APIS
// ==========================================

// 1. Storage & Upkeep APIs
app.get("/api/storage", (req, res) => {
  res.json({ success: true, ...rustManager.storageTracker.getState() });
});

app.get("/api/storage/search", (req, res) => {
  const q = req.query.q || "";
  const result = rustManager.storageTracker.searchContains(q);
  res.json({ success: true, result });
});

app.get("/api/storage/:id/recycle", (req, res) => {
  const isSafeZone = req.query.safezone === "true";
  const yieldData = rustManager.storageTracker.calculateRecycleYield(req.params.id, isSafeZone);
  if (!yieldData) return res.status(404).json({ error: "Container not found or empty" });
  res.json({ success: true, yield: yieldData });
});

app.post("/api/storage/:id/monitor", (req, res) => {
  const msg = rustManager.storageTracker.toggleMonitor(req.params.id);
  res.json({
    success: true,
    message: msg,
    isMonitored: rustManager.storageTracker.monitoredContainers.has(Number(req.params.id))
  });
});

app.post("/api/storage/refresh", async (req, res) => {
  try {
    const paired = rustManager.storageTracker.getPairedStorageMonitors();
    for (const p of paired) {
      if (p.id) await rustManager.storageTracker.fetchEntity(p.id);
    }
    res.json({ success: true, ...rustManager.storageTracker.getState() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Automation Rules APIs
app.get("/api/automation", (req, res) => {
  res.json({ success: true, ...rustManager.deviceAutomation.getState() });
});

app.post("/api/automation/auto-rule", (req, res) => {
  const { entityId, type, timeStr } = req.body;
  if (!entityId || !type || !timeStr) return res.status(400).json({ error: "Missing required fields" });
  const msg = rustManager.deviceAutomation.setAutoRule(entityId, type, timeStr);
  res.json({ success: true, message: msg, state: rustManager.deviceAutomation.getState() });
});

app.delete("/api/automation/auto-rule/:entityId", (req, res) => {
  const msg = rustManager.deviceAutomation.clearAutoRule(req.params.entityId);
  res.json({ success: true, message: msg, state: rustManager.deviceAutomation.getState() });
});

app.post("/api/automation/day-night", (req, res) => {
  const { entityId, action } = req.body;
  if (!entityId || !action) return res.status(400).json({ error: "entityId and action are required" });
  const msg = rustManager.deviceAutomation.setDayNightRule(entityId, action);
  res.json({ success: true, message: msg, state: rustManager.deviceAutomation.getState() });
});

app.delete("/api/automation/day-night/:entityId", (req, res) => {
  const msg = rustManager.deviceAutomation.clearDayNightRule(req.params.entityId);
  res.json({ success: true, message: msg, state: rustManager.deviceAutomation.getState() });
});

app.post("/api/automation/team-offline", (req, res) => {
  const { entityId, action } = req.body;
  if (!entityId || !action) return res.status(400).json({ error: "entityId and action are required" });
  const msg = rustManager.deviceAutomation.setTeamOfflineRule(entityId, action);
  res.json({ success: true, message: msg, state: rustManager.deviceAutomation.getState() });
});

app.delete("/api/automation/team-offline/:entityId", (req, res) => {
  const msg = rustManager.deviceAutomation.clearTeamRules(req.params.entityId);
  res.json({ success: true, message: msg, state: rustManager.deviceAutomation.getState() });
});

app.post("/api/automation/sam-config", (req, res) => {
  const { delaySec, voiceWarning } = req.body;
  if (delaySec !== undefined) rustManager.deviceAutomation.setSamDelay(delaySec);
  if (typeof voiceWarning === "boolean") rustManager.deviceAutomation.samVoiceWarning = voiceWarning;
  res.json({
    success: true,
    samConfig: {
      delaySec: rustManager.deviceAutomation.samAutoOnDelaySec,
      voiceWarning: rustManager.deviceAutomation.samVoiceWarning
    }
  });
});

app.post("/api/automation/ttoggle", (req, res) => {
  const { entityId, timeStr } = req.body;
  if (!entityId || !timeStr) return res.status(400).json({ error: "entityId and timeStr required" });
  const msg = rustManager.deviceAutomation.startTimedToggle(entityId, timeStr, true);
  res.json({ success: true, message: msg });
});

// 3. Team Telemetry & AFK & Leaderboard APIs
app.get("/api/team/telemetry", (req, res) => {
  res.json({ success: true, ...rustManager.teamTracker.getTelemetryState() });
});

// 4. Tactical Calculators APIs
app.get("/api/calc/durability", (req, res) => {
  const target = req.query.target || "garage door";
  const durability = GameDatabase.getDurabilityData(target);
  const breakdown = GameDatabase.getDurability(target, "explosive", false);
  const bullets = GameDatabase.getDurability(target, "bullet", false);
  const meleeHard = GameDatabase.getDurability(target, "melee", false);
  const meleeSoft = GameDatabase.getDurability(target, "melee", true);
  res.json({ success: true, target, durability, breakdown, bullets, meleeHard, meleeSoft });
});

app.get("/api/calc/craft", (req, res) => {
  const item = req.query.item || "rocket";
  const count = parseInt(req.query.count || req.query.qty, 10) || 1;
  const craft = GameDatabase.getCraftData(item, count);
  const result = GameDatabase.getCraft(item, count);
  res.json({ success: true, item, count, craft, result });
});

app.get("/api/calc/recycle", (req, res) => {
  const item = req.query.item || "tech trash";
  const count = parseInt(req.query.count || req.query.qty, 10) || 1;
  const isSafeZone = req.query.safezone === "true";
  const recycle = GameDatabase.getRecycleData(item, count, isSafeZone);
  const result = GameDatabase.getRecycle(`${count} ${item}`, isSafeZone);
  res.json({ success: true, item, count, isSafeZone, recycle, result });
});

app.get("/api/calc/turrets", (req, res) => {
  const tt = rustManager.turretTracker || rustManager.commandProcessor?.turretTracker;
  const list = tt?.turrets || [];
  const overlap = tt ? tt.checkOverlap() : { hasOverlaps: false, overlaps: [] };
  res.json({ success: true, turrets: list, overlap });
});

app.post("/api/calc/turrets", (req, res) => {
  const tt = rustManager.turretTracker || rustManager.commandProcessor?.turretTracker;
  if (!tt) return res.status(500).json({ error: "Turret tracker not available" });
  const { name, x, y, floor } = req.body;
  if (x === undefined || y === undefined) return res.status(400).json({ error: "x and y are required" });
  const result = tt.addTurret(name || "Turret", Number(x), Number(y), Number(floor || 1));
  const overlap = tt.checkOverlap();
  res.json({ success: true, result, overlap, turrets: tt.turrets });
});

app.delete("/api/calc/turrets", (req, res) => {
  const tt = rustManager.turretTracker || rustManager.commandProcessor?.turretTracker;
  if (tt) tt.clear();
  res.json({ success: true, message: "Cleared all turrets." });
});

// 5. Player & Clan Intelligence (Steam & BattleMetrics)
app.get("/api/intel/steam/:query", async (req, res) => {
  const details = await rustManager.externalApis.getSteamProfileDetails(req.params.query);
  res.json(details);
});

app.get("/api/intel/watchlist", (req, res) => {
  res.json({ success: true, watchlist: rustManager.externalApis.getWatchlist() });
});

app.post("/api/intel/watchlist", (req, res) => {
  const { nameOrId } = req.body;
  if (!nameOrId) return res.status(400).json({ error: "nameOrId is required" });
  const msg = rustManager.externalApis.trackPlayer(nameOrId);
  res.json({ success: true, message: msg, watchlist: rustManager.externalApis.getWatchlist() });
});

app.delete("/api/intel/watchlist/:id", (req, res) => {
  rustManager.externalApis.removeFromWatchlist(req.params.id);
  res.json({ success: true, watchlist: rustManager.externalApis.getWatchlist() });
});

// 6. Tactical Notes & WebUI AI Chat
app.get("/api/notes", (req, res) => {
  const notes = Array.from(rustManager.aiAssistant.savedNotes.entries()).map(([k, v]) => ({ name: k, text: v }));
  res.json({ success: true, notes });
});

app.post("/api/notes", (req, res) => {
  const { name, text } = req.body;
  if (!name || !text) return res.status(400).json({ error: "name and text are required" });
  const msg = rustManager.aiAssistant.saveNote(name, text);
  res.json({
    success: true,
    message: msg,
    notes: Array.from(rustManager.aiAssistant.savedNotes.entries()).map(([k, v]) => ({ name: k, text: v }))
  });
});

app.delete("/api/notes/:name", (req, res) => {
  rustManager.aiAssistant.savedNotes.delete(req.params.name);
  res.json({
    success: true,
    notes: Array.from(rustManager.aiAssistant.savedNotes.entries()).map(([k, v]) => ({ name: k, text: v }))
  });
});

app.delete("/api/notes", (req, res) => {
  rustManager.aiAssistant.savedNotes.clear();
  res.json({ success: true, notes: [] });
});

app.post("/api/ai/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message is required" });
  const reply = await rustManager.aiAssistant.ask(message, "webui");
  res.json({ success: true, reply });
});

// Servers Management
app.get("/api/servers", (req, res) => {
  res.json({ servers: readServers() });
});

app.post("/api/servers", (req, res) => {
  const { id, name, ip, port, playerId, playerToken, useFacepunchProxy } = req.body;
  if (!name || !ip || !port || !playerId || playerToken === undefined) {
    return res.status(400).json({ error: "Missing required server fields (name, ip, port, playerId, playerToken)" });
  }

  const servers = readServers();
  let server;

  if (id) {
    server = servers.find(s => s.id === id);
    if (server) {
      server.name = name;
      server.ip = ip;
      server.port = Number(port);
      server.playerId = String(playerId);
      server.playerToken = Number(playerToken);
      server.useFacepunchProxy = !!useFacepunchProxy;
    }
  }

  if (!server) {
    server = {
      id: id || `srv_${Date.now()}`,
      name,
      ip,
      port: Number(port),
      playerId: String(playerId),
      playerToken: Number(playerToken),
      useFacepunchProxy: !!useFacepunchProxy,
      isActive: false,
      switches: [],
      alarms: []
    };
    servers.push(server);
  }

  saveServers(servers);
  broadcast("servers_list", servers);
  res.json({ success: true, server });
});

app.delete("/api/servers/:id", async (req, res) => {
  const { id } = req.params;
  let servers = readServers();
  const server = servers.find(s => s.id === id);
  if (!server) {
    return res.status(404).json({ error: "Server not found" });
  }

  if (server.isActive) {
    await rustManager.disconnect();
  }

  servers = servers.filter(s => s.id !== id);
  saveServers(servers);
  broadcast("servers_list", servers);
  res.json({ success: true });
});

app.post("/api/servers/:id/activate", async (req, res) => {
  const { id } = req.params;
  try {
    const active = await rustManager.activateServer(id);
    broadcast("servers_list", readServers());
    res.json({ success: true, server: active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/servers/:id/disconnect", async (req, res) => {
  try {
    await rustManager.disconnect();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Entity Management
app.post("/api/servers/:id/entities", (req, res) => {
  const { id } = req.params;
  const { entityId, name, category, type } = req.body;
  if (!entityId || !name) {
    return res.status(400).json({ error: "entityId and name are required" });
  }

  const servers = readServers();
  const server = servers.find(s => s.id === id);
  if (!server) {
    return res.status(404).json({ error: "Server not found" });
  }

  const eId = Number(entityId);
  const isAlarm = (type === "alarm" || category === "Alarm");

  if (isAlarm) {
    if (!server.alarms) server.alarms = [];
    const existing = server.alarms.find(a => Number(a.id) === eId);
    if (existing) {
      existing.name = name;
    } else {
      server.alarms.push({ id: eId, name, type: "alarm", state: false });
    }
  } else {
    if (!server.switches) server.switches = [];
    const existing = server.switches.find(s => Number(s.id) === eId);
    if (existing) {
      existing.name = name;
      existing.category = category || existing.category || "Turrets";
    } else {
      server.switches.push({
        id: eId,
        name,
        category: category || "Turrets",
        type: "switch",
        state: false
      });
    }
  }

  saveServers(servers);
  if (server.isActive) {
    rustManager.activeServer = server;
    rustManager.subscribeEntity(eId);
  }

  broadcast("servers_list", servers);
  res.json({ success: true, server });
});

app.delete("/api/servers/:id/entities/:entityId", (req, res) => {
  const { id, entityId } = req.params;
  const servers = readServers();
  const server = servers.find(s => s.id === id);
  if (!server) {
    return res.status(404).json({ error: "Server not found" });
  }

  const eId = Number(entityId);
  if (server.switches) {
    server.switches = server.switches.filter(s => Number(s.id) !== eId);
  }
  if (server.alarms) {
    server.alarms = server.alarms.filter(a => Number(a.id) !== eId);
  }

  saveServers(servers);
  if (server.isActive) {
    rustManager.activeServer = server;
  }

  broadcast("servers_list", servers);
  res.json({ success: true, server });
});

// Entity Toggling
app.post("/api/entities/toggle", async (req, res) => {
  const { entityId, value } = req.body;
  if (entityId === undefined || value === undefined) {
    return res.status(400).json({ error: "entityId and value are required" });
  }

  try {
    const result = await rustManager.toggleEntity(Number(entityId), !!value);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quick Action (All Turrets ON/OFF, Base Lights ON/OFF, SAMs ON/OFF)
app.post("/api/entities/quick-action", async (req, res) => {
  const { action } = req.body;
  if (!rustManager.activeServer || !rustManager.client?.isConnected()) {
    return res.status(400).json({ error: "Not connected to an active Rust server" });
  }

  const switches = rustManager.activeServer.switches || [];
  let targets = [];
  let targetVal = true;

  if (action === "turrets_on") {
    targets = switches.filter(s => s.category === "Turrets" || s.name.toLowerCase().includes("turret"));
    targetVal = true;
  } else if (action === "turrets_off") {
    targets = switches.filter(s => s.category === "Turrets" || s.name.toLowerCase().includes("turret"));
    targetVal = false;
  } else if (action === "sams_on") {
    targets = switches.filter(s => s.category === "SAMs" || s.name.toLowerCase().includes("sam"));
    targetVal = true;
  } else if (action === "sams_off") {
    targets = switches.filter(s => s.category === "SAMs" || s.name.toLowerCase().includes("sam"));
    targetVal = false;
  } else if (action === "lights_on") {
    targets = switches.filter(s => s.category === "Lights" || s.name.toLowerCase().includes("light"));
    targetVal = true;
  } else if (action === "lights_off") {
    targets = switches.filter(s => s.category === "Lights" || s.name.toLowerCase().includes("light"));
    targetVal = false;
  } else {
    return res.status(400).json({ error: "Unknown quick action" });
  }

  const results = [];
  for (const sw of targets) {
    try {
      await rustManager.toggleEntity(sw.id, targetVal);
      results.push({ id: sw.id, success: true });
    } catch (e) {
      results.push({ id: sw.id, success: false, error: e.message });
    }
  }

  res.json({ success: true, action, targetVal, results });
});

// Team Chat

// Promote Teammate to Leader
app.post("/api/team/promote", async (req, res) => {
  const { steamId } = req.body;
  if (!steamId) return res.status(400).json({ error: "Missing steamId" });
  try {
    const result = await rustManager.promoteToLeader(steamId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Strobe Entity
app.post("/api/entities/strobe", async (req, res) => {
  const { entityId, timeout } = req.body;
  if (!entityId) return res.status(400).json({ error: "Missing entityId" });
  try {
    const result = await rustManager.strobeEntity(entityId, timeout || 120);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1. Server Info (getInfo)
app.get("/api/info", async (req, res) => {
  try {
    if (req.query.refresh === "true" || !rustManager.serverInfo) {
      await rustManager.fetchServerInfo();
    }
    res.json({ success: true, info: rustManager.serverInfo });
  } catch (err) {
    res.status(500).json({ error: err.message, info: rustManager.serverInfo });
  }
});

app.post("/api/info/refresh", async (req, res) => {
  try {
    const info = await rustManager.fetchServerInfo();
    broadcast("server_info", info);
    res.json({ success: true, info });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. In-Game Time (getTime)
app.get("/api/time", async (req, res) => {
  try {
    if (req.query.refresh === "true" || !rustManager.timeInfo) {
      await rustManager.fetchTimeInfo();
    }
    res.json({ success: true, time: rustManager.timeInfo });
  } catch (err) {
    res.status(500).json({ error: err.message, time: rustManager.timeInfo });
  }
});

app.post("/api/time/refresh", async (req, res) => {
  try {
    const time = await rustManager.fetchTimeInfo();
    broadcast("time_info", time);
    res.json({ success: true, time });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Map & Image (getMap)
app.get("/api/map", async (req, res) => {
  try {
    const force = req.query.refresh === "true";
    const map = await rustManager.getMapData(force);
    res.json({
      success: true,
      map: {
        width: map.width,
        height: map.height,
        oceanMargin: map.oceanMargin,
        background: map.background,
        monuments: map.monuments || [],
        monumentCount: map.monuments ? map.monuments.length : 0,
        hasImage: !!rustManager.cachedMapImage
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/map/image", async (req, res) => {
  try {
    if (!rustManager.cachedMapImage) {
      await rustManager.getMapData(false);
    }
    if (!rustManager.cachedMapImage) {
      return res.status(404).send("Map image not available");
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=180");
    res.send(rustManager.cachedMapImage);
  } catch (err) {
    res.status(500).send("Error loading map image: " + err.message);
  }
});

app.post("/api/map/refresh", async (req, res) => {
  try {
    const map = await rustManager.getMapData(true);
    broadcast("map_updated", {
      width: map.width,
      height: map.height,
      oceanMargin: map.oceanMargin,
      monuments: map.monuments,
      background: map.background
    });
    res.json({
      success: true,
      monumentCount: map.monuments?.length || 0,
      width: map.width,
      height: map.height
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Map Markers & Vending (getMapMarkers)
app.get("/api/markers", async (req, res) => {
  try {
    if (req.query.refresh === "true" || rustManager.activeMarkers.size === 0) {
      await rustManager.fetchMapMarkers();
    }
    const all = Array.from(rustManager.activeMarkers.values());
    const events = all.filter(m => [2, 4, 5, 6, 8].includes(m.type));
    const vendingMachines = all.filter(m => m.type === 3);
    res.json({
      success: true,
      markers: all,
      events,
      vendingMachines,
      count: all.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/markers/refresh", async (req, res) => {
  try {
    const result = await rustManager.fetchMapMarkers();
    broadcast("markers_data", result);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy backward-compatibility for active events
app.get("/api/events/active", (req, res) => {
  const all = Array.from(rustManager.activeMarkers?.values() || []);
  const events = all.filter(m => [2, 4, 5, 6, 8].includes(m.type));
  res.json({
    activeEvents: events,
    count: events.length
  });
});

// 5. Team Info & Members (getTeamInfo)
app.get("/api/team", async (req, res) => {
  try {
    if (req.query.refresh === "true" || !rustManager.teamInfo) {
      await rustManager.fetchTeamInfo();
    }
    const teamInfo = rustManager.teamInfo || {};
    const mapSize = rustManager.serverInfo?.mapSize || 4500;
    const members = (teamInfo.members || []).map(m => ({
      steamId: String(m.steamId),
      name: m.name || "Teammate",
      x: m.x,
      y: m.y,
      grid: rustManager.calculateGrid(m.x, m.y, mapSize),
      isOnline: !!m.isOnline,
      isAlive: !!m.isAlive,
      spawnTime: m.spawnTime,
      deathTime: m.deathTime,
      isLeader: String(m.steamId) === String(teamInfo.leaderSteamId)
    }));

    res.json({
      success: true,
      teamInfo,
      members,
      leaderSteamId: teamInfo.leaderSteamId ? String(teamInfo.leaderSteamId) : null,
      mapNotes: teamInfo.mapNotes || [],
      leaderMapNotes: teamInfo.leaderMapNotes || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/team/refresh", async (req, res) => {
  try {
    const teamInfo = await rustManager.fetchTeamInfo();
    broadcast("team_info", teamInfo);
    res.json({ success: true, teamInfo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/team/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message content is required" });
  }

  try {
    await rustManager.sendTeamChat(message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FCM Pairing Listener API
app.post("/api/fcm/toggle", async (req, res) => {
  const { enabled } = req.body;
  try {
    if (enabled) {
      await fcmService.startListener();
    } else {
      await fcmService.stopListener();
    }
    res.json({ success: true, status: fcmService.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/fcm/register", async (req, res) => {
  try {
    const result = await fcmService.registerFCM();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import complete rustplus.config.json from @liamcottle/rustplus.js
app.post("/api/fcm/import-config", async (req, res) => {
  console.log("[FCM Import] Request received");
  const { config, jsonContent } = req.body;
  let parsed = config;
  
  if (jsonContent && typeof jsonContent === "string") {
    try {
      parsed = JSON.parse(jsonContent);
    } catch (e) {
      console.error("[FCM Import] JSON parse error:", e.message);
      return res.status(400).json({ error: "Invalid JSON format: " + e.message });
    }
  }

  if (!parsed) {
    return res.status(400).json({ error: "No configuration payload provided" });
  }

  // Normalize structure
  let fcmCreds = parsed.fcm_credentials || (parsed.gcm ? parsed : null);
  if (!fcmCreds) {
    return res.status(400).json({ error: "Missing required 'fcm_credentials' or 'gcm' in JSON" });
  }

  try {
    const currentConfig = configManager.getConfig();
    currentConfig.fcm = {
      ...currentConfig.fcm,
      fcm_credentials: fcmCreds,
      expo_push_token: parsed.expo_push_token || currentConfig.fcm?.expo_push_token,
      rustplus_auth_token: parsed.rustplus_auth_token || currentConfig.fcm?.rustplus_auth_token
    };
    configManager.saveConfig(currentConfig);

    console.log("[FCM Import] Config saved. Restarting listener with new credentials...");
    await fcmService.stopListener();
    await fcmService.startListener();

    rustManager.logEvent("fcm", "rustplus.config.json Imported", "Successfully imported FCM & Steam Companion credentials.");
    console.log("[FCM Import] Listener restarted successfully!");
    res.json({ success: true, status: fcmService.getStatus() });
  } catch (err) {
    console.error("[FCM Import] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/fcm/save-token", async (req, res) => {
  const { authToken } = req.body;
  if (!authToken) {
    return res.status(400).json({ error: "authToken is required" });
  }
  try {
    const result = await fcmService.linkWithCompanionAuthToken(authToken);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/fcm/logs", (req, res) => {
  res.json({ logs: fcmService.incomingLogs });
});

// Diagnostics & Matrix Triggers
app.post("/api/matrix/test-alert", async (req, res) => {
  try {
    const response = await matrixClient.sendAlert(
      "🛠️ Diagnostic Alert Test",
      "This is a verified test dispatch from the Rust+ Multi-Server Manager.",
      {
        "Origin": "rust.trylocalhost.com",
        "Target Room": "Alerts",
        "Timestamp": new Date().toISOString()
      }
    );
    rustManager.logEvent("diagnostic", "Matrix Alert Test Sent", "Test alert dispatched to Matrix Alerts room.");
    res.json({ success: true, response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/matrix/test-raid", async (req, res) => {
  try {
    const response = await matrixClient.sendRaidAlert(
      "Diagnostic Core TC Alarm",
      "99999",
      rustManager.activeServer?.name || "Rustoria Main (Test)",
      {
        "Trigger Reason": "Manual Diagnostic Test",
        "Alert Level": "CRITICAL RAID PING"
      }
    );
    rustManager.logEvent("diagnostic", "Matrix Raid Ping Test Sent", "Test @room raid alert dispatched to Matrix Raid room.");
    res.json({ success: true, response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/matrix/voice-call/join", async (req, res) => {
  try {
    await matrixClient.joinVoiceCall();
    res.json({ success: true, inVoiceCall: matrixClient.inVoiceCall });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/matrix/voice-call/speak", async (req, res) => {
  const { text, title, voice } = req.body;
  if (!text) {
    return res.status(400).json({ error: "text is required" });
  }
  try {
    const result = await matrixClient.speakVoiceAlert(
      text,
      title || "Tactical Alert",
      voice || "en-US-ChristopherNeural"
    );
    rustManager.logEvent("voice", `Voice Alert Spoken: ${title || "Alert"}`, text, {
      Voice: voice || "en-US-ChristopherNeural",
      Room: "Voice Call Room"
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/matrix/test-chat", async (req, res) => {
  try {
    const response = await matrixClient.sendTeamChat(
      "rustbot-diagnostics",
      "This is a test relay message to the Matrix TeamChat room."
    );
    res.json({ success: true, response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve Static Frontend Assets
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start Server and initialize background services
server.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(` Rust+ Multi-Server Manager running on port ${PORT}`);
  console.log(` WebUI Domain: ${readConfig().webui?.domain || "rust.trylocalhost.com"}`);
  console.log(`=======================================================`);

  // 1. Matrix Bot Login
  try {
    console.log("[Startup] Initializing Matrix bot connection...");
    await matrixClient.login();
    console.log("[Startup] Matrix bot connected and verified.");
  } catch (err) {
    console.warn("[Startup] Matrix bot login deferred/failed:", err.message);
  }

  // 2. Connect Active Rust Server if one exists
  try {
    const servers = readServers();
    const active = servers.find(s => s.isActive);
    if (active) {
      console.log(`[Startup] Auto-connecting to active server: ${active.name}...`);
      await rustManager.connect();
    }
  } catch (err) {
    console.warn("[Startup] RustPlus initial connection failed:", err.message);
  }

  // 3. Start FCM Listener if enabled
  try {
    const cfg = readConfig();
    if (cfg.fcm?.enabled) {
      console.log("[Startup] Auto-starting FCM pairing listener...");
      await fcmService.startListener();
    }
  } catch (err) {
    console.warn("[Startup] FCM auto-start skipped:", err.message);
  }
});
