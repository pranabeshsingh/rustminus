let state = {
  authenticated: false,
  servers: [],
  activeServer: null,
  rustplusStatus: "disconnected",
  serverInfo: null,
  teamInfo: null,
  timeInfo: null,
  markers: [],
  worldEvents: [],
  vendingMachines: [],
  mapData: null,
  mapImage: null,
  mapImageLoaded: false,
  mapScale: 1.0,
  mapOffsetX: 0,
  mapOffsetY: 0,
  vendingFilter: "all",
  vendingSearch: "",
  fcm: { isListening: false },
  matrix: { connected: false },
  recentEvents: [],
  pairingLogs: [],
  wsConnected: false,
  storage: null,
  automation: null,
  telemetry: null,
  clanInfo: null,
  clanChat: [],
  clanArmory: null,
  notes: []
};

let ws = null;
let currentTab = "switches";
let currentTeamSubTab = "active-squad";
let currentChatSubTab = "team-chat";

// ==========================================
// TOAST NOTIFICATIONS
// ==========================================
function showToast(message, type = "info", duration = 4000) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `p-4 rounded-xl shadow-2xl border text-xs font-mono flex items-center gap-3 transition-all duration-300 transform translate-y-2 pointer-events-auto ${
    type === "success" ? "bg-emerald-950/90 border-emerald-700 text-emerald-200" :
    type === "error" ? "bg-red-950/90 border-red-700 text-red-200" :
    type === "warning" ? "bg-amber-950/90 border-amber-700 text-amber-200" :
    "bg-gray-900/90 border-gray-700 text-gray-200"
  }`;

  const icon = type === "success" ? "fa-circle-check text-emerald-400" :
               type === "error" ? "fa-triangle-exclamation text-red-400" :
               type === "warning" ? "fa-bell text-amber-400" : "fa-info-circle text-cyan-400";

  toast.innerHTML = `
    <i class="fa-solid ${icon} text-base flex-shrink-0"></i>
    <div class="flex-1">${message}</div>
  `;

  container.appendChild(toast);
  setTimeout(() => { toast.classList.remove("translate-y-2"); }, 10);
  setTimeout(() => {
    toast.classList.add("opacity-0", "translate-y-2");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ==========================================
// AUTHENTICATION
// ==========================================
async function checkAuth() {
  try {
    const res = await fetch("/api/auth/check");
    const data = await res.json();
    if (data.authenticated) {
      state.authenticated = true;
      document.getElementById("login-view").classList.add("hidden");
      document.getElementById("app-view").classList.remove("hidden");
      initWebSocket();
      fetchStatus();
    } else {
      state.authenticated = false;
      document.getElementById("login-view").classList.remove("hidden");
      document.getElementById("app-view").classList.add("hidden");
    }
  } catch (err) {
    console.error("Auth check failed:", err);
  }
}

document.getElementById("login-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");

  errorEl.classList.add("hidden");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...`;

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      state.authenticated = true;
      document.getElementById("login-view").classList.add("hidden");
      document.getElementById("app-view").classList.remove("hidden");
      showToast("Access Granted. Connected to Sentinel Node.", "success");
      initWebSocket();
      fetchStatus();
    } else {
      errorEl.textContent = data.error || "Authentication failed";
      errorEl.classList.remove("hidden");
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-key"></i> Authenticate & Connect`;
    }
  } catch (err) {
    errorEl.textContent = "Network error connecting to node.";
    errorEl.classList.remove("hidden");
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-key"></i> Authenticate & Connect`;
  }
});

function togglePasswordVisibility() {
  const pwd = document.getElementById("login-password");
  const eye = document.getElementById("pwd-eye");
  if (pwd.type === "password") {
    pwd.type = "text";
    eye.className = "fa-solid fa-eye-slash";
  } else {
    pwd.type = "password";
    eye.className = "fa-solid fa-eye";
  }
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.reload();
}

// ==========================================
// WEBSOCKET REAL-TIME STREAM
// ==========================================
function initWebSocket() {
  if (ws) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    state.wsConnected = true;
    console.log("[WS] Connected to live dashboard stream");
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWebSocketMessage(msg);
    } catch (e) {
      console.error("[WS] Error parsing message:", e);
    }
  };

  ws.onclose = () => {
    state.wsConnected = false;
    ws = null;
    console.log("[WS] Disconnected. Reconnecting in 3s...");
    setTimeout(initWebSocket, 3000);
  };
}

function handleWebSocketMessage(msg) {
  const { type, payload } = msg;

  switch (type) {
    case "init":
      state.rustplusStatus = payload.rustplus?.status || "disconnected";
      state.servers = payload.servers || [];
      state.activeServer = payload.activeServer || null;
      state.serverInfo = payload.serverInfo || null;
      state.teamInfo = payload.teamInfo || null;
      state.timeInfo = payload.timeInfo || null;
      state.clanInfo = payload.clanInfo || null;
      state.clanChat = payload.clanChat || [];
      if (Array.isArray(payload.markers)) {
        state.markers = payload.markers;
        state.worldEvents = payload.markers.filter(m => [2, 4, 5, 6, 8].includes(m.type));
        state.vendingMachines = payload.markers.filter(m => m.type === 3);
      }
      state.fcm = payload.fcm || state.fcm;
      state.matrix = payload.matrix || state.matrix;
      state.recentEvents = payload.recentEvents || [];
      state.pairingLogs = payload.pairingLogs || [];
      renderAll();
      break;

    case "rustplus_status":
      state.rustplusStatus = payload.status;
      if (payload.server) state.activeServer = payload.server;
      updateHeaderBadges();
      renderDevices();
      break;

    case "servers_list":
      state.servers = payload;
      state.activeServer = payload.find(s => s.isActive) || null;
      renderServers();
      renderDevices();
      updateHeaderBadges();
      break;

    case "server_info":
      state.serverInfo = payload;
      renderServerInfo();
      renderTelemetry();
      break;

    case "time_info":
      state.timeInfo = payload;
      renderTimeInfo();
      renderTelemetry();
      break;

    case "team_info":
      state.teamInfo = payload;
      renderTeamInfo();
      redrawMap();
      renderTelemetry();
      break;

    case "clan_info":
      state.clanInfo = payload;
      renderClanMotd();
      renderClanAlumni();
      break;

    case "clan_message":
      appendClanChatMessage(payload);
      break;

    case "markers_data":
      if (payload) {
        state.markers = payload.markers || [];
        state.worldEvents = payload.events || [];
        state.vendingMachines = payload.vendingMachines || [];
        renderMarkers();
        redrawMap();
      }
      break;

    case "map_updated":
      if (payload) {
        state.mapData = payload;
        fetchMapImage();
      }
      break;

    case "entity_state":
      if (state.activeServer) {
        const sw = state.activeServer.switches?.find(s => Number(s.id) === Number(payload.entityId));
        if (sw) sw.state = payload.state;
        const al = state.activeServer.alarms?.find(a => Number(a.id) === Number(payload.entityId));
        if (al) al.state = payload.state;
      }
      renderDevices();
      break;

    case "team_message":
      appendTeamChatMessage(payload);
      break;

    case "map_event":
      renderTelemetry();
      if (payload.marker) {
        showToast(`Map Event: ${payload.typeName} at ${payload.grid}`, "warning");
      }
      refreshMarkers(false);
      break;

    case "base_lockdown":
      handleLockdownState(payload);
      break;

    case "event_log":
      state.recentEvents.unshift(payload);
      if (state.recentEvents.length > 100) state.recentEvents.pop();
      renderSystemLogs();
      if (payload.type === "raid") {
        playRaidSiren();
      }
      break;

    case "pairing_log":
      state.pairingLogs.unshift(payload);
      if (state.pairingLogs.length > 100) state.pairingLogs.pop();
      renderPairingLogs();
      break;

    case "fcm_status":
      state.fcm = { ...state.fcm, ...payload };
      renderFCMStatus();
      break;

    case "server_paired":
      showToast(`🎉 Auto-Paired Server: ${payload.name}`, "success");
      break;

    case "entity_paired":
      showToast(`⚡ Auto-Paired Device: ${payload.name} (ID: ${payload.entityId})`, "success");
      break;
  }
}

// ==========================================
// REST API FETCH & ACTIONS
// ==========================================
async function fetchStatus() {
  try {
    const res = await fetch("/api/status");
    if (res.status === 401) return checkAuth();
    const data = await res.json();
    state.rustplusStatus = data.rustplus?.status || "disconnected";
    state.activeServer = data.activeServer;
    state.serverInfo = data.serverInfo;
    state.teamInfo = data.teamInfo;
    state.timeInfo = data.timeInfo;
    state.fcm = data.fcm;
    state.matrix = data.matrix;

    const srvRes = await fetch("/api/servers");
    const srvData = await srvRes.json();
    state.servers = srvData.servers || [];

    const evtRes = await fetch("/api/events");
    const evtData = await evtRes.json();
    state.recentEvents = evtData.events || [];

    const fcmLogsRes = await fetch("/api/fcm/logs");
    const fcmLogsData = await fcmLogsRes.json();
    state.pairingLogs = fcmLogsData.logs || [];

    // Fetch Map Markers & Vending
    try {
      const markersRes = await fetch("/api/markers");
      if (markersRes.ok) {
        const markersData = await markersRes.json();
        state.markers = markersData.markers || [];
        state.worldEvents = markersData.events || [];
        state.vendingMachines = markersData.vendingMachines || [];
      }
    } catch (e) {}

    // Fetch Map Metadata & Image
    try {
      const mapRes = await fetch("/api/map");
      if (mapRes.ok) {
        const mapData = await mapRes.json();
        state.mapData = mapData.map;
        fetchMapImage();
      }
    } catch (e) {}

    renderAll();
  } catch (err) {
    console.error("Failed to fetch status:", err);
  }
}

// ==========================================
// RENDERERS
// ==========================================
function renderAll() {
  updateHeaderBadges();
  renderDevices();
  renderServers();
  renderFCMStatus();
  renderPairingLogs();
  renderServerInfo();
  renderTimeInfo();
  renderTeamInfo();
  renderMarkers();
  renderTelemetry();
  renderSystemLogs();
  loadStorageAndUpkeepData();
  loadAutomationData();
  loadTeamTelemetryData();
  loadClanArmory(false);
  refreshClanInfo(false);
  loadClanChat();
  loadNotesData();
}

function updateHeaderBadges() {
  const nameEl = document.getElementById("header-active-server-name");
  const dotEl = document.getElementById("header-rust-status-dot");
  const matrixEl = document.getElementById("header-matrix-status");
  const fcmEl = document.getElementById("header-fcm-status");
  const serverCountEl = document.getElementById("badge-server-count");

  if (nameEl) nameEl.textContent = state.activeServer?.name || "None Selected";
  if (serverCountEl) serverCountEl.textContent = state.servers.length;

  if (dotEl) {
    if (state.rustplusStatus === "connected") {
      dotEl.className = "w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500";
    } else if (state.rustplusStatus === "connecting") {
      dotEl.className = "w-2.5 h-2.5 rounded-full bg-yellow-500 animate-pulse";
    } else {
      dotEl.className = "w-2.5 h-2.5 rounded-full bg-red-500";
    }
  }

  if (matrixEl) {
    matrixEl.textContent = state.matrix.connected ? "Connected" : "Reconnecting";
    matrixEl.className = state.matrix.connected ? "text-emerald-400 font-bold" : "text-yellow-400 font-bold";
  }

  if (fcmEl) {
    fcmEl.textContent = state.fcm.isListening ? "Listening" : "Idle";
    fcmEl.className = state.fcm.isListening ? "text-emerald-400 font-bold" : "text-yellow-400 font-bold";
  }
}

function renderDevices() {
  const grid = document.getElementById("devices-grid");
  const alarmsGrid = document.getElementById("alarms-grid");
  const warning = document.getElementById("no-server-warning");

  if (!state.activeServer) {
    if (warning) warning.classList.remove("hidden");
    if (grid) grid.innerHTML = `<div class="col-span-full text-center py-10 text-gray-500 font-mono text-xs">No active server. Please activate or pair a server first.</div>`;
    if (alarmsGrid) alarmsGrid.innerHTML = `<div class="col-span-full text-center py-6 text-gray-500 font-mono text-xs">No alarms paired.</div>`;
    return;
  }

  if (warning) warning.classList.add("hidden");

  // Render Switches
  const switches = state.activeServer.switches || [];
  if (grid) {
    if (switches.length === 0) {
      grid.innerHTML = `
        <div class="col-span-full bg-[#0d121c] border border-dashed border-[#20293a] rounded-xl p-8 text-center space-y-3">
          <i class="fa-solid fa-toggle-off text-3xl text-gray-600"></i>
          <p class="font-rust uppercase text-sm font-bold text-gray-300">No Smart Switches Configured</p>
          <p class="text-xs font-mono text-gray-500 max-w-sm mx-auto">Use the In-Game Pairing suite to pair switches automatically, or click "Add Device" above.</p>
        </div>
      `;
    } else {
      grid.innerHTML = switches.map(sw => {
        const isOn = !!sw.state;
        const iconClass = sw.category === "Turrets" ? "fa-shield-virus" :
                          sw.category === "SAMs" ? "fa-jet-fighter" :
                          sw.category === "Lights" ? "fa-lightbulb" :
                          sw.category === "Doors" ? "fa-door-open" : "fa-bolt";

        const categoryBadge = sw.category === "Turrets" ? "bg-red-950 text-red-400 border-red-800" :
                              sw.category === "SAMs" ? "bg-amber-950 text-amber-400 border-amber-800" :
                              sw.category === "Lights" ? "bg-yellow-950 text-yellow-400 border-yellow-800" :
                              sw.category === "Doors" ? "bg-cyan-950 text-cyan-400 border-cyan-800" :
                              "bg-gray-800 text-gray-400 border-gray-700";

        return `
          <div class="bg-[#121722] border ${isOn ? "border-rust-600/70 shadow-lg shadow-rust-950/40" : "border-[#20293a]"} rounded-xl p-5 transition duration-200 relative group overflow-hidden">
            <div class="flex items-start justify-between gap-3 mb-4">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-lg ${isOn ? "bg-rust-600 text-white" : "bg-[#0b0e14] text-gray-500"} flex items-center justify-center text-lg transition duration-200">
                  <i class="fa-solid ${iconClass}"></i>
                </div>
                <div>
                  <h4 class="font-rust font-bold text-base text-white truncate max-w-[150px]" title="${sw.name}">${sw.name}</h4>
                  <span class="text-[10px] font-mono border px-1.5 py-0.5 rounded ${categoryBadge}">${sw.category || "Switch"}</span>
                </div>
              </div>
              <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                <button onclick="openAutomationModal('${sw.id}', '${encodeURIComponent(sw.name || sw.id)}')" title="Smart Rules & Timers" class="text-gray-400 hover:text-cyan-300 transition text-xs p-1">
                  <i class="fa-solid fa-gear"></i>
                </button>
                <button onclick="deleteEntity('${sw.id}')" title="Delete Device" class="text-gray-500 hover:text-red-400 transition text-xs p-1">
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
            </div>

            <div class="flex items-center justify-between pt-2 border-t border-[#1a2233]">
              <div class="font-mono text-[11px] text-gray-400">
                <span>ID: <code class="text-gray-300 font-bold">${sw.id}</code></span>
              </div>
              
              <!-- Interactive Switch -->
              <button onclick="toggleSwitch('${sw.id}', ${!isOn})" class="relative inline-flex h-7 w-14 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent ${isOn ? "bg-rust-600" : "bg-gray-800"} transition-colors duration-200 ease-in-out focus:outline-none">
                <span class="${isOn ? "translate-x-7 bg-white" : "translate-x-0 bg-gray-400"} pointer-events-none inline-block h-6 w-6 transform rounded-full shadow ring-0 transition duration-200 ease-in-out"></span>
              </button>
            </div>
          </div>
        `;
      }).join("");
    }
  }

  // Render Alarms
  const alarms = state.activeServer.alarms || [];
  if (alarmsGrid) {
    if (alarms.length === 0) {
      alarmsGrid.innerHTML = `<div class="col-span-full text-center py-6 text-gray-500 font-mono text-xs">No Smart Alarms configured for this base.</div>`;
    } else {
      alarmsGrid.innerHTML = alarms.map(al => {
        const isTriggered = !!al.state;
        return `
          <div class="bg-[#0e131d] border ${isTriggered ? "border-red-600 bg-red-950/30 animate-pulse" : "border-[#1e2638]"} rounded-xl p-4 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-lg ${isTriggered ? "bg-red-600 text-white" : "bg-gray-800 text-gray-400"} flex items-center justify-center">
                <i class="fa-solid fa-bell"></i>
              </div>
              <div>
                <h5 class="font-rust font-bold text-sm text-white">${al.name}</h5>
                <span class="text-[10px] font-mono text-gray-400">ID: ${al.id} | ${isTriggered ? "<b class='text-red-400'>TRIGGERED</b>" : "Armed"}</span>
              </div>
            </div>
            <button onclick="deleteEntity('${al.id}')" class="text-gray-500 hover:text-red-400 text-xs">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        `;
      }).join("");
    }
  }
}

function renderServers() {
  const grid = document.getElementById("servers-grid");
  if (!grid) return;

  if (state.servers.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full bg-[#121722] border border-dashed border-[#20293a] rounded-xl p-10 text-center space-y-3">
        <i class="fa-solid fa-server text-4xl text-gray-600"></i>
        <p class="font-rust uppercase text-lg font-bold text-white">No Server Profiles Configured</p>
        <p class="text-xs font-mono text-gray-400 max-w-md mx-auto">Click "Add Server Profile" to manually register a Rust server, or use the In-Game Pairing suite.</p>
        <button onclick="openAddServerModal()" class="mt-3 bg-rust-600 hover:bg-rust-500 text-white font-rust uppercase font-bold text-xs px-4 py-2 rounded-lg">
          Add First Server
        </button>
      </div>
    `;
    return;
  }

  grid.innerHTML = state.servers.map(s => {
    const isActive = !!s.isActive;
    const isConn = isActive && state.rustplusStatus === "connected";

    return `
      <div class="bg-[#121722] border ${isActive ? "border-rust-500/80 shadow-xl shadow-rust-950/50" : "border-[#20293a]"} rounded-xl p-5 space-y-4 relative">
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="flex items-center gap-2">
              <h3 class="font-rust font-bold text-lg text-white">${s.name}</h3>
              ${isActive ? `<span class="bg-rust-950 text-rust-400 border border-rust-700 text-[10px] font-mono px-2 py-0.5 rounded font-bold uppercase">Active</span>` : ""}
            </div>
            <p class="text-xs font-mono text-gray-400">${s.ip}:${s.port}</p>
          </div>
          <div class="flex items-center gap-1">
            <button onclick="editServer('${s.id}')" class="text-gray-400 hover:text-white p-1.5 rounded hover:bg-[#1a2233] text-xs"><i class="fa-solid fa-pen"></i></button>
            <button onclick="deleteServer('${s.id}')" class="text-gray-400 hover:text-red-400 p-1.5 rounded hover:bg-[#1a2233] text-xs"><i class="fa-solid fa-trash"></i></button>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2 text-[11px] font-mono bg-[#0b0e14] p-3 rounded-lg border border-[#1a2233]">
          <div><span class="text-gray-500">SteamID:</span> <span class="text-gray-300 truncate block">${s.playerId}</span></div>
          <div><span class="text-gray-500">Token:</span> <span class="text-gray-300 block">${s.playerToken ? "••••••••" : "None"}</span></div>
          <div><span class="text-gray-500">Switches:</span> <span class="text-gray-300">${s.switches?.length || 0}</span></div>
          <div><span class="text-gray-500">Alarms:</span> <span class="text-gray-300">${s.alarms?.length || 0}</span></div>
        </div>

        <div class="flex items-center justify-between pt-2">
          <div class="flex items-center gap-2 text-xs font-mono">
            <span class="w-2 h-2 rounded-full ${isConn ? "bg-emerald-500" : (isActive ? "bg-yellow-500" : "bg-gray-600")}"></span>
            <span class="${isConn ? "text-emerald-400" : "text-gray-400"}">${isConn ? "Connected" : (isActive ? "Connecting..." : "Standby")}</span>
          </div>

          ${isActive ? `
            <button onclick="disconnectServer('${s.id}')" class="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-rust uppercase font-bold px-3 py-1.5 rounded-lg border border-gray-700">
              Disconnect
            </button>
          ` : `
            <button onclick="activateServer('${s.id}')" class="bg-rust-700 hover:bg-rust-600 text-white text-xs font-rust uppercase font-bold px-4 py-1.5 rounded-lg shadow">
              Switch & Connect
            </button>
          `}
        </div>
      </div>
    `;
  }).join("");
}

function renderFCMStatus() {
  const isListening = !!state.fcm.isListening;
  const toggleBtn = document.getElementById("fcm-toggle-btn");
  const toggleKnob = document.getElementById("fcm-toggle-knob");
  const toggleText = document.getElementById("fcm-toggle-status-text");

  if (toggleBtn && toggleKnob && toggleText) {
    if (isListening) {
      toggleBtn.className = "relative inline-flex h-8 w-16 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent bg-emerald-600 transition-colors duration-200 ease-in-out focus:outline-none pulse-green";
      toggleKnob.className = "translate-x-8 pointer-events-none inline-block h-7 w-7 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out";
      toggleText.textContent = "LISTENING (ACTIVE)";
      toggleText.className = "font-bold text-emerald-400";
    } else {
      toggleBtn.className = "relative inline-flex h-8 w-16 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent bg-gray-700 transition-colors duration-200 ease-in-out focus:outline-none";
      toggleKnob.className = "translate-x-0 pointer-events-none inline-block h-7 w-7 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out";
      toggleText.textContent = "STOPPED";
      toggleText.className = "font-bold text-yellow-400";
    }
  }

  // Populate Expo token & Companion link status
  const expoInput = document.getElementById("fcm-expo-token-display");
  if (expoInput) {
    expoInput.value = state.fcm.expoPushToken || "No Token Generated";
  }

  const badge = document.getElementById("fcm-companion-link-badge");
  if (badge) {
    if (state.fcm.hasCompanionToken) {
      badge.textContent = "Linked & Registered";
      badge.className = "text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-800";
    } else {
      badge.textContent = "Pending Link";
      badge.className = "text-[10px] font-mono px-2 py-0.5 rounded bg-yellow-950/80 text-yellow-400 border border-yellow-800";
    }
  }
}

function copyExpoToken() {
  const el = document.getElementById("fcm-expo-token-display");
  if (!el || !el.value) return;
  navigator.clipboard.writeText(el.value).then(() => {
    showToast("Expo Push Token copied to clipboard!", "success");
  }).catch(() => {
    el.select();
    document.execCommand("copy");
    showToast("Expo Push Token copied!", "success");
  });
}

async function saveCompanionAuthToken() {
  const input = document.getElementById("fcm-auth-token-input");
  if (!input || !input.value.trim()) {
    showToast("Please enter a valid Companion AuthToken", "error");
    return;
  }

  const token = input.value.trim();
  try {
    showToast("Registering Companion Auth Token with Facepunch...", "info");
    const res = await fetch("/api/fcm/save-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authToken: token })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to link Companion token");
    
    showToast("🎉 Steam Account linked with Facepunch Companion!", "success");
    state.fcm.hasCompanionToken = true;
    input.value = "";
    renderFCMStatus();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function renderPairingLogs() {
  const container = document.getElementById("pairing-logs-stream");
  if (!container) return;

  if (state.pairingLogs.length === 0) {
    container.innerHTML = `<p class="text-gray-600 italic">Waiting for incoming pairing notifications from Facepunch FCM...</p>`;
    return;
  }

  container.innerHTML = state.pairingLogs.map(log => {
    const timeStr = new Date(log.timestamp).toLocaleTimeString();
    const typeColor = log.type === "server" ? "text-emerald-400 border-emerald-800 bg-emerald-950/40" :
                      log.type === "entity" ? "text-cyan-400 border-cyan-800 bg-cyan-950/40" :
                      log.type === "alarm" ? "text-red-400 border-red-800 bg-red-950/40" :
                      "text-gray-300 border-gray-800 bg-gray-900/40";

    return `
      <div class="p-2.5 rounded-lg border ${typeColor} space-y-1">
        <div class="flex items-center justify-between text-[10px] text-gray-400">
          <span class="uppercase font-bold tracking-wider">[${log.type}]</span>
          <span>${timeStr}</span>
        </div>
        <div class="font-bold text-white text-xs">${log.message}</div>
      </div>
    `;
  }).join("");
}

// ==========================================
// 1. SERVER INFO (getInfo)
// ==========================================
function renderServerInfo() {
  const info = state.serverInfo;
  if (!info) return;

  const bannerBg = document.getElementById("server-banner-bg");
  if (bannerBg && info.headerImage) {
    bannerBg.style.backgroundImage = `url('${info.headerImage}')`;
  }

  const logoImg = document.getElementById("server-logo-img");
  if (logoImg) {
    if (info.logoImage) {
      logoImg.src = info.logoImage;
      logoImg.classList.remove("hidden");
    } else {
      logoImg.src = "https://files.facepunch.com/Rohan/2020/November/04_07-48-MagnificentLadybug.png";
    }
  }

  const nameEl = document.getElementById("server-name-display");
  if (nameEl) nameEl.textContent = info.name || "Rust Server";

  const addrEl = document.getElementById("server-address-display");
  if (addrEl) {
    const srv = state.activeServer;
    addrEl.textContent = srv ? `${srv.ip}:${srv.port} | Steam ID: ${srv.playerId}` : "No active server";
  }

  const webLink = document.getElementById("server-website-link");
  if (webLink && info.url) {
    webLink.href = info.url.startsWith("http") ? info.url : `http://${info.url}`;
  }

  // Players & Capacity
  const playersEl = document.getElementById("stat-players");
  if (playersEl) {
    playersEl.textContent = `${info.players || 0} / ${info.maxPlayers || 0}`;
  }
  const playersBar = document.getElementById("stat-players-bar");
  if (playersBar) {
    const pct = info.maxPlayers ? Math.min(100, Math.round(((info.players || 0) / info.maxPlayers) * 100)) : 0;
    playersBar.style.width = `${pct}%`;
  }
  const queueBadge = document.getElementById("stat-queue-badge");
  if (queueBadge) {
    queueBadge.textContent = `Queue: ${info.queuedPlayers || 0}`;
  }

  // Map
  const mapNameEl = document.getElementById("stat-map-name");
  if (mapNameEl) mapNameEl.textContent = info.map || "Procedural Map";

  const mapSizeEl = document.getElementById("stat-map-size");
  if (mapSizeEl) mapSizeEl.textContent = `Size: ${info.mapSize || 0}m`;

  // Seed & Salt
  const seedEl = document.getElementById("stat-seed");
  if (seedEl) seedEl.textContent = info.seed !== undefined ? String(info.seed) : "Procedural";

  const saltEl = document.getElementById("stat-salt");
  if (saltEl) saltEl.textContent = `Salt: ${info.salt || 0}`;

  // Wipe time
  const wipeRelEl = document.getElementById("stat-wipe-relative");
  const wipeDateEl = document.getElementById("stat-wipe-date");
  if (wipeRelEl && info.wipeTime) {
    const wipeDate = new Date(info.wipeTime * 1000);
    const now = Date.now();
    const diffHours = Math.floor((now - wipeDate.getTime()) / (1000 * 3600));
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays > 0) {
      wipeRelEl.textContent = `Wiped ${diffDays}d ${diffHours % 24}h ago`;
    } else if (diffHours > 0) {
      wipeRelEl.textContent = `Wiped ${diffHours}h ago`;
    } else {
      wipeRelEl.textContent = "Wiped just now";
    }
    if (wipeDateEl) {
      wipeDateEl.textContent = wipeDate.toLocaleDateString(undefined, {
        month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit"
      });
    }
  }
}

async function refreshServerInfo(userInitiated = false) {
  const btn = document.getElementById("btn-refresh-info");
  if (btn && userInitiated) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Refreshing...`;
  }
  try {
    const res = await fetch("/api/info/refresh", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to refresh server info");
    state.serverInfo = data.info;
    renderServerInfo();
    renderTelemetry();
    if (userInitiated) showToast("Server info updated (getInfo)", "success");
  } catch (err) {
    if (userInitiated) showToast(err.message, "error");
  } finally {
    if (btn && userInitiated) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> Refresh getInfo`;
    }
  }
}

// ==========================================
// 2. IN-GAME TIME (getTime)
// ==========================================
function renderTimeInfo() {
  const t = state.timeInfo;
  if (!t) return;

  const floatTime = t.time || 0;
  const hours = Math.floor(floatTime);
  const minutes = Math.floor((floatTime - hours) * 60);
  const timeStr = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;

  const gameTimeEl = document.getElementById("stat-game-time");
  if (gameTimeEl) gameTimeEl.textContent = timeStr;

  const sunriseFloat = t.sunrise || 7.5;
  const sunsetFloat = t.sunset || 20.0;
  const isDay = (floatTime >= sunriseFloat && floatTime < sunsetFloat);

  const formatHours = (val) => {
    const h = Math.floor(val);
    const m = Math.floor((val - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };

  const sunriseEl = document.getElementById("time-sunrise-val");
  if (sunriseEl) sunriseEl.textContent = formatHours(sunriseFloat);

  const sunsetEl = document.getElementById("time-sunset-val");
  if (sunsetEl) sunsetEl.textContent = formatHours(sunsetFloat);

  const dayLengthEl = document.getElementById("time-daylength-val");
  if (dayLengthEl) dayLengthEl.textContent = `${Math.round(t.dayLengthMinutes || 80)} mins`;

  const timeScaleEl = document.getElementById("time-timescale-val");
  if (timeScaleEl) timeScaleEl.textContent = `${(t.timeScale || 1).toFixed(1)}x`;

  const statusPill = document.getElementById("time-status-pill");
  const iconEl = document.getElementById("time-celestial-icon");
  const countDesc = document.getElementById("time-countdown-desc");
  const cyclePercent = document.getElementById("time-cycle-percent");
  const cycleBar = document.getElementById("time-cycle-bar");

  if (isDay) {
    if (statusPill) {
      statusPill.className = "bg-amber-950/80 text-amber-300 border border-amber-700 px-2.5 py-0.5 rounded text-xs font-mono font-bold";
      statusPill.textContent = "☀️ DAYLIGHT";
    }
    if (iconEl) {
      iconEl.className = "text-4xl text-amber-400";
      iconEl.innerHTML = `<i class="fa-solid fa-sun animate-spin" style="animation-duration: 20s;"></i>`;
    }
    const dayProgress = (floatTime - sunriseFloat) / (sunsetFloat - sunriseFloat);
    const pct = Math.max(0, Math.min(100, Math.round(dayProgress * 100)));
    if (cyclePercent) cyclePercent.textContent = `${pct}% Daylight`;
    if (cycleBar) {
      cycleBar.className = "bg-gradient-to-r from-amber-500 via-yellow-400 to-orange-500 h-full rounded-full transition-all duration-500";
      cycleBar.style.width = `${pct}%`;
    }
    const minsUntilSunset = Math.round(((sunsetFloat - floatTime) / 24) * (t.dayLengthMinutes || 80));
    if (countDesc) countDesc.textContent = `Sunset in ~${Math.max(1, minsUntilSunset)} real mins`;
  } else {
    if (statusPill) {
      statusPill.className = "bg-indigo-950/80 text-indigo-300 border border-indigo-700 px-2.5 py-0.5 rounded text-xs font-mono font-bold";
      statusPill.textContent = "🌙 NIGHT";
    }
    if (iconEl) {
      iconEl.className = "text-4xl text-indigo-400";
      iconEl.innerHTML = `<i class="fa-solid fa-moon"></i>`;
    }
    if (cyclePercent) cyclePercent.textContent = "Night Time";
    if (cycleBar) {
      cycleBar.className = "bg-gradient-to-r from-indigo-900 via-indigo-600 to-blue-500 h-full rounded-full transition-all duration-500";
      cycleBar.style.width = "100%";
    }
    let nightHoursLeft = (floatTime < sunriseFloat) ? (sunriseFloat - floatTime) : (24 - floatTime + sunriseFloat);
    const minsUntilSunrise = Math.round((nightHoursLeft / 24) * (t.dayLengthMinutes || 80));
    if (countDesc) countDesc.textContent = `Sunrise in ~${Math.max(1, minsUntilSunrise)} real mins`;
  }

  const alertBadge = document.getElementById("time-alerts-badge");
  if (alertBadge) {
    alertBadge.innerHTML = `<i class="fa-solid fa-bell text-amber-400"></i> 5m / 2m Alerts Active`;
  }
}

async function refreshTimeInfo(userInitiated = false) {
  const btn = document.getElementById("btn-refresh-time");
  if (btn && userInitiated) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Refreshing...`;
  }
  try {
    const res = await fetch("/api/time/refresh", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to refresh time");
    state.timeInfo = data.time;
    renderTimeInfo();
    renderTelemetry();
    if (userInitiated) showToast("In-game time updated (getTime)", "success");
  } catch (err) {
    if (userInitiated) showToast(err.message, "error");
  } finally {
    if (btn && userInitiated) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> Refresh getTime`;
    }
  }
}

// ==========================================
// 3. TEAM ROSTER & COORDINATES (getTeamInfo)
// ==========================================
function renderTeamInfo() {
  const team = state.teamInfo;
  const members = team?.members || [];
  const leaderId = team?.leaderSteamId ? String(team.leaderSteamId) : null;
  const mapSize = state.serverInfo?.mapSize || 4500;

  const sizeBadge = document.getElementById("team-size-badge");
  if (sizeBadge) sizeBadge.textContent = `${members.length} Active`;

  const subtabActive = document.getElementById("subtab-active-count");
  if (subtabActive) subtabActive.textContent = members.length;

  let onlineCount = 0;
  let aliveCount = 0;
  let sleepCount = 0;
  let deadCount = 0;
  let leaderName = "None";

  for (const m of members) {
    if (String(m.steamId) === leaderId) leaderName = m.name || m.steamId;
    if (m.isOnline) onlineCount++;
    if (m.isAlive) {
      aliveCount++;
      if (!m.isOnline) sleepCount++;
    } else {
      deadCount++;
    }
  }

  const leaderEl = document.getElementById("team-leader-name");
  if (leaderEl) leaderEl.textContent = leaderName;

  const onlineEl = document.getElementById("team-online-count");
  if (onlineEl) onlineEl.textContent = onlineCount;

  const aliveEl = document.getElementById("team-alive-count");
  if (aliveEl) aliveEl.textContent = aliveCount;

  const sleepEl = document.getElementById("team-sleep-count");
  if (sleepEl) sleepEl.textContent = sleepCount;

  const deadEl = document.getElementById("team-dead-count");
  if (deadEl) deadEl.textContent = deadCount;

  const gridContainer = document.getElementById("team-members-grid");
  if (!gridContainer) return;

  if (members.length === 0) {
    gridContainer.innerHTML = `<div class="p-6 text-center text-gray-500 font-mono text-xs col-span-full">No team members data found. Click Refresh getTeamInfo.</div>`;
    return;
  }

  gridContainer.innerHTML = members.map(m => {
    const isLeader = String(m.steamId) === leaderId;
    const grid = (m.x !== undefined && m.y !== undefined) ? calculateGridPos(m.x, m.y, mapSize) : "Unknown";
    
    const afkInfo = state.telemetry?.afk ? state.telemetry.afk[String(m.steamId)] : null;
    let statusClass = "bg-red-950/80 text-red-300 border-red-800";
    let statusLabel = "💀 DEAD";
    if (m.isAlive) {
      if (m.isOnline) {
        if (afkInfo && afkInfo.isAfk) {
          statusClass = "bg-amber-950/80 text-amber-300 border-amber-700";
          statusLabel = `💤 AFK (${afkInfo.idleDurationFormatted || '5m+'})`;
        } else {
          statusClass = "bg-emerald-950/80 text-emerald-300 border-emerald-700";
          statusLabel = "🟢 ALIVE";
        }
      } else {
        statusClass = "bg-amber-950/80 text-amber-300 border-amber-700";
        statusLabel = "💤 SLEEPING";
      }
    }

    const initials = (m.name || "T").slice(0, 2).toUpperCase();

    return `
      <div class="bg-[#0b0e14] border ${isLeader ? 'border-amber-500/60' : 'border-[#1e2638]'} rounded-xl p-4 flex flex-col justify-between gap-3 relative shadow-md">
        ${isLeader ? `<span class="absolute top-2 right-2 text-amber-400 text-xs font-mono font-bold bg-amber-950/60 border border-amber-700/80 px-2 py-0.5 rounded-full">👑 Leader</span>` : ""}
        
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-rust-900/60 border border-rust-500/60 flex items-center justify-center font-rust font-bold text-white text-sm">
            ${initials}
          </div>
          <div class="min-w-0 flex-1">
            <h4 class="font-rust font-bold text-base text-white truncate">${m.name || "Teammate"}</h4>
            <div class="flex items-center gap-2 text-[11px] font-mono text-gray-400">
              <span class="truncate">ID: ${m.steamId}</span>
              <a href="https://steamcommunity.com/profiles/${m.steamId}" target="_blank" class="text-rust-400 hover:text-rust-300" title="Open Steam Profile">
                <i class="fa-solid fa-arrow-up-right-from-square"></i>
              </a>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2 text-[11px] font-mono pt-2 border-t border-[#182133]">
          <div>
            <span class="text-gray-500">Status:</span>
            <span class="inline-block border px-1.5 py-0.2 rounded ${statusClass} text-[10px] font-bold ml-1">${statusLabel}</span>
          </div>
          <div>
            <span class="text-gray-500">Sector:</span>
            <span class="text-cyan-400 font-bold ml-1">${grid}</span>
          </div>
          <div class="col-span-2 text-gray-400 text-[10px] flex items-center justify-between">
            <span>Coords: X: ${Math.round(m.x || 0)}, Y: ${Math.round(m.y || 0)}</span>
            <button onclick="focusPlayerOnMap(${m.x || 0}, ${m.y || 0})" class="text-cyan-400 hover:text-cyan-300 text-[10px] flex items-center gap-1 font-bold">
              <i class="fa-solid fa-location-dot"></i> Pin Map
            </button>
          </div>
        </div>

        <div class="pt-1 flex justify-end">
          ${!isLeader ? `
            <button onclick="promoteTeammate('${m.steamId}', '${encodeURIComponent(m.name || m.steamId)}')" class="bg-[#141b29] hover:bg-amber-950/60 text-gray-300 hover:text-amber-300 border border-[#222e44] hover:border-amber-700 px-2.5 py-1 rounded text-[11px] font-mono transition flex items-center gap-1">
              <i class="fa-solid fa-crown text-amber-400"></i> Promote Leader
            </button>
          ` : `
            <span class="text-[11px] font-mono text-amber-400 italic">Current Team Leader</span>
          `}
        </div>
      </div>
    `;
  }).join("");

  renderClanAlumni();
}

async function refreshTeamInfo(userInitiated = false) {
  const btn = document.getElementById("btn-refresh-team");
  if (btn && userInitiated) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Refreshing...`;
  }
  try {
    const res = await fetch("/api/team/refresh", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to refresh team");
    state.teamInfo = data.teamInfo;
    renderTeamInfo();
    redrawMap();
    renderTelemetry();
    if (userInitiated) showToast("Team roster updated (getTeamInfo)", "success");
  } catch (err) {
    if (userInitiated) showToast(err.message, "error");
  } finally {
    if (btn && userInitiated) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> Refresh getTeamInfo`;
    }
  }
}

async function promoteTeammate(steamId, encodedName) {
  const name = decodeURIComponent(encodedName || steamId);
  if (!confirm(`Are you sure you want to promote ${name} (${steamId}) to Team Leader?`)) return;

  try {
    showToast(`Promoting ${name} to Team Leader...`, "info");
    const res = await fetch("/api/team/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steamId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to promote to leader");
    showToast(`👑 Promoted ${name} to Team Leader!`, "success");
    refreshTeamInfo(false);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ==========================================
// CLAN HUB, ALUMNI & ARMORY FUNCTIONS
// ==========================================
function switchTeamSubTab(tab) {
  currentTeamSubTab = tab;
  const tabs = ["active-squad", "clan-alumni", "clan-armory", "clan-multitc"];

  tabs.forEach(t => {
    const el = document.getElementById(`team-subtab-${t}`);
    const btn = document.getElementById(`subtab-btn-${t}`);
    if (el) el.classList.toggle("hidden", t !== tab);
    if (btn) {
      if (t === tab) {
        btn.className = "team-subtab-btn px-3 py-1.5 rounded-lg text-xs font-rust uppercase font-bold tracking-wider transition bg-emerald-700/80 text-white border border-emerald-500 flex items-center gap-1.5 shadow";
      } else {
        btn.className = "team-subtab-btn px-3 py-1.5 rounded-lg text-xs font-rust uppercase font-bold tracking-wider transition bg-[#141b29] text-gray-400 hover:text-white border border-[#222e44] flex items-center gap-1.5";
      }
    }
  });

  if (tab === "clan-alumni") {
    renderClanAlumni();
  } else if (tab === "clan-armory" || tab === "clan-multitc") {
    loadClanArmory(false);
  }
}

function switchChatSubTab(tab) {
  currentChatSubTab = tab;
  const tabs = [
    { id: "team-chat", container: "chat-stream-team-container", btn: "chat-subtab-btn-team" },
    { id: "clan-chat", container: "chat-stream-clan-container", btn: "chat-subtab-btn-clan" },
    { id: "clan-motd", container: "chat-stream-motd-container", btn: "chat-subtab-btn-motd" }
  ];

  tabs.forEach(t => {
    const el = document.getElementById(t.container);
    const btn = document.getElementById(t.btn);
    if (el) el.classList.toggle("hidden", t.id !== tab);
    if (btn) {
      if (t.id === tab) {
        btn.className = "px-3 py-1 rounded-lg text-xs font-rust uppercase font-bold tracking-wider transition bg-emerald-700/80 text-white border border-emerald-500 flex items-center gap-1.5 shadow";
      } else {
        btn.className = "px-3 py-1 rounded-lg text-xs font-rust uppercase font-bold tracking-wider transition bg-[#141b29] text-gray-400 hover:text-white border border-[#222e44] flex items-center gap-1.5";
      }
    }
  });

  if (tab === "clan-chat") {
    loadClanChat();
  } else if (tab === "clan-motd") {
    renderClanMotd();
  }
}

async function loadClanChat() {
  try {
    const res = await fetch("/api/clan/chat");
    if (!res.ok) return;
    const data = await res.json();
    const stream = document.getElementById("clan-chat-stream");
    if (stream && Array.isArray(data.messages) && data.messages.length > 0) {
      stream.innerHTML = "";
      for (const m of data.messages) {
        appendClanChatMessage(m);
      }
    }
  } catch (e) {}
}

function filterClanAlumni() {
  renderClanAlumni();
}

function renderClanAlumni() {
  const container = document.getElementById("clan-alumni-grid");
  const countBadge = document.getElementById("subtab-alumni-count");
  const totalBadge = document.getElementById("clan-total-badge");
  if (!container) return;

  const searchInput = document.getElementById("clan-alumni-search");
  const sortSelect = document.getElementById("clan-alumni-sort");
  const query = (searchInput?.value || "").toLowerCase().trim();
  const sortBy = sortSelect?.value || "lastSeen";

  // Historical members come from state.telemetry?.historicalMembers
  let list = Array.isArray(state.telemetry?.historicalMembers) ? [...state.telemetry.historicalMembers] : [];

  if (countBadge) countBadge.textContent = list.length;
  if (totalBadge) {
    const activeLen = state.teamInfo?.members?.length || 0;
    const total = activeLen + list.length;
    totalBadge.textContent = `${total} Clanmates`;
  }

  // Filter
  if (query) {
    list = list.filter(m => 
      (m.name && m.name.toLowerCase().includes(query)) ||
      (m.steamId && String(m.steamId).includes(query)) ||
      (m.lastGrid && m.lastGrid.toLowerCase().includes(query))
    );
  }

  // Squad Filter
  if (state.squadFilter) {
    list = list.filter(m => (m.squad || "Unassigned").toLowerCase() === state.squadFilter.toLowerCase());
  }

  // Sort
  list.sort((a, b) => {
    if (sortBy === "playtime") return (b.playTimeSec || 0) - (a.playTimeSec || 0);
    if (sortBy === "deaths") return (b.totalDeaths || 0) - (a.totalDeaths || 0);
    if (sortBy === "distance") return (b.distanceMeters || 0) - (a.distanceMeters || 0);
    return (b.lastSeenTime || 0) - (a.lastSeenTime || 0);
  });

  if (list.length === 0) {
    container.innerHTML = `<div class="p-6 text-center text-gray-500 font-mono text-xs col-span-full">No clanmates matching filter.</div>`;
    return;
  }

  container.innerHTML = list.map(m => {
    const initials = (m.name || "C").slice(0, 2).toUpperCase();
    const roleBadge = m.clanRole !== null && m.clanRole !== undefined ? `<span class="text-[9px] bg-[#141b29] text-amber-400 border border-[#222e44] px-1 py-0.5 rounded">Rank ${m.clanRole}</span>` : "";
    const squadTag = m.squad || "Unassigned";

    return `
      <div class="bg-[#0b0e14] border border-[#1e2638] rounded-xl p-3.5 flex flex-col justify-between gap-2.5 font-mono text-xs shadow-md">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-full bg-rust-950 border border-rust-800 flex items-center justify-center font-rust font-bold text-white text-xs">
            ${initials}
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-1">
              <h5 class="font-rust font-bold text-sm text-white truncate">${m.name || m.steamId}</h5>
              ${roleBadge}
            </div>
            <div class="flex items-center gap-1.5 text-[10px] text-gray-400">
              <span class="truncate">ID: ${m.steamId}</span>
              <a href="https://steamcommunity.com/profiles/${m.steamId}" target="_blank" class="text-rust-400 hover:text-rust-300" title="View Steam Profile">
                <i class="fa-solid fa-arrow-up-right-from-square"></i>
              </a>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-1.5 text-[11px] pt-2 border-t border-[#182133] text-gray-400">
          <div>Last Seen: <b class="text-white">${m.lastSeenFormatted || "Earlier"}</b></div>
          <div>Last Sector: <b class="text-cyan-400">${m.lastGrid || "--"}</b></div>
          <div>Playtime: <b class="text-emerald-400">${m.playTimeFormatted || "0s"}</b></div>
          <div>AFK Standstill: <b class="text-amber-400">${m.afkTimeFormatted || "0s"}</b></div>
          <div>Deaths: <b class="text-red-400">${m.totalDeaths || 0}</b></div>
          <div>Traveled: <b class="text-cyan-300">${m.distanceFormatted || "0m"}</b></div>
        </div>

        <div class="flex items-center justify-between pt-2 border-t border-[#182133] text-[11px]">
          <span class="bg-[#141b29] text-cyan-300 border border-[#222e44] px-2 py-0.5 rounded font-bold flex items-center gap-1">
            <i class="fa-solid fa-users text-[9px]"></i> ${squadTag}
          </span>
          <button onclick="promptAssignSquad('${m.steamId}', '${encodeURIComponent(m.name || m.steamId)}')" class="bg-[#141b29] hover:bg-rust-700 text-gray-300 hover:text-white px-2 py-0.5 rounded border border-[#222e44] transition flex items-center gap-1">
            <i class="fa-solid fa-pen text-[9px]"></i> Squad
          </button>
        </div>
      </div>
    `;
  }).join("");
}

async function loadClanArmory(userInitiated = false) {
  try {
    const res = await fetch("/api/clan/armory");
    if (!res.ok) return;
    const data = await res.json();
    state.clanArmory = data;

    // 1. Total Raid Sulfur Power
    const totalPowerEl = document.getElementById("clan-total-sulfur-power");
    const subtabBoomEl = document.getElementById("subtab-boom-val");
    const val = data.totalSulfurPower || 0;
    if (totalPowerEl) totalPowerEl.textContent = `${val.toLocaleString()} Sulfur`;
    if (subtabBoomEl) {
      if (val >= 1000000) subtabBoomEl.textContent = `${(val / 1000000).toFixed(1)}M`;
      else if (val >= 1000) subtabBoomEl.textContent = `${Math.round(val / 1000)}k`;
      else subtabBoomEl.textContent = val;
    }

    // 2. Explosives counts
    const exp = data.explosives || {};
    const resrc = data.resources || {};

    const rocketsEl = document.getElementById("armory-rockets-count");
    if (rocketsEl) rocketsEl.textContent = exp.rockets || 0;

    const hvEl = document.getElementById("armory-hv-rockets");
    if (hvEl) hvEl.textContent = `+${exp.hvRockets || 0} HV / ${exp.fireRockets || 0} Fire / ${exp.mlrsRockets || 0} MLRS`;

    const c4El = document.getElementById("armory-c4-count");
    if (c4El) c4El.textContent = exp.c4 || 0;

    const satchelsEl = document.getElementById("armory-satchels-count");
    if (satchelsEl) satchelsEl.textContent = exp.satchels || 0;

    const beancansEl = document.getElementById("armory-beancans");
    if (beancansEl) beancansEl.textContent = `+${exp.beancans || 0} Beancans`;

    const exploEl = document.getElementById("armory-explo-count");
    if (exploEl) exploEl.textContent = (exp.exploAmmo || 0).toLocaleString();

    const sulfurEl = document.getElementById("armory-sulfur-count");
    if (sulfurEl) sulfurEl.textContent = (resrc.sulfur || 0).toLocaleString();

    const gpEl = document.getElementById("armory-gp-count");
    if (gpEl) gpEl.textContent = `${(resrc.gunpowder || 0).toLocaleString()} Gunpowder`;

    const hqmEl = document.getElementById("armory-hqm-count");
    if (hqmEl) hqmEl.textContent = (resrc.hqm || 0).toLocaleString();

    const metalEl = document.getElementById("armory-metal-count");
    if (metalEl) metalEl.textContent = `${(resrc.metalFragments || 0).toLocaleString()} Metal Frags`;

    // 3. Multi-TC Grid
    renderMultiTcGrid(data.tcs || []);

    if (userInitiated) showToast("Clan Armory & Multi-TC recalculated!", "success");
  } catch (err) {
    console.error("loadClanArmory error:", err);
    if (userInitiated) showToast(err.message, "error");
  }
}

function renderMultiTcGrid(tcs) {
  const container = document.getElementById("clan-multitc-grid");
  const subtabTcCount = document.getElementById("subtab-tc-count");
  if (subtabTcCount) subtabTcCount.textContent = tcs.length;
  if (!container) return;

  if (tcs.length === 0) {
    container.innerHTML = `<div class="p-6 text-center text-gray-500 font-mono text-xs col-span-full">No Tool Cupboards paired with Storage Monitors. Pair your TC storage monitors using the Wire Tool!</div>`;
    return;
  }

  container.innerHTML = tcs.map(tc => {
    let statusClass = "bg-emerald-950/80 text-emerald-300 border-emerald-700";
    let statusLabel = `🟢 ${tc.upkeepDays}d (${tc.upkeepHours}h)`;

    if (tc.isDecaying) {
      statusClass = "bg-red-950/80 text-red-300 border-red-700";
      statusLabel = "🔴 DECAYING";
    } else if (tc.upkeepHours < 24) {
      statusClass = "bg-amber-950/80 text-amber-300 border-amber-700";
      statusLabel = `🟡 WARNING (${tc.upkeepHours}h)`;
    }

    return `
      <div class="bg-[#0b0e14] border border-[#1e2638] rounded-xl p-4 flex flex-col justify-between gap-3 font-mono text-xs shadow-md">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <i class="fa-solid fa-cubes text-cyan-400"></i>
            <h5 class="font-rust font-bold text-white text-sm truncate">${tc.name}</h5>
          </div>
          <span class="inline-block border px-2 py-0.5 rounded ${statusClass} text-[10px] font-bold">${statusLabel}</span>
        </div>

        <div class="grid grid-cols-2 gap-2 text-[11px] pt-2 border-t border-[#182133] text-gray-400">
          <div>Wood: <b class="text-amber-300">${(tc.wood || 0).toLocaleString()}</b></div>
          <div>Stone: <b class="text-gray-300">${(tc.stones || 0).toLocaleString()}</b></div>
          <div>Metal: <b class="text-cyan-300">${(tc.metal || 0).toLocaleString()}</b></div>
          <div>HQM: <b class="text-emerald-300">${(tc.hqm || 0).toLocaleString()}</b></div>
        </div>
      </div>
    `;
  }).join("");
}

async function refreshClanInfo(userInitiated = false) {
  const btn = document.getElementById("btn-refresh-clan");
  if (btn && userInitiated) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Clan...`;
  }
  try {
    const res = await fetch("/api/clan/info");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to fetch clan info");
    state.clanInfo = data.clanInfo;
    renderClanMotd();
    renderClanAlumni();
    if (userInitiated) {
      if (data.clanInfo?.name) {
        showToast(`Clan [${data.clanInfo.name}] refreshed! (${data.clanInfo.members?.length || 0} members)`, "success");
      } else {
        showToast("Clan info fetched (No active Facepunch clan detected on server)", "info");
      }
    }
  } catch (err) {
    if (userInitiated) showToast(err.message, "error");
  } finally {
    if (btn && userInitiated) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-castle text-amber-400"></i> Clan Info`;
    }
  }
}

function renderClanMotd() {
  const clan = state.clanInfo;
  const nameEl = document.getElementById("clan-info-name");
  const tagEl = document.getElementById("clan-info-tag");
  const authorEl = document.getElementById("clan-motd-author");
  const updatedEl = document.getElementById("clan-motd-updated-at");
  const textEl = document.getElementById("clan-motd-display-text");

  if (nameEl) nameEl.textContent = clan?.name || "Facepunch Clan";
  if (tagEl) tagEl.textContent = clan?.tag || (clan?.name ? clan.name.slice(0, 4) : "--");
  if (authorEl) authorEl.textContent = clan?.motdAuthor ? `SteamID ${clan.motdAuthor}` : "Leader";
  if (updatedEl) {
    updatedEl.textContent = clan?.motdTimestamp ? new Date(Number(clan.motdTimestamp) * 1000).toLocaleString() : "Wipe Start";
  }
  if (textEl) {
    textEl.textContent = clan?.motd ? `"${clan.motd}"` : `"No Clan MOTD currently set on server."`;
  }
}

async function handleSaveClanMotd(event) {
  event.preventDefault();
  const input = document.getElementById("clan-motd-input");
  const motd = input?.value?.trim();
  if (!motd) return;

  try {
    showToast("Updating Clan MOTD in Rust...", "info");
    const res = await fetch("/api/clan/motd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motd })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to set clan MOTD");
    showToast("📢 Clan MOTD updated across all clan members!", "success");
    if (state.clanInfo) {
      state.clanInfo.motd = motd;
      state.clanInfo.motdTimestamp = Math.floor(Date.now() / 1000);
    }
    renderClanMotd();
    if (input) input.value = "";
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function handleSendClanChat(event) {
  event.preventDefault();
  const input = document.getElementById("clan-chat-input");
  const message = input?.value?.trim();
  if (!message) return;

  try {
    const res = await fetch("/api/clan/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to send clan chat");
    appendClanChatMessage({ sender: "You (Web)", message, time: Date.now() });
    if (input) input.value = "";
  } catch (err) {
    showToast(err.message, "error");
  }
}

function appendClanChatMessage(msg) {
  const stream = document.getElementById("clan-chat-stream");
  if (!stream) return;

  const timeStr = new Date(msg.time || Date.now()).toLocaleTimeString();
  const el = document.createElement("div");
  el.className = "bg-[#0b0e14] border border-[#2a251b] p-2 rounded-lg";
  el.innerHTML = `
    <div class="flex items-center justify-between text-[10px] text-gray-500 mb-0.5">
      <span class="font-bold text-amber-400">🏰 ${msg.sender || "Clanmate"}</span>
      <span>${timeStr}</span>
    </div>
    <div class="text-amber-100 text-xs">${msg.message}</div>
  `;

  stream.appendChild(el);
  stream.scrollTop = stream.scrollHeight;
}

// ==========================================
// 4. MAP MARKERS & VENDING (getMapMarkers)
// ==========================================
function renderMarkers() {
  const badge = document.getElementById("markers-count-badge");
  const navBadge = document.getElementById("badge-marker-count");
  if (badge) badge.textContent = `${state.markers.length} Active Marker${state.markers.length === 1 ? "" : "s"}`;
  if (navBadge) navBadge.textContent = state.markers.length;

  // World Events
  const eventsList = document.getElementById("world-events-list");
  const eventsCountPill = document.getElementById("events-count-pill");
  if (eventsCountPill) eventsCountPill.textContent = `${state.worldEvents.length} Active`;

  if (eventsList) {
    if (state.worldEvents.length === 0) {
      eventsList.innerHTML = `<p class="text-gray-500 italic p-4 text-center">No major world events (Cargo, Heli, Chinook, Crates) detected right now.</p>`;
    } else {
      eventsList.innerHTML = state.worldEvents.map(m => {
        let icon = "fa-bell text-yellow-400";
        if (m.type === 5) icon = "fa-ship text-blue-400";
        else if (m.type === 8) icon = "fa-helicopter text-red-400";
        else if (m.type === 4) icon = "fa-plane text-emerald-400";
        else if (m.type === 6) icon = "fa-box-archive text-amber-400";
        else if (m.type === 2) icon = "fa-burst text-orange-400";

        return `
          <div class="bg-[#0b0e14] border border-[#1e2638] rounded-xl p-3 flex items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-lg bg-[#141b29] border border-[#222e44] flex items-center justify-center text-base">
                <i class="fa-solid ${icon}"></i>
              </div>
              <div>
                <h4 class="font-bold text-white text-xs">${m.typeName}</h4>
                <p class="text-[11px] text-gray-400">Sector: <b class="text-cyan-400">${m.grid}</b> | X: ${Math.round(m.x)}, Y: ${Math.round(m.y)}</p>
              </div>
            </div>
            ${m.rotation ? `<span class="text-[10px] text-gray-500">Rot: ${Math.round(m.rotation)}°</span>` : ""}
          </div>
        `;
      }).join("");
    }
  }

  // Vending Machines
  filterVendingMachines();
}

function setVendingFilter(f) {
  state.vendingFilter = f;
  ["all", "instock", "bp"].forEach(id => {
    const el = document.getElementById(`vf-btn-${id}`);
    if (el) {
      if (id === f) {
        el.className = "px-2.5 py-1 rounded text-xs font-mono bg-rust-700 text-white";
      } else {
        el.className = "px-2.5 py-1 rounded text-xs font-mono bg-[#141b29] text-gray-400 hover:text-white";
      }
    }
  });
  filterVendingMachines();
}

function filterVendingMachines() {
  const searchInput = document.getElementById("vending-search-input");
  state.vendingSearch = (searchInput?.value || "").toLowerCase().trim();

  const container = document.getElementById("vending-machines-list");
  if (!container) return;

  let list = state.vendingMachines || [];

  if (state.vendingFilter === "instock") {
    list = list.filter(vm => !vm.outOfStock && vm.sellOrders?.some(so => so.amountInStock > 0));
  } else if (state.vendingFilter === "bp") {
    list = list.filter(vm => vm.sellOrders?.some(so => so.itemIsBlueprint || so.currencyIsBlueprint));
  }

  if (state.vendingSearch) {
    const q = state.vendingSearch;
    list = list.filter(vm => {
      const matchName = (vm.name || "").toLowerCase().includes(q);
      const matchOrders = (vm.sellOrders || []).some(so => 
        (so.itemName || "").toLowerCase().includes(q) || (so.itemShortname || "").toLowerCase().includes(q)
      );
      return matchName || matchOrders;
    });
  }

  const countBadge = document.getElementById("vending-match-count");
  if (countBadge) countBadge.textContent = `${list.length} Shop${list.length === 1 ? "" : "s"}`;

  if (list.length === 0) {
    container.innerHTML = `<p class="text-gray-500 italic p-6 text-center">No vending machines matching filters.</p>`;
    return;
  }

  container.innerHTML = list.map(vm => {
    const orders = vm.sellOrders || [];
    return `
      <div class="bg-[#0b0e14] border border-[#1e2638] rounded-xl p-3.5 space-y-2.5">
        <div class="flex items-center justify-between gap-2 border-b border-[#161f2e] pb-2">
          <div class="flex items-center gap-2 min-w-0">
            <i class="fa-solid fa-shop text-cyan-400"></i>
            <h4 class="font-bold text-white text-xs truncate">${vm.name || "Vending Machine"}</h4>
            <span class="bg-cyan-950/60 border border-cyan-800 text-cyan-300 text-[10px] px-1.5 py-0.2 rounded font-mono font-bold">${vm.grid}</span>
          </div>
          ${vm.outOfStock ? `<span class="bg-red-950/80 border border-red-800 text-red-400 text-[10px] px-1.5 py-0.2 rounded">Out of Stock</span>` : `<span class="bg-emerald-950/80 border border-emerald-800 text-emerald-400 text-[10px] px-1.5 py-0.2 rounded">In Stock</span>`}
        </div>

        ${orders.length === 0 ? `<p class="text-gray-500 italic text-[11px]">No sell orders broadcasted.</p>` : `
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            ${orders.map(o => `
              <div class="bg-[#121722] border border-[#1e2638] rounded p-2 flex items-center justify-between text-[11px]">
                <div>
                  <span class="font-bold text-gray-200">${o.quantity}x ${o.itemName}</span>
                  ${o.itemIsBlueprint ? `<span class="text-[9px] bg-blue-900/60 text-blue-300 border border-blue-700 px-1 py-0.2 rounded ml-1">BP</span>` : ""}
                  <p class="text-gray-400 text-[10px]">Cost: <b class="text-amber-400">${o.costPerItem}</b> ${o.currencyName}</p>
                </div>
                <div class="text-right">
                  <span class="text-[10px] ${o.amountInStock > 0 ? 'text-emerald-400' : 'text-red-400'} font-bold">Stock: ${o.amountInStock}</span>
                </div>
              </div>
            `).join("")}
          </div>
        `}
      </div>
    `;
  }).join("");
}

async function refreshMarkers(userInitiated = false) {
  const btn = document.getElementById("btn-refresh-markers");
  if (btn && userInitiated) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Refreshing...`;
  }
  try {
    const res = await fetch("/api/markers/refresh", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to refresh map markers");
    state.markers = data.markers || [];
    state.worldEvents = data.events || [];
    state.vendingMachines = data.vendingMachines || [];
    renderMarkers();
    redrawMap();
    if (userInitiated) showToast(`Updated ${state.markers.length} markers (getMapMarkers)`, "success");
  } catch (err) {
    if (userInitiated) showToast(err.message, "error");
  } finally {
    if (btn && userInitiated) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> Refresh getMapMarkers`;
    }
  }
}

// ==========================================
// 5. TACTICAL MAP CANVAS ENGINE (getMap)
// ==========================================
let mapCanvas = null;
let mapCtx = null;
let mapInitialized = false;
let isDraggingMap = false;
let dragStartX = 0;
let dragStartY = 0;
let lastMouseX = 0;
let lastMouseY = 0;

function calculateGridPos(x, y, mapSize = 4500) {
  const size = Number(mapSize) || 4500;
  const clampedX = Math.max(0, Math.min(size - 0.1, Number(x)));
  const clampedY = Math.max(0, Math.min(size - 0.1, Number(y)));
  const cellSize = size / 26;
  const col = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(clampedX / cellSize)] || "Z";
  const row = Math.floor((size - clampedY) / cellSize);
  return `${col}${row}`;
}

async function fetchMap(forceRefresh = false) {
  const btn = document.getElementById("btn-refresh-map");
  const loading = document.getElementById("map-loading");
  if (btn && forceRefresh) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Loading...`;
  }
  if (loading) loading.classList.remove("hidden");

  try {
    const url = forceRefresh ? "/api/map/refresh" : "/api/map";
    const method = forceRefresh ? "POST" : "GET";
    const res = await fetch(url, { method });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to fetch map metadata");
    state.mapData = data.map || data;
    await fetchMapImage();
    if (forceRefresh) showToast("Map JPEG and monuments refreshed (getMap)", "success");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn && forceRefresh) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> Fetch Map`;
    }
    if (loading) loading.classList.add("hidden");
  }
}

async function fetchMapImage() {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `/api/map/image?t=${Date.now()}`;
    img.onload = () => {
      state.mapImage = img;
      state.mapImageLoaded = true;
      const dimBadge = document.getElementById("map-dim-badge");
      if (dimBadge) dimBadge.textContent = `${img.naturalWidth} x ${img.naturalHeight}`;
      resetMapView();
      resolve(img);
    };
    img.onerror = (e) => {
      console.warn("Map image could not be loaded directly:", e);
      resolve(null);
    };
  });
}

function initMapCanvas() {
  if (mapInitialized && mapCanvas) return;
  mapCanvas = document.getElementById("map-canvas");
  if (!mapCanvas) return;
  mapCtx = mapCanvas.getContext("2d");
  mapInitialized = true;

  const resize = () => {
    if (!mapCanvas || !mapCanvas.parentElement) return;
    const rect = mapCanvas.parentElement.getBoundingClientRect();
    mapCanvas.width = rect.width;
    mapCanvas.height = rect.height || 700;
    redrawMap();
  };
  window.addEventListener("resize", resize);
  resize();

  // Mouse wheel zoom
  mapCanvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    const rect = mapCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    state.mapOffsetX = mx - (mx - state.mapOffsetX) * factor;
    state.mapOffsetY = my - (my - state.mapOffsetY) * factor;
    state.mapScale *= factor;
    state.mapScale = Math.max(0.2, Math.min(10.0, state.mapScale));
    redrawMap();
  }, { passive: false });

  // Pan dragging
  mapCanvas.addEventListener("mousedown", (e) => {
    isDraggingMap = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });

  window.addEventListener("mousemove", (e) => {
    if (!mapCanvas) return;
    const rect = mapCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (isDraggingMap) {
      const dx = e.clientX - lastMouseX;
      const dy = e.clientY - lastMouseY;
      state.mapOffsetX += dx;
      state.mapOffsetY += dy;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      redrawMap();
    }

    if (mx >= 0 && mx <= rect.width && my >= 0 && my <= rect.height) {
      updateMapHoverCoords(mx, my);
    }
  });

  window.addEventListener("mouseup", () => {
    isDraggingMap = false;
  });

  // Tooltip click / inspect
  mapCanvas.addEventListener("click", (e) => {
    const rect = mapCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    handleMapClick(mx, my);
  });
}

function resetMapView() {
  if (!mapCanvas) mapCanvas = document.getElementById("map-canvas");
  if (!mapCanvas) return;
  const cw = mapCanvas.width || 800;
  const ch = mapCanvas.height || 700;
  const imgW = state.mapImage?.naturalWidth || 3250;
  const imgH = state.mapImage?.naturalHeight || 3250;

  const fitScale = Math.min(cw / imgW, ch / imgH) * 0.95;
  state.mapScale = 1.0;
  state.mapOffsetX = (cw - imgW * fitScale) / 2;
  state.mapOffsetY = (ch - imgH * fitScale) / 2;
  redrawMap();
}

function zoomMap(factor) {
  if (!mapCanvas) return;
  const cw = mapCanvas.width / 2;
  const ch = mapCanvas.height / 2;
  state.mapOffsetX = cw - (cw - state.mapOffsetX) * factor;
  state.mapOffsetY = ch - (ch - state.mapOffsetY) * factor;
  state.mapScale *= factor;
  state.mapScale = Math.max(0.2, Math.min(10.0, state.mapScale));
  redrawMap();
}

function redrawMap() {
  if (!mapCanvas || !mapCtx) return;
  const cw = mapCanvas.width;
  const ch = mapCanvas.height;

  mapCtx.clearRect(0, 0, cw, ch);

  const img = state.mapImage;
  const imgW = img?.naturalWidth || 3250;
  const imgH = img?.naturalHeight || 3250;
  const oceanMargin = state.mapData?.oceanMargin || 500;
  const mapSize = state.serverInfo?.mapSize || 4500;

  const baseScale = Math.min(cw / imgW, ch / imgH) * 0.95;
  const totalScale = baseScale * state.mapScale;

  mapCtx.save();
  mapCtx.translate(state.mapOffsetX, state.mapOffsetY);
  mapCtx.scale(totalScale, totalScale);

  // 1. Draw Map JPEG
  if (img && state.mapImageLoaded) {
    mapCtx.drawImage(img, 0, 0, imgW, imgH);
  } else {
    mapCtx.fillStyle = "#09121d";
    mapCtx.fillRect(0, 0, imgW, imgH);
    mapCtx.fillStyle = "#122030";
    mapCtx.fillRect(oceanMargin, oceanMargin, imgW - 2 * oceanMargin, imgH - 2 * oceanMargin);
  }

  const playableW = imgW - 2 * oceanMargin;
  const playableH = imgH - 2 * oceanMargin;
  const scaleX = playableW / mapSize;
  const scaleY = playableH / mapSize;

  const toImgX = (wx) => oceanMargin + wx * scaleX;
  const toImgY = (wy) => imgH - (oceanMargin + wy * scaleY);

  // 2. Draw Grid (A-Z, 0-25)
  const showGrid = document.getElementById("layer-grid")?.checked ?? true;
  if (showGrid) {
    const cellSize = mapSize / 26;
    mapCtx.strokeStyle = "rgba(0, 200, 255, 0.2)";
    mapCtx.lineWidth = 1.5 / totalScale;
    mapCtx.font = `${Math.max(10, 14 / totalScale)}px "JetBrains Mono", monospace`;
    mapCtx.fillStyle = "rgba(0, 230, 255, 0.7)";
    mapCtx.textAlign = "center";
    mapCtx.textBaseline = "middle";

    for (let i = 0; i <= 26; i++) {
      const gx = toImgX(i * cellSize);
      const gy = toImgY(i * cellSize);

      // Vertical line
      mapCtx.beginPath();
      mapCtx.moveTo(gx, oceanMargin);
      mapCtx.lineTo(gx, imgH - oceanMargin);
      mapCtx.stroke();

      // Horizontal line
      mapCtx.beginPath();
      mapCtx.moveTo(oceanMargin, gy);
      mapCtx.lineTo(imgW - oceanMargin, gy);
      mapCtx.stroke();

      // Top letters (A..Z)
      if (i < 26) {
        const colLetter = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[i];
        const labelX = toImgX((i + 0.5) * cellSize);
        mapCtx.fillText(colLetter, labelX, oceanMargin - 15 / totalScale);
        mapCtx.fillText(String(i), oceanMargin - 18 / totalScale, toImgY((26 - i - 0.5) * cellSize));
      }
    }
  }

  // 3. Draw Monuments
  const showMonuments = document.getElementById("layer-monuments")?.checked ?? true;
  if (showMonuments && state.mapData?.monuments) {
    mapCtx.font = `bold ${Math.max(9, 13 / totalScale)}px "Inter", sans-serif`;
    mapCtx.textAlign = "center";
    mapCtx.textBaseline = "bottom";

    for (const m of state.mapData.monuments) {
      const px = toImgX(m.x);
      const py = toImgY(m.y);

      // Icon circle
      mapCtx.beginPath();
      mapCtx.arc(px, py, 5 / totalScale, 0, Math.PI * 2);
      mapCtx.fillStyle = "#38bdf8";
      mapCtx.fill();
      mapCtx.strokeStyle = "#082f49";
      mapCtx.lineWidth = 1.5 / totalScale;
      mapCtx.stroke();

      // Label
      mapCtx.fillStyle = "rgba(11, 15, 25, 0.85)";
      const label = m.name || m.token;
      const textWidth = mapCtx.measureText(label).width;
      mapCtx.fillRect(px - textWidth / 2 - 4 / totalScale, py - 20 / totalScale, textWidth + 8 / totalScale, 14 / totalScale);
      
      mapCtx.fillStyle = "#e0f2fe";
      mapCtx.fillText(label, px, py - 8 / totalScale);
    }
  }

  // 4. Draw Vending Machines
  const showVending = document.getElementById("layer-vending")?.checked ?? true;
  if (showVending && state.vendingMachines) {
    for (const vm of state.vendingMachines) {
      const px = toImgX(vm.x);
      const py = toImgY(vm.y);

      mapCtx.beginPath();
      mapCtx.arc(px, py, 6 / totalScale, 0, Math.PI * 2);
      mapCtx.fillStyle = vm.outOfStock ? "#ef4444" : "#06b6d4";
      mapCtx.fill();
      mapCtx.strokeStyle = "#ffffff";
      mapCtx.lineWidth = 1.5 / totalScale;
      mapCtx.stroke();
    }
  }

  // 5. Draw World Events (Cargo, Heli, Chinook, Crates, Explosions)
  const showEvents = document.getElementById("layer-events")?.checked ?? true;
  if (showEvents && state.worldEvents) {
    mapCtx.font = `${Math.max(14, 20 / totalScale)}px sans-serif`;
    mapCtx.textAlign = "center";
    mapCtx.textBaseline = "middle";

    for (const evt of state.worldEvents) {
      const px = toImgX(evt.x);
      const py = toImgY(evt.y);

      let emoji = "🔔";
      if (evt.type === 5) emoji = "🚢";
      else if (evt.type === 8) emoji = "🚁";
      else if (evt.type === 4) emoji = "🛩️";
      else if (evt.type === 6) emoji = "📦";
      else if (evt.type === 2) emoji = "💥";

      // Pulsing outer ring
      mapCtx.beginPath();
      mapCtx.arc(px, py, 14 / totalScale, 0, Math.PI * 2);
      mapCtx.fillStyle = "rgba(234, 88, 12, 0.3)";
      mapCtx.fill();
      mapCtx.strokeStyle = "#f97316";
      mapCtx.lineWidth = 2 / totalScale;
      mapCtx.stroke();

      mapCtx.fillText(emoji, px, py);
    }
  }

  // 6. Draw Team Members
  const showTeam = document.getElementById("layer-team")?.checked ?? true;
  const members = state.teamInfo?.members || [];
  const leaderId = state.teamInfo?.leaderSteamId ? String(state.teamInfo.leaderSteamId) : null;

  if (showTeam && members.length > 0) {
    mapCtx.font = `bold ${Math.max(10, 14 / totalScale)}px "Inter", sans-serif`;
    mapCtx.textAlign = "center";
    mapCtx.textBaseline = "bottom";

    for (const m of members) {
      if (m.x === undefined || m.y === undefined) continue;
      const px = toImgX(m.x);
      const py = toImgY(m.y);
      const isLeader = String(m.steamId) === leaderId;

      let color = "#ef4444"; // dead
      if (m.isAlive) {
        color = m.isOnline ? "#10b981" : "#f59e0b"; // alive or sleeping
      }

      // Outer glow
      mapCtx.beginPath();
      mapCtx.arc(px, py, 10 / totalScale, 0, Math.PI * 2);
      mapCtx.fillStyle = isLeader ? "rgba(245, 158, 11, 0.4)" : "rgba(16, 185, 129, 0.3)";
      mapCtx.fill();

      // Pin circle
      mapCtx.beginPath();
      mapCtx.arc(px, py, 6 / totalScale, 0, Math.PI * 2);
      mapCtx.fillStyle = color;
      mapCtx.fill();
      mapCtx.strokeStyle = "#ffffff";
      mapCtx.lineWidth = 2 / totalScale;
      mapCtx.stroke();

      // Name & Leader Tag
      const nameText = `${isLeader ? "👑 " : ""}${m.name || "Teammate"}`;
      const nameW = mapCtx.measureText(nameText).width;
      mapCtx.fillStyle = "rgba(15, 23, 42, 0.9)";
      mapCtx.fillRect(px - nameW / 2 - 4 / totalScale, py - 22 / totalScale, nameW + 8 / totalScale, 15 / totalScale);
      mapCtx.fillStyle = isLeader ? "#fcd34d" : "#ffffff";
      mapCtx.fillText(nameText, px, py - 9 / totalScale);
    }
  }

  // 7. Draw Squad Death Markers (💀)
  const showDeaths = document.getElementById("layer-deaths")?.checked ?? true;
  const recentDeaths = state.telemetry?.deaths || state.telemetry?.recentDeaths || [];
  if (showDeaths && recentDeaths.length > 0) {
    mapCtx.font = `bold ${Math.max(9, 12 / totalScale)}px "Inter", sans-serif`;
    mapCtx.textAlign = "center";
    mapCtx.textBaseline = "middle";

    for (const d of recentDeaths.slice(0, 10)) {
      if (d.x === undefined || d.y === undefined) continue;
      const px = toImgX(d.x);
      const py = toImgY(d.y);

      // Outer death aura
      mapCtx.beginPath();
      mapCtx.arc(px, py, 11 / totalScale, 0, Math.PI * 2);
      mapCtx.fillStyle = "rgba(220, 38, 38, 0.35)";
      mapCtx.fill();
      mapCtx.strokeStyle = "#ef4444";
      mapCtx.lineWidth = 1.5 / totalScale;
      mapCtx.stroke();

      // Skull
      mapCtx.fillText("💀", px, py);

      // Label below
      const deathLabel = `${d.name || "Teammate"} (${d.timeAgo || d.agoDuration || "recent"})`;
      const lw = mapCtx.measureText(deathLabel).width;
      mapCtx.fillStyle = "rgba(15, 23, 42, 0.9)";
      mapCtx.fillRect(px - lw / 2 - 3 / totalScale, py + 12 / totalScale, lw + 6 / totalScale, 13 / totalScale);
      mapCtx.fillStyle = "#fca5a5";
      mapCtx.fillText(deathLabel, px, py + 19 / totalScale);
    }
  }

  // 8. Draw Team Map Notes & Leader Pings
  const mapNotes = [...(state.teamInfo?.mapNotes || []), ...(state.teamInfo?.leaderMapNotes || [])];
  if (mapNotes.length > 0) {
    mapCtx.font = `bold ${Math.max(9, 12 / totalScale)}px "Inter", sans-serif`;
    mapCtx.textAlign = "center";
    mapCtx.textBaseline = "bottom";

    for (const n of mapNotes) {
      if (n.x === undefined || n.y === undefined) continue;
      const px = toImgX(n.x);
      const py = toImgY(n.y);

      mapCtx.beginPath();
      mapCtx.arc(px, py, 7 / totalScale, 0, Math.PI * 2);
      mapCtx.fillStyle = "rgba(234, 179, 8, 0.5)";
      mapCtx.fill();
      mapCtx.strokeStyle = "#eab308";
      mapCtx.lineWidth = 2 / totalScale;
      mapCtx.stroke();

      const noteText = n.label ? `📍 ${n.label}` : "📍 Ping";
      const nw = mapCtx.measureText(noteText).width;
      mapCtx.fillStyle = "rgba(15, 23, 42, 0.9)";
      mapCtx.fillRect(px - nw / 2 - 3 / totalScale, py - 20 / totalScale, nw + 6 / totalScale, 13 / totalScale);
      mapCtx.fillStyle = "#fef08a";
      mapCtx.fillText(noteText, px, py - 9 / totalScale);
    }
  }

  mapCtx.restore();
}

function updateMapHoverCoords(mx, my) {
  const hoverEl = document.getElementById("map-hover-coords");
  if (!hoverEl || !mapCanvas) return;

  const imgW = state.mapImage?.naturalWidth || 3250;
  const imgH = state.mapImage?.naturalHeight || 3250;
  const oceanMargin = state.mapData?.oceanMargin || 500;
  const mapSize = state.serverInfo?.mapSize || 4500;
  const cw = mapCanvas.width;
  const ch = mapCanvas.height;

  const baseScale = Math.min(cw / imgW, ch / imgH) * 0.95;
  const totalScale = baseScale * state.mapScale;

  const imgX = (mx - state.mapOffsetX) / totalScale;
  const imgY = (my - state.mapOffsetY) / totalScale;

  const playableW = imgW - 2 * oceanMargin;
  const playableH = imgH - 2 * oceanMargin;
  const scaleX = playableW / mapSize;
  const scaleY = playableH / mapSize;

  const wx = (imgX - oceanMargin) / scaleX;
  const wy = (imgH - oceanMargin - imgY) / scaleY;

  const grid = calculateGridPos(wx, wy, mapSize);
  hoverEl.textContent = `Sector: ${grid} | X: ${Math.round(wx)}m, Y: ${Math.round(wy)}m`;
}

function handleMapClick(mx, my) {
  const tooltip = document.getElementById("map-tooltip");
  if (!tooltip || !mapCanvas) return;

  const imgW = state.mapImage?.naturalWidth || 3250;
  const imgH = state.mapImage?.naturalHeight || 3250;
  const oceanMargin = state.mapData?.oceanMargin || 500;
  const mapSize = state.serverInfo?.mapSize || 4500;
  const cw = mapCanvas.width;
  const ch = mapCanvas.height;

  const baseScale = Math.min(cw / imgW, ch / imgH) * 0.95;
  const totalScale = baseScale * state.mapScale;

  const imgX = (mx - state.mapOffsetX) / totalScale;
  const imgY = (my - state.mapOffsetY) / totalScale;

  const playableW = imgW - 2 * oceanMargin;
  const playableH = imgH - 2 * oceanMargin;
  const scaleX = playableW / mapSize;
  const scaleY = playableH / mapSize;

  const toImgX = (wx) => oceanMargin + wx * scaleX;
  const toImgY = (wy) => imgH - (oceanMargin + wy * scaleY);

  const clickTolerance = 15 / totalScale;

  // 1. Check Team Members
  const members = state.teamInfo?.members || [];
  for (const m of members) {
    const px = toImgX(m.x);
    const py = toImgY(m.y);
    if (Math.hypot(px - imgX, py - imgY) <= clickTolerance) {
      tooltip.innerHTML = `
        <div class="space-y-1">
          <p class="font-bold text-emerald-400 flex items-center gap-1.5"><i class="fa-solid fa-user"></i> ${m.name || "Teammate"}</p>
          <p class="text-[11px] text-gray-300">Steam ID: ${m.steamId}</p>
          <p class="text-[11px] text-cyan-400">Sector: ${calculateGridPos(m.x, m.y, mapSize)} (X: ${Math.round(m.x)}, Y: ${Math.round(m.y)})</p>
          <p class="text-[10px] text-gray-400">Status: ${m.isAlive ? (m.isOnline ? "🟢 Alive & Online" : "💤 Sleeping") : "💀 Dead"}</p>
        </div>
      `;
      tooltip.style.left = `${Math.min(cw - 220, Math.max(10, mx + 15))}px`;
      tooltip.style.top = `${Math.min(ch - 100, Math.max(10, my - 30))}px`;
      tooltip.classList.remove("hidden");
      return;
    }
  }

  // 2. Check Vending Machines
  const vms = state.vendingMachines || [];
  for (const vm of vms) {
    const px = toImgX(vm.x);
    const py = toImgY(vm.y);
    if (Math.hypot(px - imgX, py - imgY) <= clickTolerance) {
      const orders = vm.sellOrders || [];
      const ordersPreview = orders.slice(0, 4).map(o => `<li>${o.quantity}x ${o.itemName} (${o.costPerItem} ${o.currencyName})</li>`).join("");
      tooltip.innerHTML = `
        <div class="space-y-1">
          <p class="font-bold text-cyan-400 flex items-center gap-1.5"><i class="fa-solid fa-shop"></i> ${vm.name || "Vending Machine"}</p>
          <p class="text-[11px] text-gray-300">Sector: ${vm.grid} | ${vm.outOfStock ? '<span class="text-red-400">Out of Stock</span>' : '<span class="text-emerald-400">In Stock</span>'}</p>
          ${orders.length ? `<ul class="text-[10px] text-gray-300 list-disc pl-4 space-y-0.5">${ordersPreview}</ul>` : ""}
        </div>
      `;
      tooltip.style.left = `${Math.min(cw - 240, Math.max(10, mx + 15))}px`;
      tooltip.style.top = `${Math.min(ch - 120, Math.max(10, my - 30))}px`;
      tooltip.classList.remove("hidden");
      return;
    }
  }

  // 3. Check Monuments
  const monuments = state.mapData?.monuments || [];
  for (const mon of monuments) {
    const px = toImgX(mon.x);
    const py = toImgY(mon.y);
    if (Math.hypot(px - imgX, py - imgY) <= clickTolerance * 1.5) {
      tooltip.innerHTML = `
        <div class="space-y-1">
          <p class="font-bold text-sky-400 flex items-center gap-1.5"><i class="fa-solid fa-landmark"></i> ${mon.name || mon.token}</p>
          <p class="text-[11px] text-gray-300">Sector: ${mon.grid || calculateGridPos(mon.x, mon.y, mapSize)}</p>
          <p class="text-[10px] text-gray-400">Coordinates: X: ${Math.round(mon.x)}, Y: ${Math.round(mon.y)}</p>
        </div>
      `;
      tooltip.style.left = `${Math.min(cw - 220, Math.max(10, mx + 15))}px`;
      tooltip.style.top = `${Math.min(ch - 80, Math.max(10, my - 30))}px`;
      tooltip.classList.remove("hidden");
      return;
    }
  }

  tooltip.classList.add("hidden");
}

function renderTelemetry() {
  renderServerInfo();
  renderTimeInfo();
  renderTeamInfo();
}

function renderSystemLogs() {
  const container = document.getElementById("system-events-stream");
  if (!container) return;

  if (state.recentEvents.length === 0) {
    container.innerHTML = `<p class="text-gray-600 italic">No activity logged yet.</p>`;
    return;
  }

  container.innerHTML = state.recentEvents.map(e => {
    const timeStr = new Date(e.timestamp).toLocaleTimeString();
    return `
      <div class="p-2 border-b border-[#161f2e] flex items-start justify-between gap-4">
        <div>
          <span class="text-rust-400 font-bold uppercase text-[10px] tracking-wider">[${e.type}]</span>
          <span class="text-white ml-2 font-bold">${e.title}:</span>
          <span class="text-gray-400 ml-1">${e.message}</span>
        </div>
        <span class="text-[10px] text-gray-500 flex-shrink-0">${timeStr}</span>
      </div>
    `;
  }).join("");
}

function appendTeamChatMessage(msg) {
  const stream = document.getElementById("team-chat-stream");
  if (!stream) return;

  const timeStr = new Date(msg.time || Date.now()).toLocaleTimeString();
  const el = document.createElement("div");
  el.className = "bg-[#0b0e14] border border-[#1a2233] p-2 rounded-lg";
  el.innerHTML = `
    <div class="flex items-center justify-between text-[10px] text-gray-500 mb-0.5">
      <span class="font-bold" style="color: ${msg.color || "#55ff55"}">${msg.sender || "Teammate"}</span>
      <span>${timeStr}</span>
    </div>
    <div class="text-gray-200 text-xs">${msg.message}</div>
  `;

  stream.appendChild(el);
  stream.scrollTop = stream.scrollHeight;
}

// ==========================================
// ACTIONS & CONTROLS
// ==========================================
async function toggleSwitch(entityId, targetValue) {
  try {
    const res = await fetch("/api/entities/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId, value: targetValue })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to toggle switch");
    showToast(`Smart Switch ${entityId} set to ${targetValue ? "ON" : "OFF"}`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function quickAction(action) {
  try {
    const res = await fetch("/api/entities/quick-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Quick action failed");
    showToast(`Quick Action: ${action.replace("_", " ").toUpperCase()} Executed`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function toggleFCMListener() {
  const target = !state.fcm.isListening;
  try {
    const res = await fetch("/api/fcm/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: target })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to toggle listener");
    state.fcm = data.status;
    renderFCMStatus();
    updateHeaderBadges();
    showToast(`Pairing Listener is now ${target ? "ACTIVE" : "STOPPED"}`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function triggerFCMRegistration() {
  try {
    showToast("Registering with Android FCM & Expo...", "info");
    const res = await fetch("/api/fcm/register", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "FCM registration failed");
    showToast("FCM and Expo Push Token registered successfully!", "success");
    fetchStatus();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function clearPairingLogs() {
  state.pairingLogs = [];
  renderPairingLogs();
}

async function activateServer(id) {
  try {
    showToast("Switching active server & connecting...", "info");
    const res = await fetch(`/api/servers/${id}/activate`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to activate server");
    showToast(`Active server switched to: ${data.server.name}`, "success");
    fetchStatus();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function disconnectServer(id) {
  try {
    const res = await fetch(`/api/servers/${id}/disconnect`, { method: "POST" });
    if (!res.ok) throw new Error("Failed to disconnect");
    showToast("Disconnected from Rust server", "info");
    fetchStatus();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteServer(id) {
  if (!confirm("Are you sure you want to delete this server profile?")) return;
  try {
    const res = await fetch(`/api/servers/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete server");
    showToast("Server profile deleted", "success");
    fetchStatus();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteEntity(entityId) {
  if (!state.activeServer) return;
  if (!confirm(`Delete device ${entityId}?`)) return;
  try {
    const res = await fetch(`/api/servers/${state.activeServer.id}/entities/${entityId}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete entity");
    showToast("Device deleted", "success");
    fetchStatus();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Team Chat Send
document.getElementById("team-chat-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("team-chat-input");
  const msg = input.value.trim();
  if (!msg) return;

  try {
    const res = await fetch("/api/team/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to send team chat");
    appendTeamChatMessage({ sender: "You (Web)", message: msg, color: "#ce422b", time: Date.now() });
    input.value = "";
  } catch (err) {
    showToast(err.message, "error");
  }
});

// Matrix Diagnostics
async function testMatrixAlert() {
  try {
    showToast("Sending sample test alert to Matrix...", "info");
    const res = await fetch("/api/matrix/test-alert", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Matrix alert test failed");
    showToast("✅ Matrix test alert dispatched successfully to Alerts room!", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function testMatrixRaid() {
  try {
    showToast("Dispatching sample @room raid ping to Matrix...", "warning");
    const res = await fetch("/api/matrix/test-raid", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Matrix raid test failed");
    showToast("🚨 High-priority @room Raid Alert sent to Raid room!", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function testMatrixChat() {
  try {
    showToast("Sending test message to TeamChat room...", "info");
    const res = await fetch("/api/matrix/test-chat", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Matrix chat test failed");
    showToast("💬 Test team chat dispatched to Matrix TeamChat room!", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Tab Navigation
function switchTab(tabId) {
  currentTab = tabId;
  document.querySelectorAll(".tab-content").forEach(el => el.classList.add("hidden"));
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.className = "tab-btn px-4 py-2 rounded-lg text-sm font-rust uppercase font-bold tracking-wider transition flex items-center gap-2 text-gray-400 hover:text-white hover:bg-[#141b29] border border-transparent";
  });

  const targetContent = document.getElementById(`tab-${tabId}`);
  const targetBtn = document.getElementById(`tab-btn-${tabId}`);

  if (targetContent) targetContent.classList.remove("hidden");
  if (targetBtn) {
    targetBtn.className = "tab-btn active px-4 py-2 rounded-lg text-sm font-rust uppercase font-bold tracking-wider transition flex items-center gap-2 text-white bg-rust-700/80 border border-rust-500";
  }

  if (tabId === "map") {
    setTimeout(() => {
      initMapCanvas();
      if (!state.mapData) {
        fetchMap(false);
      } else {
        redrawMap();
      }
    }, 50);
  } else if (tabId === "switches") {
    loadStorageAndUpkeepData();
    loadAutomationData();
  } else if (tabId === "telemetry") {
    renderServerInfo();
    renderTimeInfo();
    renderTeamInfo();
    loadTeamTelemetryData();
    loadNotesData();
  } else if (tabId === "markers") {
    renderMarkers();
  } else if (tabId === "calculators") {
    loadCalculatorsData();
  } else if (tabId === "settings") {
    loadSettings();
    loadWatchlistData();
  }
}

// Modals
function openModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove("hidden");
    el.classList.add("flex");
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add("hidden");
    el.classList.remove("flex");
  }
}

function openAddServerModal() {
  document.getElementById("server-form").reset();
  document.getElementById("server-form-id").value = "";
  document.getElementById("modal-server-title").textContent = "Add Server Profile";
  openModal("modal-server");
}

function editServer(id) {
  const s = state.servers.find(srv => srv.id === id);
  if (!s) return;
  document.getElementById("server-form-id").value = s.id;
  document.getElementById("server-form-name").value = s.name;
  document.getElementById("server-form-ip").value = s.ip;
  document.getElementById("server-form-port").value = s.port;
  document.getElementById("server-form-playerid").value = s.playerId;
  document.getElementById("server-form-token").value = s.playerToken;
  document.getElementById("server-form-proxy").checked = !!s.useFacepunchProxy;
  document.getElementById("modal-server-title").textContent = "Edit Server Profile";
  openModal("modal-server");
}

function openAddEntityModal() {
  if (!state.activeServer) {
    return showToast("Please select or activate a server first.", "warning");
  }
  document.getElementById("entity-form").reset();
  openModal("modal-entity");
}

document.getElementById("server-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("server-form-id").value;
  const name = document.getElementById("server-form-name").value.trim();
  const ip = document.getElementById("server-form-ip").value.trim();
  const port = document.getElementById("server-form-port").value;
  const playerId = document.getElementById("server-form-playerid").value.trim();
  const playerToken = document.getElementById("server-form-token").value;
  const useFacepunchProxy = document.getElementById("server-form-proxy").checked;

  try {
    const res = await fetch("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, ip, port, playerId, playerToken, useFacepunchProxy })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save server");
    closeModal("modal-server");
    showToast(`Server profile "${name}" saved`, "success");
    fetchStatus();
  } catch (err) {
    showToast(err.message, "error");
  }
});

document.getElementById("entity-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.activeServer) return;

  const name = document.getElementById("entity-form-name").value.trim();
  const entityId = document.getElementById("entity-form-id").value;
  const type = document.getElementById("entity-form-type").value;
  const category = document.getElementById("entity-form-category").value;

  try {
    const res = await fetch(`/api/servers/${state.activeServer.id}/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, entityId, type, category })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save entity");
    closeModal("modal-entity");
    showToast(`Device "${name}" added`, "success");
    fetchStatus();
  } catch (err) {
    showToast(err.message, "error");
  }
});

// Initialization
document.addEventListener("DOMContentLoaded", () => {
  checkAuth();
});


// Voice Call Controls
async function joinVoiceCall() {
  try {
    showToast("Joining MatrixRTC Voice Call...", "info");
    const res = await fetch("/api/matrix/voice-call/join", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to join call");
    showToast("🎙️ Bot successfully joined the Matrix Voice Call room!", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function speakVoiceText(text, title = "Tactical Voice Alert", voice = "en-US-ChristopherNeural") {
  try {
    showToast(`Synthesizing and speaking: "${title}"...`, "info");
    const res = await fetch("/api/matrix/voice-call/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, title, voice })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to speak voice alert");
    showToast(`🔊 Voice Alert "${title}" broadcasted to voice call room!`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

function speakPresetAlert(type) {
  const presets = {
    raid: {
      title: "🚨 Base Raid Alert",
      text: "Raid alert! Core smart alarm triggered on compound. Defend now!"
    },
    cargo: {
      title: "🚢 Cargo Ship Spawn",
      text: "Cargo ship has spawned and is approaching harbor."
    },
    heli: {
      title: "🚁 Patrol Heli Inbound",
      text: "Patrol helicopter inbound near sector Golf 14."
    },
    oilrig: {
      title: "📦 Oil Rig Crate Activated",
      text: "Large Oil Rig locked crate activated. Heavies deployed."
    }
  };

  const p = presets[type];
  if (p) speakVoiceText(p.text, p.title);
}

document.getElementById("custom-voice-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("custom-voice-text");
  const select = document.getElementById("custom-voice-select");
  const text = input.value.trim();
  const voice = select.value;
  if (!text) return;

  await speakVoiceText(text, "Custom Voice Announcement", voice);
  input.value = "";
});


async function importRustPlusConfig() {
  const textarea = document.getElementById("fcm-config-json-input");
  if (!textarea || !textarea.value.trim()) {
    showToast("Please paste your rustplus.config.json content", "error");
    return;
  }

  try {
    showToast("Importing rustplus.config.json...", "info");
    const res = await fetch("/api/fcm/import-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonContent: textarea.value.trim() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to import configuration");

    showToast("🎉 rustplus.config.json imported and FCM listener activated!", "success");
    state.fcm = data.status;
    textarea.value = "";
    renderFCMStatus();
    updateHeaderBadges();
  } catch (err) {
    showToast(err.message, "error");
  }
}

window.importRustPlusConfig = importRustPlusConfig;
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-import-config")?.addEventListener("click", importRustPlusConfig);
});

// ==========================================
// SETTINGS & INTEGRATIONS
// ==========================================

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) throw new Error("Failed to load settings");
    const data = await res.json();

    if (data.ai) {
      const toggle = document.getElementById("setting-ai-enabled");
      const statusText = document.getElementById("setting-ai-status-text");
      if (toggle) {
        toggle.checked = !!data.ai.enabled;
        if (statusText) {
          statusText.textContent = data.ai.enabled ? "Enabled" : "Disabled";
          statusText.className = data.ai.enabled
            ? "ml-2 text-xs font-mono font-bold text-emerald-400"
            : "ml-2 text-xs font-mono font-bold text-gray-400";
        }
      }

      const radioGroq = document.getElementById("setting-ai-provider-groq");
      const radioGemini = document.getElementById("setting-ai-provider-gemini");
      const radioOpenai = document.getElementById("setting-ai-provider-openai");
      if (data.ai.provider === "groq") {
        if (radioGroq) radioGroq.checked = true;
      } else if (data.ai.provider === "openai") {
        if (radioOpenai) radioOpenai.checked = true;
      } else {
        if (radioGemini) radioGemini.checked = true;
      }

      const modelInput = document.getElementById("setting-ai-model");
      if (modelInput) modelInput.value = data.ai.model || "gemini-1.5-flash";

      const keyStatus = document.getElementById("setting-ai-key-status");
      if (keyStatus) {
        keyStatus.textContent = data.ai.hasApiKey ? `Saved (${data.ai.apiKeyMasked})` : "Not configured";
        keyStatus.className = data.ai.hasApiKey ? "text-[11px] text-emerald-400 font-mono" : "text-[11px] text-gray-500 font-mono";
      }

      const promptInput = document.getElementById("setting-ai-prompt");
      if (promptInput) promptInput.value = data.ai.customPrompt || "";
    }

    if (data.externalApis) {
      const steamStatus = document.getElementById("setting-steam-key-status");
      if (steamStatus) {
        steamStatus.textContent = data.externalApis.hasSteamApiKey ? `Saved (${data.externalApis.steamApiKeyMasked})` : "Not configured";
        steamStatus.className = data.externalApis.hasSteamApiKey ? "text-[11px] text-emerald-400 font-mono" : "text-[11px] text-gray-500 font-mono";
      }

      const bmStatus = document.getElementById("setting-bm-token-status");
      if (bmStatus) {
        bmStatus.textContent = data.externalApis.hasBattleMetricsToken ? `Saved (${data.externalApis.battleMetricsTokenMasked})` : "Not configured";
        bmStatus.className = data.externalApis.hasBattleMetricsToken ? "text-[11px] text-emerald-400 font-mono" : "text-[11px] text-gray-500 font-mono";
      }

      const bmServer = document.getElementById("setting-bm-serverid");
      if (bmServer) bmServer.value = data.externalApis.battleMetricsServerId || "";
    }

    if (data.dayNightAlerts) {
      const dn = data.dayNightAlerts;
      const toggle = document.getElementById("setting-daynight-enabled");
      const statusText = document.getElementById("setting-daynight-status-text");
      if (toggle) {
        toggle.checked = dn.enabled !== false;
        if (statusText) {
          statusText.textContent = dn.enabled !== false ? "Active" : "Disabled";
          statusText.className = dn.enabled !== false
            ? "ml-2 text-xs font-mono font-bold text-amber-400"
            : "ml-2 text-xs font-mono font-bold text-gray-400";
        }
      }
      const chkNight5 = document.getElementById("setting-daynight-night5m");
      if (chkNight5) chkNight5.checked = dn.night5m !== false;
      const chkDay5 = document.getElementById("setting-daynight-day5m");
      if (chkDay5) chkDay5.checked = dn.day5m !== false;
      const chkDay2 = document.getElementById("setting-daynight-day2m");
      if (chkDay2) chkDay2.checked = dn.day2m !== false;
      const chkTeam = document.getElementById("setting-daynight-teamchat");
      if (chkTeam) chkTeam.checked = dn.inGameTeamChat !== false;
      const chkMatrix = document.getElementById("setting-daynight-matrix");
      if (chkMatrix) chkMatrix.checked = dn.matrixAlerts !== false;
    }
  } catch (err) {
    console.error("[Settings] Error loading:", err.message);
  }
}

async function saveSettingsForm() {
  const btn = document.getElementById("settings-save-btn");
  const origHtml = btn ? btn.innerHTML : "";
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

  const aiEnabled = document.getElementById("setting-ai-enabled")?.checked || false;
  const aiProvider = document.querySelector('input[name="ai-provider"]:checked')?.value || "gemini";
  const aiModel = document.getElementById("setting-ai-model")?.value.trim() || "";
  const aiApiKey = document.getElementById("setting-ai-apikey")?.value.trim() || undefined;
  const aiPrompt = document.getElementById("setting-ai-prompt")?.value.trim() || "";

  const dnEnabled = document.getElementById("setting-daynight-enabled")?.checked !== false;
  const dnNight5 = document.getElementById("setting-daynight-night5m")?.checked !== false;
  const dnDay5 = document.getElementById("setting-daynight-day5m")?.checked !== false;
  const dnDay2 = document.getElementById("setting-daynight-day2m")?.checked !== false;
  const dnTeam = document.getElementById("setting-daynight-teamchat")?.checked !== false;
  const dnMatrix = document.getElementById("setting-daynight-matrix")?.checked !== false;

  const steamKey = document.getElementById("setting-steam-apikey")?.value.trim() || undefined;
  const bmToken = document.getElementById("setting-bm-token")?.value.trim() || undefined;
  const bmServerId = document.getElementById("setting-bm-serverid")?.value.trim() || "";

  const payload = {
    ai: {
      enabled: aiEnabled,
      provider: aiProvider,
      model: aiModel,
      apiKey: aiApiKey,
      customPrompt: aiPrompt
    },
    dayNightAlerts: {
      enabled: dnEnabled,
      night5m: dnNight5,
      day5m: dnDay5,
      day2m: dnDay2,
      inGameTeamChat: dnTeam,
      matrixAlerts: dnMatrix
    },
    externalApis: {
      steamApiKey: steamKey,
      battleMetricsToken: bmToken,
      battleMetricsServerId: bmServerId
    }
  };

  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save settings");

    showToast("Settings updated successfully!", "success");

    // Clear password inputs
    const keyInput = document.getElementById("setting-ai-apikey");
    if (keyInput) keyInput.value = "";
    const steamInput = document.getElementById("setting-steam-apikey");
    if (steamInput) steamInput.value = "";
    const bmInput = document.getElementById("setting-bm-token");
    if (bmInput) bmInput.value = "";

    await loadSettings();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn) btn.innerHTML = origHtml;
  }
}

function handleDayNightToggle(checked) {
  const statusText = document.getElementById("setting-daynight-status-text");
  if (statusText) {
    statusText.textContent = checked ? "Active" : "Disabled";
    statusText.className = checked
      ? "ml-2 text-xs font-mono font-bold text-amber-400"
      : "ml-2 text-xs font-mono font-bold text-gray-400";
  }
}

function handleAiProviderChange() {
  const provider = document.querySelector('input[name="ai-provider"]:checked')?.value;
  const modelInput = document.getElementById("setting-ai-model");
  const keyInput = document.getElementById("setting-ai-apikey");
  if (modelInput) {
    if (provider === "groq") {
      modelInput.placeholder = "qwen/qwen3.8-27b";
      if (!modelInput.value || (!modelInput.value.includes("qwen") && !modelInput.value.includes("oss") && !modelInput.value.includes("llama"))) {
        modelInput.value = "qwen/qwen3.8-27b";
      }
      if (keyInput) keyInput.placeholder = "Enter Groq API Key (gsk_...)...";
    } else if (provider === "openai") {
      modelInput.placeholder = "gpt-4o-mini";
      if (!modelInput.value || modelInput.value.includes("gemini") || modelInput.value.includes("qwen")) {
        modelInput.value = "gpt-4o-mini";
      }
      if (keyInput) keyInput.placeholder = "Enter OpenAI API Key (sk-...)...";
    } else {
      modelInput.placeholder = "gemini-1.5-flash";
      if (!modelInput.value || modelInput.value.includes("gpt-") || modelInput.value.includes("qwen")) {
        modelInput.value = "gemini-1.5-flash";
      }
      if (keyInput) keyInput.placeholder = "Enter Gemini API Key (AIzaSy...)...";
    }
  }
}

function selectModelPreset(val) {
  if (!val) return;
  const modelInput = document.getElementById("setting-ai-model");
  if (modelInput) modelInput.value = val;

  if (val.startsWith("qwen/") || val.startsWith("openai/gpt-oss") || val.startsWith("llama-") || val.startsWith("mixtral-")) {
    const radio = document.getElementById("setting-ai-provider-groq");
    if (radio) radio.checked = true;
  } else if (val.startsWith("gpt-")) {
    const radio = document.getElementById("setting-ai-provider-openai");
    if (radio) radio.checked = true;
  } else if (val.startsWith("gemini-")) {
    const radio = document.getElementById("setting-ai-provider-gemini");
    if (radio) radio.checked = true;
  }
  handleAiProviderChange();
}

function togglePasswordVisibility(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.type = el.type === "password" ? "text" : "password";
}

// Wire up dynamic toggle text change
document.addEventListener("DOMContentLoaded", () => {
  const aiToggle = document.getElementById("setting-ai-enabled");
  if (aiToggle) {
    aiToggle.addEventListener("change", () => {
      const statusText = document.getElementById("setting-ai-status-text");
      if (statusText) {
        statusText.textContent = aiToggle.checked ? "Enabled" : "Disabled";
        statusText.className = aiToggle.checked
          ? "ml-2 text-xs font-mono font-bold text-emerald-400"
          : "ml-2 text-xs font-mono font-bold text-gray-400";
      }
    });
  }
});

window.loadSettings = loadSettings;
window.saveSettingsForm = saveSettingsForm;
window.handleAiProviderChange = handleAiProviderChange;
window.selectModelPreset = selectModelPreset;
window.togglePasswordVisibility = togglePasswordVisibility;


// ==========================================
// 6. STORAGE, UPKEEP & INVENTORY
// ==========================================
async function loadStorageAndUpkeepData() {
  try {
    const res = await fetch("/api/storage");
    if (!res.ok) return;
    const data = await res.json();
    state.storage = data;

    // 1. Render TC Upkeep
    const pill = document.getElementById("tc-status-pill");
    const nameLabel = document.getElementById("tc-name-label");
    const timeRemaining = document.getElementById("tc-time-remaining");
    const resWood = document.getElementById("tc-res-wood");
    const resStone = document.getElementById("tc-res-stone");
    const resMetal = document.getElementById("tc-res-metal");
    const resHqm = document.getElementById("tc-res-hqm");

    if (data.tc) {
      if (pill) {
        if (data.tc.isDecaying) {
          pill.className = "text-xs font-mono px-2 py-0.5 rounded bg-red-950/80 border border-red-700 text-red-300 font-bold animate-pulse";
          pill.textContent = "⚠️ BASE DECAYING";
        } else {
          pill.className = "text-xs font-mono px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-700 text-emerald-300 font-bold";
          pill.textContent = "PROTECTED";
        }
      }
      if (nameLabel) nameLabel.textContent = `${data.tc.name || "Tool Cupboard"} (ID: ${data.tc.id})`;
      if (timeRemaining) {
        if (data.tc.isDecaying) {
          timeRemaining.className = "text-xl font-rust font-bold text-red-400";
          timeRemaining.textContent = "DECAYING NOW (0h)";
        } else {
          timeRemaining.className = "text-xl font-rust font-bold text-emerald-400";
          timeRemaining.textContent = `${data.tc.remainingDays || 0}d (${data.tc.remainingHours || 0}h) remaining`;
        }
      }
      if (resWood) resWood.textContent = (data.tc.resources?.wood || 0).toLocaleString();
      if (resStone) resStone.textContent = (data.tc.resources?.stone || 0).toLocaleString();
      if (resMetal) resMetal.textContent = (data.tc.resources?.metal || 0).toLocaleString();
      if (resHqm) resHqm.textContent = (data.tc.resources?.hqm || 0).toLocaleString();
    } else {
      if (pill) {
        pill.className = "text-xs font-mono px-2 py-0.5 rounded bg-gray-800 text-gray-400";
        pill.textContent = "No TC Paired";
      }
      if (nameLabel) nameLabel.textContent = "Pair a storage monitor to your Tool Cupboard";
      if (timeRemaining) timeRemaining.textContent = "--";
    }

    // 2. Render Storage Containers
    const grid = document.getElementById("storage-containers-grid");
    if (grid) {
      const containers = data.containers || [];
      if (containers.length === 0) {
        grid.innerHTML = `<div class="p-6 text-center text-gray-500 font-mono text-xs col-span-full">No paired storage monitors detected. Pair with the Wire Tool in-game.</div>`;
      } else {
        grid.innerHTML = containers.map(box => {
          const isMonitored = !!box.monitoring;

          return `
            <div class="bg-[#0b0e14] border ${isMonitored ? 'border-cyan-700/60' : 'border-[#1e2638]'} rounded-xl p-4 flex flex-col justify-between gap-3">
              <div class="flex items-start justify-between gap-2 border-b border-[#182133] pb-2">
                <div>
                  <h4 class="font-rust font-bold text-white text-sm truncate" title="${box.name}">${box.name || "Storage Box"}</h4>
                  <span class="text-[10px] font-mono text-gray-400">ID: ${box.id} | ${box.items?.length || 0}/${box.capacity || 30} slots</span>
                </div>
                <div class="flex items-center gap-1.5">
                  <button onclick="toggleContainerMonitor('${box.id}')" title="${isMonitored ? 'Monitoring Active' : 'Toggle Diff Monitor'}" class="px-2 py-1 rounded text-[10px] font-mono ${isMonitored ? 'bg-cyan-950 text-cyan-300 border border-cyan-700' : 'bg-gray-800 text-gray-400 border border-gray-700'}">
                    <i class="fa-solid fa-eye mr-1"></i>${isMonitored ? 'Watching' : 'Watch'}
                  </button>
                  <button onclick="calculateBoxRecycle('${box.id}')" title="Calculate Recycle Yield" class="px-2 py-1 rounded text-[10px] font-mono bg-[#182030] hover:bg-[#222e44] text-emerald-300 border border-emerald-800">
                    <i class="fa-solid fa-recycle"></i>
                  </button>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-1.5 max-h-36 overflow-y-auto custom-scrollbar font-mono text-[11px]">
                ${(box.items && box.items.length > 0) ? box.items.map(item => `
                  <div class="bg-[#121722] border border-[#1e2638] px-2 py-1 rounded flex items-center justify-between">
                    <span class="text-gray-300 truncate mr-1" title="${item.name}">${item.name}</span>
                    <span class="text-amber-400 font-bold">${item.quantity?.toLocaleString() || 1}</span>
                  </div>
                `).join('') : '<p class="text-gray-500 italic col-span-2 text-[10px]">Box is empty.</p>'}
              </div>
            </div>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.error("loadStorageAndUpkeepData error:", err);
  }
}

async function refreshStorageData() {
  try {
    showToast("Refreshing storage & Tool Cupboard data...", "info");
    const res = await fetch("/api/storage/refresh", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to refresh storage");
    showToast("Storage data refreshed from in-game monitors!", "success");
    await loadStorageAndUpkeepData();
  } catch (err) {
    showToast(err.message, "error");
  }
}

let searchDebounceTimer = null;
function handleStorageSearch(val) {
  clearTimeout(searchDebounceTimer);
  const resultsDiv = document.getElementById("storage-search-results");
  if (!resultsDiv) return;

  const query = (val || "").trim();
  if (!query) {
    resultsDiv.classList.add("hidden");
    resultsDiv.innerHTML = "";
    return;
  }

  searchDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/storage/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search error");

      const results = data.results || [];
      resultsDiv.classList.remove("hidden");
      if (results.length === 0) {
        resultsDiv.innerHTML = `<p class="text-gray-500 italic">No items matching "${query}" found across storage containers.</p>`;
      } else {
        const totalFound = results.reduce((acc, r) => acc + (r.quantity || 0), 0);
        resultsDiv.innerHTML = `
          <div class="flex items-center justify-between border-b border-[#222e44] pb-2 mb-2">
            <span class="text-amber-400 font-bold"><i class="fa-solid fa-boxes-stacked mr-1.5"></i> Found ${totalFound.toLocaleString()}x total matching "${query}"</span>
            <span class="text-gray-500 text-[10px]">${results.length} location(s)</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            ${results.map(r => `
              <div class="bg-[#121722] border border-[#1e2638] p-2 rounded flex items-center justify-between">
                <div>
                  <span class="text-white font-bold block">${r.itemName}</span>
                  <span class="text-gray-400 text-[10px]">${r.containerName}</span>
                </div>
                <span class="text-amber-400 font-bold text-sm">${r.quantity.toLocaleString()}</span>
              </div>
            `).join('')}
          </div>
        `;
      }
    } catch (err) {
      console.error("Storage search error:", err);
    }
  }, 250);
}

async function calculateBoxRecycle(boxId) {
  try {
    const isSafe = document.getElementById("calc-recycle-safezone")?.checked || false;
    showToast("Calculating recycler yield for box...", "info");
    const res = await fetch(`/api/storage/${boxId}/recycle?safezone=${isSafe}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Recycle calc failed");

    const yieldSummary = Object.entries(data.yield || {})
      .map(([k, v]) => `${v.toLocaleString()}x ${k}`)
      .join(", ") || "No recyclable components";

    showToast(`♻️ Box "${data.containerName || boxId}" Yield: ${yieldSummary}`, "info", 6000);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function toggleContainerMonitor(boxId) {
  try {
    const res = await fetch(`/api/storage/${boxId}/monitor`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to toggle monitor");
    showToast(`Container monitoring ${data.monitoring ? "ENABLED (item changes alerted to team)" : "DISABLED"}`, "success");
    await loadStorageAndUpkeepData();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ==========================================
// 7. DEVICE AUTOMATION & TIMERS
// ==========================================
async function loadAutomationData() {
  try {
    const res = await fetch("/api/automation");
    if (!res.ok) return;
    const data = await res.json();
    state.automation = data;

    // 1. Update SAM sliders & voice toggle
    const slider = document.getElementById("sam-delay-slider");
    const label = document.getElementById("sam-delay-label");
    const voice = document.getElementById("sam-voice-toggle");

    if (slider && data.samConfig) slider.value = data.samConfig.rearmDelaySec || 180;
    if (label && data.samConfig) {
      const sec = data.samConfig.rearmDelaySec || 180;
      label.textContent = sec === 0 ? "Disabled" : `${sec}s (${Math.round(sec / 60)}m)`;
    }
    if (voice && data.samConfig) voice.checked = data.samConfig.voiceAlertEnabled ?? true;

    // 2. Render Alarm History
    const list = document.getElementById("alarm-history-list");
    if (list) {
      const history = data.alarmHistory || [];
      if (history.length === 0) {
        list.innerHTML = `<p class="text-gray-500 italic">No recent alarms triggered.</p>`;
      } else {
        list.innerHTML = history.map(item => `
          <div class="bg-[#0b0e14] border border-red-950/60 p-2.5 rounded-lg flex items-center justify-between">
            <div class="flex items-center gap-2">
              <i class="fa-solid fa-bell text-red-500"></i>
              <div>
                <span class="text-white font-bold">${item.name || "Perimeter Alarm"}</span>
                <span class="text-gray-500 text-[10px] block font-mono">ID: ${item.entityId}</span>
              </div>
            </div>
            <span class="text-gray-400 text-[10px] font-mono">${item.timeAgo || new Date(item.timestamp).toLocaleTimeString()}</span>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.error("loadAutomationData error:", err);
  }
}

function openAutomationModal(entityId, rawName) {
  const name = decodeURIComponent(rawName || entityId);
  const idInput = document.getElementById("automation-entity-id");
  if (idInput) idInput.value = entityId;
  const nameEl = document.getElementById("modal-automation-switch-name");
  if (nameEl) nameEl.textContent = `${name} (ID: ${entityId})`;

  const currentRule = state.automation?.autoRules?.[entityId];
  const autoTimeInput = document.getElementById("auto-rule-time");
  const autoStatusP = document.getElementById("auto-rule-current-status");

  if (currentRule) {
    if (autoTimeInput) autoTimeInput.value = currentRule.delayStr || "";
    if (autoStatusP) autoStatusP.textContent = `Active: Auto-${currentRule.action || 'off'} after ${currentRule.delayStr || (currentRule.delaySec + 's')}`;
  } else {
    if (autoTimeInput) autoTimeInput.value = "";
    if (autoStatusP) autoStatusP.textContent = "No auto timer set";
  }

  const dnRule = state.automation?.dayNightRules?.[entityId];
  const dnSelect = document.getElementById("daynight-rule-select");
  if (dnSelect) dnSelect.value = dnRule || "none";

  const toRule = state.automation?.teamOfflineRules?.[entityId];
  const toSelect = document.getElementById("teamoffline-rule-select");
  if (toSelect) toSelect.value = toRule || "none";

  openModal("modal-automation");
}

async function saveAutoOffRule() {
  const entityId = document.getElementById("automation-entity-id")?.value;
  const delayStr = document.getElementById("auto-rule-time")?.value.trim();
  if (!entityId || !delayStr) {
    showToast("Please specify a duration (e.g. 30s, 2m, 5m)", "warning");
    return;
  }
  try {
    const res = await fetch("/api/automation/auto-rule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId, action: "off", delayStr })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to set auto-off rule");
    showToast(`Auto-off timer set for ${delayStr}!`, "success");
    await loadAutomationData();
    closeModal("modal-automation");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function clearAutoRuleCurrent() {
  const entityId = document.getElementById("automation-entity-id")?.value;
  if (!entityId) return;
  try {
    const res = await fetch("/api/automation/auto-rule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId, action: "clear" })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to clear rule");
    showToast("Auto-off timer removed", "success");
    await loadAutomationData();
    const autoStatusP = document.getElementById("auto-rule-current-status");
    if (autoStatusP) autoStatusP.textContent = "No auto timer set";
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function saveDayNightRule(trigger) {
  const entityId = document.getElementById("automation-entity-id")?.value;
  if (!entityId) return;
  try {
    const res = await fetch("/api/automation/day-night", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId, trigger })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save day/night rule");
    showToast(`Day/Night rule updated to: ${trigger}`, "success");
    await loadAutomationData();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function saveTeamOfflineRule(action) {
  const entityId = document.getElementById("automation-entity-id")?.value;
  if (!entityId) return;
  try {
    const res = await fetch("/api/automation/team-offline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId, action })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save team offline rule");
    showToast(`Sleep defense rule updated: ${action}`, "success");
    await loadAutomationData();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function executeTimedToggle() {
  const entityId = document.getElementById("automation-entity-id")?.value;
  const durationStr = document.getElementById("ttoggle-input-time")?.value.trim();
  if (!entityId || !durationStr) {
    showToast("Please enter duration (e.g. 1m, 30s)", "warning");
    return;
  }
  try {
    const res = await fetch("/api/automation/ttoggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId, durationStr })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to trigger timed toggle");
    showToast(`Switched device! Will revert in ${durationStr}`, "success");
    closeModal("modal-automation");
    fetchStatus();
  } catch (err) {
    showToast(err.message, "error");
  }
}

let samDelayDebounce = null;
function handleSamDelayChange(val) {
  const label = document.getElementById("sam-delay-label");
  const sec = Number(val);
  if (label) label.textContent = sec === 0 ? "Disabled" : `${sec}s (${Math.round(sec / 60)}m)`;

  clearTimeout(samDelayDebounce);
  samDelayDebounce = setTimeout(async () => {
    try {
      const res = await fetch("/api/automation/sam-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rearmDelaySec: sec })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update SAM delay");
      showToast(`SAM auto re-arm delay set to ${sec}s`, "info");
    } catch (err) {
      showToast(err.message, "error");
    }
  }, 400);
}

async function handleSamVoiceToggle(enabled) {
  try {
    const res = await fetch("/api/automation/sam-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceAlertEnabled: enabled })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to update SAM voice setting");
    showToast(`10s SAM voice countdown ${enabled ? "ENABLED" : "DISABLED"}`, "info");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ==========================================
// 8. TEAM TELEMETRY, LEADERBOARD & NOTES
// ==========================================
async function loadTeamTelemetryData() {
  try {
    const res = await fetch("/api/team/telemetry");
    if (!res.ok) return;
    const data = await res.json();
    state.telemetry = data;

    // 1. Leaderboard Table
    const tbody = document.getElementById("telemetry-leaderboard-body");
    if (tbody) {
      const list = data.leaderboard || [];
      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-3 text-center text-gray-500 italic">No wipe telemetry recorded yet.</td></tr>`;
      } else {
        tbody.innerHTML = list.map(row => `
          <tr class="hover:bg-[#151c2a] transition">
            <td class="py-2.5 font-bold text-white flex items-center gap-1.5">
              <span>${row.name || row.steamId}</span>
              ${row.isAfk ? '<span class="text-[9px] bg-amber-950 text-amber-300 border border-amber-800 px-1 py-0.2 rounded">AFK</span>' : ''}
            </td>
            <td class="py-2.5 text-emerald-400 font-mono">${row.playtimeFormatted || "0m"}</td>
            <td class="py-2.5 text-amber-400 font-mono">${row.afkFormatted || "0m"}</td>
            <td class="py-2.5 text-red-400 font-mono">${row.deathsCount || 0}</td>
            <td class="py-2.5 text-cyan-400 font-mono">${row.distanceFormatted || "0m"}</td>
          </tr>
        `).join('');
      }
    }

    // 2. Recent Deaths List
    const deathsList = document.getElementById("telemetry-deaths-list");
    if (deathsList) {
      const deaths = data.deaths || [];
      if (deaths.length === 0) {
        deathsList.innerHTML = `<p class="text-gray-500 italic">No recent deaths recorded.</p>`;
      } else {
        deathsList.innerHTML = deaths.map(d => `
          <div class="bg-[#0b0e14] border border-[#1e2638] p-2.5 rounded-lg flex items-center justify-between">
            <div class="flex items-center gap-2">
              <i class="fa-solid fa-skull text-red-400"></i>
              <div>
                <span class="text-white font-bold">${d.name || d.steamId}</span>
                <span class="text-gray-400 text-[10px] block font-mono">Sector: <b class="text-cyan-400">${d.grid || 'Unknown'}</b> (${Math.round(d.x || 0)}, ${Math.round(d.y || 0)})</span>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-gray-500 text-[10px] font-mono">${d.timeAgo || new Date(d.timestamp).toLocaleTimeString()}</span>
              <button onclick="focusPlayerOnMap(${d.x || 0}, ${d.y || 0})" class="bg-[#141b29] hover:bg-cyan-950 text-cyan-300 border border-[#222e44] px-2 py-1 rounded text-[10px] font-mono">
                <i class="fa-solid fa-location-dot mr-1"></i>Map
              </button>
            </div>
          </div>
        `).join('');
      }
    }

    renderTeamInfo();
    renderClanAlumni();
  } catch (err) {
    console.error("loadTeamTelemetryData error:", err);
  }
}

function focusPlayerOnMap(x, y) {
  if (x === undefined || y === undefined) return;
  switchTab("map");
  setTimeout(() => {
    if (!mapCanvas) return;
    const mapSize = state.serverInfo?.mapSize || 4500;
    const imgW = state.mapImage?.naturalWidth || 2000;
    const imgH = state.mapImage?.naturalHeight || 2000;
    const oceanMargin = state.mapData?.oceanMargin || (imgW * 0.08);
    const playableW = imgW - 2 * oceanMargin;
    const playableH = imgH - 2 * oceanMargin;
    const targetImgX = oceanMargin + (Number(x) * (playableW / mapSize));
    const targetImgY = imgH - (oceanMargin + (Number(y) * (playableH / mapSize)));

    state.mapScale = 2.0;
    state.mapOffsetX = (mapCanvas.width / 2) - (targetImgX * state.mapScale);
    state.mapOffsetY = (mapCanvas.height / 2) - (targetImgY * state.mapScale);
    redrawMap();
    showToast(`Centered map on (${Math.round(x)}, ${Math.round(y)})`, "info");
  }, 100);
}

async function loadNotesData() {
  try {
    const res = await fetch("/api/notes");
    if (!res.ok) return;
    const data = await res.json();
    state.notes = data.notes || [];

    const grid = document.getElementById("team-notes-grid");
    if (grid) {
      if (state.notes.length === 0) {
        grid.innerHTML = `<p class="text-gray-500 italic col-span-full">No team notes saved. Add one above or type !note &lt;name&gt; &lt;text&gt; in chat.</p>`;
      } else {
        grid.innerHTML = state.notes.map(note => `
          <div class="bg-[#0b0e14] border border-[#1e2638] rounded-xl p-3.5 flex flex-col justify-between gap-2">
            <div class="flex items-center justify-between border-b border-[#182133] pb-1.5">
              <span class="text-amber-400 font-bold uppercase text-xs flex items-center gap-1.5">
                <i class="fa-solid fa-tag"></i> ${note.name}
              </span>
              <button onclick="handleDeleteNote('${encodeURIComponent(note.name)}')" class="text-gray-500 hover:text-red-400 text-xs">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
            <p class="text-gray-200 text-xs break-words">${note.text}</p>
            <div class="flex items-center justify-between text-[10px] text-gray-500 pt-1 border-t border-[#182133]">
              <span>By: ${note.author || "Teammate"}</span>
              <span>${note.timestamp ? new Date(note.timestamp).toLocaleDateString() : ""}</span>
            </div>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.error("loadNotesData error:", err);
  }
}

async function handleAddNote(e) {
  e.preventDefault();
  const nameInput = document.getElementById("note-input-name");
  const textInput = document.getElementById("note-input-text");
  const name = nameInput.value.trim();
  const text = textInput.value.trim();
  if (!name || !text) return;

  try {
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, text })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to add note");
    nameInput.value = "";
    textInput.value = "";
    showToast(`Note "${name}" saved!`, "success");
    await loadNotesData();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function handleDeleteNote(rawName) {
  const name = decodeURIComponent(rawName);
  try {
    const res = await fetch(`/api/notes/${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to delete note");
    showToast(`Note "${name}" removed`, "info");
    await loadNotesData();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ==========================================
// 9. TACTICAL CALCULATORS
// ==========================================
function switchCalcSubtab(sub) {
  ["raid", "craft", "turret"].forEach(k => {
    const panel = document.getElementById(`calc-panel-${k}`);
    const btn = document.getElementById(`calc-subtab-${k}`);
    if (panel) {
      if (k === sub) {
        panel.classList.remove("hidden");
      } else {
        panel.classList.add("hidden");
      }
    }
    if (btn) {
      if (k === sub) {
        btn.className = "calc-subtab-btn active px-3.5 py-2 rounded-lg text-xs font-rust uppercase font-bold text-white bg-rust-700/80 border border-rust-500 transition";
      } else {
        btn.className = "calc-subtab-btn px-3.5 py-2 rounded-lg text-xs font-rust uppercase font-bold text-gray-400 hover:text-white hover:bg-[#141b29] border border-transparent transition";
      }
    }
  });

  if (sub === "raid") updateRaidCalculator();
  else if (sub === "craft") { updateCraftCalculator(); updateRecycleCalculator(); }
  else if (sub === "turret") loadTurrets();
}

function loadCalculatorsData() {
  updateRaidCalculator();
  updateCraftCalculator();
  updateRecycleCalculator();
  loadTurrets();
}

async function updateRaidCalculator() {
  const select = document.getElementById("calc-raid-target-select");
  if (!select) return;
  const target = select.value;

  try {
    const res = await fetch(`/api/calc/durability?target=${encodeURIComponent(target)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Durability fetch error");

    const info = data.durability;
    if (!info) return;

    const elC4 = document.getElementById("raid-c4-count");
    const elC4Sulfur = document.getElementById("raid-c4-sulfur");
    const elRocket = document.getElementById("raid-rocket-count");
    const elRocketSulfur = document.getElementById("raid-rocket-sulfur");
    const elSatchel = document.getElementById("raid-satchel-count");
    const elSatchelSulfur = document.getElementById("raid-satchel-sulfur");
    const elExplo = document.getElementById("raid-explo-count");
    const elExploSulfur = document.getElementById("raid-explo-sulfur");

    if (elC4) elC4.textContent = info.c4 ?? "--";
    if (elC4Sulfur) elC4Sulfur.textContent = info.c4 ? `Raw Sulfur: ${(info.c4 * 2200).toLocaleString()}` : "N/A";

    if (elRocket) elRocket.textContent = info.rockets ?? "--";
    if (elRocketSulfur) elRocketSulfur.textContent = info.rockets ? `Raw Sulfur: ${(info.rockets * 1400).toLocaleString()}` : "N/A";

    if (elSatchel) elSatchel.textContent = info.satchels ?? "--";
    if (elSatchelSulfur) elSatchelSulfur.textContent = info.satchels ? `Raw Sulfur: ${(info.satchels * 480).toLocaleString()}` : "N/A";

    if (elExplo) elExplo.textContent = info.explo556 ?? "--";
    if (elExploSulfur) elExploSulfur.textContent = info.explo556 ? `Raw Sulfur: ${(Math.round(info.explo556 * 12.5)).toLocaleString()}` : "N/A";

    const meleeDiv = document.getElementById("raid-melee-breakdown");
    if (meleeDiv) {
      meleeDiv.innerHTML = `
        <div>Hard-side Pickaxes: <b class="text-amber-400">${info.pickaxesHard ?? 'Immune / Ineffective'}</b></div>
        <div>Soft-side Pickaxes: <b class="text-emerald-400">${info.pickaxesSoft ?? 'N/A'}</b></div>
        <div>Hard-side Spears: <b class="text-amber-400">${info.spearsHard ?? 'Immune'}</b></div>
        <div>Soft-side Spears: <b class="text-emerald-400">${info.spearsSoft ?? 'N/A'}</b></div>
      `;
    }

    const bulletDiv = document.getElementById("raid-bullet-breakdown");
    if (bulletDiv) {
      bulletDiv.innerHTML = `
        <div>HV Rockets: <b class="text-cyan-400">${info.hvRockets ?? 'Ineffective'}</b></div>
        <div>MLRS Rockets: <b class="text-red-400">${info.mlrsRockets ?? 'N/A'}</b></div>
        <div>HE Grenades: <b class="text-yellow-400">${info.heGrenades ?? 'N/A'}</b></div>
        <div>12 Gauge Incendiary: <b class="text-orange-400">${info.shotgunIncendiary ?? 'Immune'}</b></div>
      `;
    }
  } catch (err) {
    console.error("updateRaidCalculator error:", err);
  }
}

async function updateCraftCalculator() {
  const itemSelect = document.getElementById("calc-craft-item");
  const qtyInput = document.getElementById("calc-craft-qty");
  const resultsCard = document.getElementById("craft-results-card");
  if (!itemSelect || !qtyInput || !resultsCard) return;

  const item = itemSelect.value;
  const qty = parseInt(qtyInput.value) || 1;

  try {
    const res = await fetch(`/api/calc/craft?item=${encodeURIComponent(item)}&qty=${qty}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Craft fetch error");

    const craft = data.craft;
    resultsCard.innerHTML = `
      <div class="flex items-center justify-between border-b border-[#1c2436] pb-2 mb-2">
        <span class="text-white font-bold text-sm uppercase">${qty}x ${craft.name || item}</span>
        <span class="text-cyan-400 text-xs">Workbench Tier: <b>${craft.workbench || 0}</b></span>
      </div>
      <div class="text-gray-400 mb-2">Total Craft Time: <b class="text-amber-300">${craft.totalCraftTime || "0s"}</b></div>
      <div class="grid grid-cols-2 gap-2">
        ${Object.entries(craft.ingredients || {}).map(([ing, amt]) => `
          <div class="bg-[#121722] border border-[#1e2638] px-2.5 py-1.5 rounded flex items-center justify-between">
            <span class="text-gray-300 capitalize">${ing.replace(/_/g, ' ')}</span>
            <span class="text-amber-400 font-bold">${amt.toLocaleString()}</span>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    resultsCard.innerHTML = `<p class="text-red-400">${err.message}</p>`;
  }
}

async function updateRecycleCalculator() {
  const itemSelect = document.getElementById("calc-recycle-item");
  const qtyInput = document.getElementById("calc-recycle-qty");
  const safezoneCheck = document.getElementById("calc-recycle-safezone");
  const resultsCard = document.getElementById("recycle-results-card");
  if (!itemSelect || !qtyInput || !resultsCard) return;

  const item = itemSelect.value;
  const qty = parseInt(qtyInput.value) || 1;
  const isSafezone = safezoneCheck ? safezoneCheck.checked : false;

  try {
    const res = await fetch(`/api/calc/recycle?item=${encodeURIComponent(item)}&qty=${qty}&safezone=${isSafezone}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Recycle fetch error");

    const rec = data.recycle;
    resultsCard.innerHTML = `
      <div class="flex items-center justify-between border-b border-[#1c2436] pb-2 mb-2">
        <span class="text-white font-bold text-sm uppercase">${qty}x ${rec.name || item}</span>
        <span class="text-[10px] px-2 py-0.5 rounded font-mono ${isSafezone ? 'bg-amber-950 text-amber-300 border border-amber-800' : 'bg-emerald-950 text-emerald-300 border border-emerald-800'}">
          ${isSafezone ? "Safe Zone (80% Yield)" : "Monument (100% Full Yield)"}
        </span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        ${Object.entries(rec.yield || {}).map(([ing, amt]) => `
          <div class="bg-[#121722] border border-[#1e2638] px-2.5 py-1.5 rounded flex items-center justify-between">
            <span class="text-gray-300 capitalize">${ing.replace(/_/g, ' ')}</span>
            <span class="text-emerald-400 font-bold">+${amt.toLocaleString()}</span>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    resultsCard.innerHTML = `<p class="text-red-400">${err.message}</p>`;
  }
}

async function loadTurrets() {
  try {
    const res = await fetch("/api/calc/turrets");
    if (!res.ok) return;
    const data = await res.json();
    const turrets = data.turrets || [];

    const tbody = document.getElementById("turrets-table-body");
    const alertDiv = document.getElementById("turret-overlap-alert");

    let hasCollision = false;
    let collisionPairs = [];

    if (tbody) {
      if (turrets.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-gray-500 italic">No turrets recorded yet. Add one above or use !turret-add in-game.</td></tr>`;
      } else {
        tbody.innerHTML = turrets.map((t, idx) => {
          const conflicts = [];
          for (let j = 0; j < turrets.length; j++) {
            if (idx !== j) {
              const dx = t.x - turrets[j].x;
              const dy = t.y - turrets[j].y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 40) {
                conflicts.push({ name: turrets[j].name, dist: Math.round(dist * 10) / 10 });
                if (idx < j) collisionPairs.push(`${t.name} & ${turrets[j].name} (${Math.round(dist * 10) / 10}m)`);
              }
            }
          }

          const hasConflict = conflicts.length > 0;
          if (hasConflict) hasCollision = true;

          return `
            <tr class="hover:bg-[#151c2a] transition">
              <td class="p-3 font-bold text-white flex items-center gap-2">
                <i class="fa-solid fa-crosshairs ${hasConflict ? 'text-red-400' : 'text-emerald-400'}"></i>
                ${t.name}
              </td>
              <td class="p-3 font-mono text-cyan-300">${t.x}</td>
              <td class="p-3 font-mono text-cyan-300">${t.y}</td>
              <td class="p-3 font-mono">
                ${hasConflict ? `
                  <span class="text-red-400 font-bold bg-red-950/60 border border-red-800 px-2 py-0.5 rounded text-[10px]">
                    ⚠️ Overlap: ${conflicts.map(c => `${c.name} (${c.dist}m)`).join(", ")}
                  </span>
                ` : `
                  <span class="text-emerald-400 font-bold bg-emerald-950/60 border border-emerald-800 px-2 py-0.5 rounded text-[10px]">
                    ✅ Clear (> 40m)
                  </span>
                `}
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    if (alertDiv) {
      if (turrets.length < 2) {
        alertDiv.classList.add("hidden");
      } else if (hasCollision) {
        alertDiv.className = "p-4 rounded-xl border border-red-800 bg-red-950/40 text-red-200 font-mono text-xs flex items-center gap-3";
        alertDiv.innerHTML = `
          <i class="fa-solid fa-triangle-exclamation text-red-400 text-lg"></i>
          <div>
            <b>Warning: 40m Turret Sphere Interference Detected!</b>
            <div class="text-[11px] text-red-300/80 mt-0.5">${collisionPairs.join(" | ")}</div>
          </div>
        `;
        alertDiv.classList.remove("hidden");
      } else {
        alertDiv.className = "p-4 rounded-xl border border-emerald-800 bg-emerald-950/40 text-emerald-200 font-mono text-xs flex items-center gap-3";
        alertDiv.innerHTML = `
          <i class="fa-solid fa-circle-check text-emerald-400 text-lg"></i>
          <div>
            <b>Optimal Spacing: All ${turrets.length} turrets have >= 40m clearance.</b>
            <div class="text-[11px] text-emerald-300/80 mt-0.5">No power penalties will occur.</div>
          </div>
        `;
        alertDiv.classList.remove("hidden");
      }
    }
  } catch (err) {
    console.error("loadTurrets error:", err);
  }
}

async function handleAddTurret(e) {
  e.preventDefault();
  const name = document.getElementById("turret-add-name")?.value.trim();
  const x = parseFloat(document.getElementById("turret-add-x")?.value);
  const y = parseFloat(document.getElementById("turret-add-y")?.value);
  if (!name || isNaN(x) || isNaN(y)) return;

  try {
    const res = await fetch("/api/calc/turrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, x, y })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to add turret");
    document.getElementById("turret-add-form")?.reset();
    showToast(`Turret "${name}" recorded at (${x}, ${y})`, "success");
    await loadTurrets();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function clearAllTurrets() {
  if (!confirm("Are you sure you want to clear all recorded turrets?")) return;
  try {
    const res = await fetch("/api/calc/turrets", { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to clear turrets");
    showToast("Turret list cleared", "info");
    await loadTurrets();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function fillTurretPlayerPos() {
  const members = state.teamInfo?.members || [];
  const leaderId = state.teamInfo?.leaderSteamId ? String(state.teamInfo.leaderSteamId) : null;
  const mySteamId = state.activeServer?.playerId ? String(state.activeServer.playerId) : null;

  const me = members.find(m => String(m.steamId) === mySteamId) || members.find(m => String(m.steamId) === leaderId) || members[0];
  if (me && me.x !== undefined && me.y !== undefined) {
    const xInput = document.getElementById("turret-add-x");
    const yInput = document.getElementById("turret-add-y");
    if (xInput) xInput.value = (Math.round(me.x * 10) / 10);
    if (yInput) yInput.value = (Math.round(me.y * 10) / 10);
    showToast(`Filled coords from ${me.name || 'player'}: (${Math.round(me.x)}, ${Math.round(me.y)})`, "info");
  } else {
    showToast("Could not determine current player position. Make sure team info is synced.", "warning");
  }
}

// ==========================================
// 10. INTEL & WEBUI AI CONSULTANT CHAT
// ==========================================
async function handleSteamLookup(e) {
  e.preventDefault();
  const input = document.getElementById("steam-lookup-input");
  const query = input?.value.trim();
  const resultDiv = document.getElementById("steam-lookup-result");
  const btn = document.getElementById("btn-steam-lookup");
  if (!query || !resultDiv) return;

  const origBtn = btn ? btn.innerHTML : "";
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

  try {
    const res = await fetch(`/api/intel/steam/${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to inspect Steam profile");

    const p = data.profile;
    resultDiv.classList.remove("hidden");
    resultDiv.innerHTML = `
      <div class="flex items-start gap-4">
        <img src="${p.avatar || 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg'}" class="w-14 h-14 rounded-xl border border-cyan-600 shadow-md">
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex items-center justify-between">
            <h4 class="text-base font-rust font-bold text-white truncate">${p.personaName || "Unknown Player"}</h4>
            <a href="${p.profileUrl || '#'}" target="_blank" class="text-cyan-400 hover:text-cyan-300 text-xs">Steam Profile <i class="fa-solid fa-arrow-up-right-from-square"></i></a>
          </div>
          <div class="text-[11px] text-gray-400">SteamID64: <code class="text-gray-200 font-bold">${p.steamId}</code></div>
          <div class="text-[11px] text-gray-400">Account Created: <span class="text-gray-300">${p.timeCreated ? new Date(p.timeCreated * 1000).toLocaleDateString() : "Private"}</span></div>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-2 pt-3 mt-3 border-t border-[#1c2436] text-center">
        <div class="bg-[#121722] p-2 rounded">
          <span class="text-[10px] uppercase text-gray-400 block">VAC Bans</span>
          <span class="font-bold text-sm ${p.numberOfVACBans > 0 ? 'text-red-400' : 'text-emerald-400'}">${p.numberOfVACBans || 0}</span>
        </div>
        <div class="bg-[#121722] p-2 rounded">
          <span class="text-[10px] uppercase text-gray-400 block">Game Bans</span>
          <span class="font-bold text-sm ${p.numberOfGameBans > 0 ? 'text-red-400' : 'text-emerald-400'}">${p.numberOfGameBans || 0}</span>
        </div>
        <div class="bg-[#121722] p-2 rounded">
          <span class="text-[10px] uppercase text-gray-400 block">Economy / Trade</span>
          <span class="font-bold text-sm ${p.economyBan === 'none' ? 'text-emerald-400' : 'text-red-400'}">${p.economyBan || 'Clean'}</span>
        </div>
      </div>
    `;
  } catch (err) {
    resultDiv.classList.remove("hidden");
    resultDiv.innerHTML = `<p class="text-red-400">${err.message}</p>`;
  } finally {
    if (btn) btn.innerHTML = origBtn;
  }
}

async function loadWatchlistData() {
  try {
    const res = await fetch("/api/intel/watchlist");
    if (!res.ok) return;
    const data = await res.json();
    const list = data.watchlist || [];

    const container = document.getElementById("watchlist-items-list");
    if (container) {
      if (list.length === 0) {
        container.innerHTML = `<p class="text-gray-500 italic">No enemies currently tracked.</p>`;
      } else {
        container.innerHTML = list.map(item => `
          <div class="bg-[#0b0e14] border border-[#1e2638] p-2 rounded flex items-center justify-between">
            <div class="flex items-center gap-2">
              <i class="fa-solid fa-crosshairs text-red-400"></i>
              <span class="text-white font-bold">${item.nameOrId || item.id}</span>
            </div>
            <button onclick="handleDeleteWatchlist('${encodeURIComponent(item.nameOrId || item.id)}')" class="text-gray-500 hover:text-red-400 text-xs">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.error("loadWatchlistData error:", err);
  }
}

async function handleAddWatchlist(e) {
  e.preventDefault();
  const input = document.getElementById("watchlist-input-name");
  const nameOrId = input?.value.trim();
  if (!nameOrId) return;

  try {
    const res = await fetch("/api/intel/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nameOrId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to add to watchlist");
    if (input) input.value = "";
    showToast(`Tracking enemy "${nameOrId}"!`, "success");
    await loadWatchlistData();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function handleDeleteWatchlist(rawId) {
  const nameOrId = decodeURIComponent(rawId);
  try {
    const res = await fetch(`/api/intel/watchlist/${encodeURIComponent(nameOrId)}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to remove from watchlist");
    showToast(`Removed "${nameOrId}" from watchlist`, "info");
    await loadWatchlistData();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function handleWebUiAiChat(e) {
  e.preventDefault();
  const input = document.getElementById("ai-chat-input");
  const chatBox = document.getElementById("ai-chat-box");
  const btn = document.getElementById("ai-chat-submit-btn");
  const question = input?.value.trim();
  if (!question || !chatBox) return;

  // Append user message
  const userMsgEl = document.createElement("div");
  userMsgEl.className = "flex items-start gap-2.5 justify-end";
  userMsgEl.innerHTML = `
    <div class="bg-rust-900/60 border border-rust-700 text-white p-2.5 rounded-xl max-w-lg text-xs break-words">
      ${escapeHtml(question)}
    </div>
    <div class="w-6 h-6 rounded-full bg-rust-700 flex items-center justify-center text-[10px] text-white flex-shrink-0">
      <i class="fa-solid fa-user"></i>
    </div>
  `;
  chatBox.appendChild(userMsgEl);
  if (input) input.value = "";
  chatBox.scrollTop = chatBox.scrollHeight;

  // Typing indicator
  const typingEl = document.createElement("div");
  typingEl.className = "flex items-start gap-2.5";
  typingEl.innerHTML = `
    <div class="w-6 h-6 rounded-full bg-purple-700 flex items-center justify-center text-[10px] text-white flex-shrink-0">
      <i class="fa-solid fa-robot"></i>
    </div>
    <div class="bg-[#121722] border border-[#1e2638] text-gray-400 p-2.5 rounded-xl text-xs flex items-center gap-2">
      <i class="fa-solid fa-spinner fa-spin"></i> Consulting tactical consultant...
    </div>
  `;
  chatBox.appendChild(typingEl);
  chatBox.scrollTop = chatBox.scrollHeight;

  const origBtnHtml = btn ? btn.innerHTML : "";
  if (btn) btn.disabled = true;

  try {
    const res = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question })
    });
    const data = await res.json();
    typingEl.remove();

    if (!res.ok) throw new Error(data.error || "AI Assistant query failed");

    const aiMsgEl = document.createElement("div");
    aiMsgEl.className = "flex items-start gap-2.5";
    aiMsgEl.innerHTML = `
      <div class="w-6 h-6 rounded-full bg-purple-700 flex items-center justify-center text-[10px] text-white flex-shrink-0">
        <i class="fa-solid fa-robot"></i>
      </div>
      <div class="bg-[#121722] border border-purple-900/60 text-gray-200 p-3 rounded-xl max-w-lg text-xs leading-relaxed break-words shadow">
        ${escapeHtml(data.response || "No response received.")}
      </div>
    `;
    chatBox.appendChild(aiMsgEl);
    chatBox.scrollTop = chatBox.scrollHeight;
  } catch (err) {
    typingEl.remove();
    const errEl = document.createElement("div");
    errEl.className = "text-red-400 text-xs italic p-1";
    errEl.textContent = `Error: ${err.message}`;
    chatBox.appendChild(errEl);
    chatBox.scrollTop = chatBox.scrollHeight;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origBtnHtml;
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ==========================================
// 9. COMPOUND LOCKDOWN & WEB AUDIO SIREN
// ==========================================
let audioCtx = null;
let sirenOsc = null;
let sirenGain = null;
let isSirenPlaying = false;
let isAudioMuted = false;

function initAudio() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
}

function playRaidSiren() {
  if (isAudioMuted || isSirenPlaying) return;
  try {
    initAudio();
    if (!audioCtx) return;
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    isSirenPlaying = true;
    sirenOsc = audioCtx.createOscillator();
    sirenGain = audioCtx.createGain();
    sirenOsc.type = "sawtooth";
    sirenGain.gain.setValueAtTime(0.25, audioCtx.currentTime);

    const now = audioCtx.currentTime;
    sirenOsc.frequency.setValueAtTime(650, now);
    for (let i = 0; i < 20; i++) {
      sirenOsc.frequency.linearRampToValueAtTime(1150, now + i * 1.0 + 0.5);
      sirenOsc.frequency.linearRampToValueAtTime(650, now + i * 1.0 + 1.0);
    }

    sirenOsc.connect(sirenGain);
    sirenGain.connect(audioCtx.destination);
    sirenOsc.start();

    setTimeout(() => stopRaidSiren(), 15000);
  } catch (e) {
    console.warn("[Siren] Playback error:", e);
  }
}

function stopRaidSiren() {
  if (!isSirenPlaying) return;
  try {
    if (sirenOsc) {
      sirenOsc.stop();
      sirenOsc.disconnect();
      sirenOsc = null;
    }
  } catch (e) {}
  isSirenPlaying = false;
}

function toggleAudioMute() {
  isAudioMuted = !isAudioMuted;
  const icon = document.getElementById("icon-audio-mute");
  if (isAudioMuted) {
    stopRaidSiren();
    if (icon) icon.className = "fa-solid fa-volume-xmark text-red-400";
    showToast("Siren audio muted 🔇", "info");
  } else {
    initAudio();
    if (icon) icon.className = "fa-solid fa-volume-high text-emerald-400";
    showToast("Siren audio unmuted 🔊", "success");
  }
}

async function toggleCompoundLockdown() {
  const isCurrentlyActive = state.lockdownActive;
  if (!isCurrentlyActive) {
    if (!confirm("🚨 EMERGENCY: Activate Compound Lockdown? This will turn ON all Auto-Turrets, SAM sites, CLOSE all doors, and sound base alarms!")) return;
    try {
      showToast("Activating compound lockdown...", "warning");
      const res = await fetch("/api/base/lockdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "on", reason: "WebUI Manual Alert" })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lockdown trigger failed");
      showToast("🚨 COMPOUND LOCKDOWN ACTIVATED!", "error");
      handleLockdownState({ active: true, alarmName: "Manual Squad Lockdown" });
    } catch (err) {
      showToast(err.message, "error");
    }
  } else {
    cancelCompoundLockdown();
  }
}

async function cancelCompoundLockdown() {
  try {
    const res = await fetch("/api/base/lockdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "off" })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Cancel lockdown failed");
    stopRaidSiren();
    showToast("🟢 Compound lockdown cancelled. Stand down.", "success");
    handleLockdownState({ active: false });
  } catch (err) {
    showToast(err.message, "error");
  }
}

function handleLockdownState(data) {
  state.lockdownActive = !!data.active;
  const banner = document.getElementById("lockdown-banner");
  const bannerText = document.getElementById("lockdown-banner-text");
  const btn = document.getElementById("btn-lockdown");
  const label = document.getElementById("label-lockdown");

  if (data.active) {
    if (banner) {
      banner.classList.remove("hidden");
      if (bannerText) {
        bannerText.textContent = `🚨 ${data.alarmName || "Base Alarm"} triggered! Turrets: ON | SAMs: ON | Doors: CLOSED.`;
      }
    }
    if (btn) {
      btn.className = "bg-red-600 hover:bg-red-500 text-white border border-red-400 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition font-rust uppercase font-bold tracking-wider text-xs shadow-lg animate-pulse";
    }
    if (label) label.textContent = "STAND DOWN";
    playRaidSiren();
  } else {
    if (banner) banner.classList.add("hidden");
    if (btn) {
      btn.className = "bg-red-950/70 hover:bg-red-900 text-red-300 hover:text-white border border-red-700/80 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition font-rust uppercase font-bold tracking-wider text-xs shadow";
    }
    if (label) label.textContent = "Lockdown";
    stopRaidSiren();
  }
}

// ==========================================
// 10. SQUAD MANAGEMENT & RAID CALCULATOR
// ==========================================
function setSquadFilter(sq) {
  state.squadFilter = sq || "";
  document.querySelectorAll(".squad-filter-btn").forEach(b => {
    b.classList.remove("active", "bg-rust-700", "text-white", "font-bold");
    b.classList.add("bg-[#141b29]", "text-gray-300");
  });
  const activeBtn = document.getElementById(sq ? `squad-filter-${sq}` : "squad-filter-all");
  if (activeBtn) {
    activeBtn.classList.remove("bg-[#141b29]", "text-gray-300");
    activeBtn.classList.add("active", "bg-rust-700", "text-white", "font-bold");
  }
  renderClanAlumni();
}

async function promptAssignSquad(steamId, encodedName) {
  const name = decodeURIComponent(encodedName || steamId);
  const squad = prompt(`Assign squad for ${name}:\n(e.g. Alpha, Bravo, Roam, Farm, Defense, Pilots, or 'clear' to unassign)`, "Alpha");
  if (squad === null) return;

  try {
    const res = await fetch("/api/clan/squads/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steamId, squad })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to assign squad");
    showToast(data.message || `Assigned ${name} to squad!`, "success");
    if (typeof loadTeamTelemetryData === "function") {
      await loadTeamTelemetryData();
    }
    renderClanAlumni();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function addRaidTargetPreset(preset) {
  const input = document.getElementById("raid-calc-input");
  if (!input) return;
  const current = input.value.trim();
  if (!current) {
    input.value = preset;
  } else {
    input.value = `${current}, ${preset}`;
  }
}

function clearRaidTargetInput() {
  const input = document.getElementById("raid-calc-input");
  const res = document.getElementById("raid-calc-result");
  const badge = document.getElementById("raid-calc-status-badge");
  if (input) input.value = "";
  if (res) {
    res.innerHTML = "";
    res.classList.add("hidden");
  }
  if (badge) {
    badge.className = "px-2 py-0.5 rounded bg-dark-border text-gray-400";
    badge.textContent = "Ready";
  }
}

async function runRaidCalculator() {
  const input = document.getElementById("raid-calc-input");
  const resDiv = document.getElementById("raid-calc-result");
  const badge = document.getElementById("raid-calc-status-badge");
  const target = input?.value?.trim();
  if (!target) {
    showToast("Please enter target structure(s) to raid", "warning");
    return;
  }

  try {
    if (badge) {
      badge.className = "px-2 py-0.5 rounded bg-blue-950 text-blue-400 animate-pulse";
      badge.textContent = "Calculating...";
    }
    const res = await fetch("/api/clan/raid-calculator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || "Calculation failed");

    if (resDiv) {
      resDiv.classList.remove("hidden");
      const tot = data.totals || {};
      const arm = data.armory;

      let readinessHtml = "";
      if (arm) {
        if (arm.canRaidWithRockets) {
          readinessHtml = `<div class="p-2.5 rounded bg-emerald-950/70 border border-emerald-700 text-emerald-300 font-bold flex items-center justify-between">
            <span><i class="fa-solid fa-circle-check mr-1.5"></i> READY FOR ROCKET RAID!</span>
            <span class="text-xs">Armory: ${arm.rocketsHave}/${arm.rocketsNeed} Rockets</span>
          </div>`;
          if (badge) {
            badge.className = "px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 font-bold border border-emerald-800";
            badge.textContent = "✅ Boom Ready";
          }
        } else if (arm.canRaidWithC4) {
          readinessHtml = `<div class="p-2.5 rounded bg-emerald-950/70 border border-emerald-700 text-emerald-300 font-bold flex items-center justify-between">
            <span><i class="fa-solid fa-circle-check mr-1.5"></i> READY FOR C4 RAID!</span>
            <span class="text-xs">Armory: ${arm.c4Have}/${arm.c4Need} C4</span>
          </div>`;
          if (badge) {
            badge.className = "px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 font-bold border border-emerald-800";
            badge.textContent = "✅ Boom Ready";
          }
        } else if (arm.canRaidWithTotalSulfur) {
          readinessHtml = `<div class="p-2.5 rounded bg-amber-950/70 border border-amber-700 text-amber-300 font-bold flex items-center justify-between">
            <span><i class="fa-solid fa-triangle-exclamation mr-1.5"></i> CRAFTING REQUIRED (Sulfur is available)</span>
            <span class="text-xs">Have: ${arm.sulfurHave.toLocaleString()} / Need: ${arm.sulfurNeed.toLocaleString()} S</span>
          </div>`;
          if (badge) {
            badge.className = "px-2 py-0.5 rounded bg-amber-950 text-amber-400 font-bold border border-amber-800";
            badge.textContent = "🟡 Crafting Ready";
          }
        } else {
          const shortRockets = Math.max(0, arm.rocketsNeed - arm.rocketsHave);
          const shortSulfur = Math.max(0, arm.sulfurNeed - arm.sulfurHave);
          readinessHtml = `<div class="p-2.5 rounded bg-red-950/70 border border-red-800 text-red-300 font-bold flex items-center justify-between">
            <span><i class="fa-solid fa-circle-xmark mr-1.5"></i> SHORT ON BOOM</span>
            <span class="text-xs">Need +${shortRockets} Rockets or +${shortSulfur.toLocaleString()} Sulfur</span>
          </div>`;
          if (badge) {
            badge.className = "px-2 py-0.5 rounded bg-red-950 text-red-400 font-bold border border-red-800";
            badge.textContent = "❌ Short on Boom";
          }
        }
      }

      resDiv.innerHTML = `
        <div class="flex items-center justify-between border-b border-[#222e44] pb-2">
          <span class="text-white font-bold">${escapeHtml(data.query)}</span>
          <span class="text-gray-400">${(tot.minSulfur || 0).toLocaleString()} Raw Sulfur Cost</span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center pt-1">
          <div class="bg-[#0b0e14] p-2 rounded border border-[#1e2638]">
            <span class="text-[10px] text-gray-400 uppercase block">🚀 Rockets</span>
            <span class="text-base font-bold text-amber-400">${tot.rockets || 0}x</span>
            <span class="text-[10px] text-gray-500 block">~${(tot.sulfurRockets || 0).toLocaleString()} S</span>
          </div>
          <div class="bg-[#0b0e14] p-2 rounded border border-[#1e2638]">
            <span class="text-[10px] text-gray-400 uppercase block">💥 C4</span>
            <span class="text-base font-bold text-red-400">${tot.c4 || 0}x</span>
            <span class="text-[10px] text-gray-500 block">~${(tot.sulfurC4 || 0).toLocaleString()} S</span>
          </div>
          <div class="bg-[#0b0e14] p-2 rounded border border-[#1e2638]">
            <span class="text-[10px] text-gray-400 uppercase block">🧨 Satchels</span>
            <span class="text-base font-bold text-orange-400">${tot.satchels || 0}x</span>
          </div>
          <div class="bg-[#0b0e14] p-2 rounded border border-[#1e2638]">
            <span class="text-[10px] text-gray-400 uppercase block">💥 Explo 5.56</span>
            <span class="text-base font-bold text-yellow-400">${(tot.explo || 0).toLocaleString()}x</span>
          </div>
        </div>
        ${readinessHtml}
      `;
    }
  } catch (err) {
    if (badge) {
      badge.className = "px-2 py-0.5 rounded bg-red-950 text-red-400";
      badge.textContent = "Error";
    }
    showToast(err.message, "error");
  }
}

// Expose all functions to window for DOM onclick attributes
window.loadStorageAndUpkeepData = loadStorageAndUpkeepData;
window.refreshStorageData = refreshStorageData;
window.handleStorageSearch = handleStorageSearch;
window.calculateBoxRecycle = calculateBoxRecycle;
window.toggleContainerMonitor = toggleContainerMonitor;

window.loadAutomationData = loadAutomationData;
window.openAutomationModal = openAutomationModal;
window.saveAutoOffRule = saveAutoOffRule;
window.clearAutoRuleCurrent = clearAutoRuleCurrent;
window.saveDayNightRule = saveDayNightRule;
window.saveTeamOfflineRule = saveTeamOfflineRule;
window.executeTimedToggle = executeTimedToggle;
window.handleSamDelayChange = handleSamDelayChange;
window.handleSamVoiceToggle = handleSamVoiceToggle;

window.loadTeamTelemetryData = loadTeamTelemetryData;
window.focusPlayerOnMap = focusPlayerOnMap;
window.loadNotesData = loadNotesData;
window.handleAddNote = handleAddNote;
window.handleDeleteNote = handleDeleteNote;

window.switchCalcSubtab = switchCalcSubtab;
window.loadCalculatorsData = loadCalculatorsData;
window.updateRaidCalculator = updateRaidCalculator;
window.updateCraftCalculator = updateCraftCalculator;
window.updateRecycleCalculator = updateRecycleCalculator;
window.loadTurrets = loadTurrets;
window.handleAddTurret = handleAddTurret;
window.clearAllTurrets = clearAllTurrets;
window.fillTurretPlayerPos = fillTurretPlayerPos;

window.handleSteamLookup = handleSteamLookup;
window.loadWatchlistData = loadWatchlistData;
window.handleAddWatchlist = handleAddWatchlist;
window.handleDeleteWatchlist = handleDeleteWatchlist;
window.handleWebUiAiChat = handleWebUiAiChat;

window.playRaidSiren = playRaidSiren;
window.stopRaidSiren = stopRaidSiren;
window.toggleAudioMute = toggleAudioMute;
window.toggleCompoundLockdown = toggleCompoundLockdown;
window.cancelCompoundLockdown = cancelCompoundLockdown;
window.setSquadFilter = setSquadFilter;
window.promptAssignSquad = promptAssignSquad;
window.addRaidTargetPreset = addRaidTargetPreset;
window.clearRaidTargetInput = clearRaidTargetInput;
window.runRaidCalculator = runRaidCalculator;
window.redrawMap = redrawMap;
