/**
 * Storage Monitor & Tool Cupboard Tracker
 * Manages:
 * - Querying Storage Monitor contents & capacity
 * - Searching containers (!contains, !containsi)
 * - Container contents listing (!contents, !contentsi)
 * - Tool Cupboard upkeep calculation (!upkeep)
 * - Decaying alerts & low upkeep notifications
 * - Recycled box contents calculator (!recbox)
 * - Real-time item diff monitoring (!monitor)
 */

class StorageTracker {
  constructor(rustClient, matrixClient) {
    this.rustClient = rustClient;
    this.matrixClient = matrixClient;

    // Cache of entityId -> { name, capacity, items: [{ itemId, quantity, name, shortname }], lastUpdate }
    this.containers = new Map();
    this.monitoredContainers = new Set(); // entityIds actively monitored for item diffs
    this.decayAlertSent = new Set(); // entityIds that already sent decay alert

    this.initListeners();
  }

  initListeners() {
    // Listen for entity broadcasts
    this.rustClient.on("entityChanged", ({ entityId, payload }) => {
      if (payload && Array.isArray(payload.items)) {
        this.updateContainerData(entityId, payload);
      }
    });

    // Check TC upkeep every 5 minutes
    setInterval(() => {
      this.checkUpkeepAlerts();
    }, 300000);
  }

  getPairedStorageMonitors() {
    if (!this.rustClient.activeServer) return [];
    // Check server switches and alarms or generic entity list
    const server = this.rustClient.activeServer;
    const storages = (server.storageMonitors || []).concat(
      (server.alarms || []).filter(a => a.type === "storage" || a.name.toLowerCase().includes("tc") || a.name.toLowerCase().includes("box"))
    );
    return storages;
  }

  updateContainerData(entityId, payload) {
    const eId = Number(entityId);
    const existing = this.containers.get(eId);
    const items = (payload.items || []).map(i => {
      const info = this.rustClient.getItemInfo(i.itemId);
      return {
        itemId: i.itemId,
        quantity: i.quantity,
        itemIsBlueprint: !!i.itemIsBlueprint,
        name: info.name,
        shortname: info.shortname
      };
    });

    // Find custom paired name if any
    let pairedName = existing?.name || `Container ${eId}`;
    const allPaired = this.getPairedStorageMonitors();
    const match = allPaired.find(p => Number(p.id) === eId);
    if (match) pairedName = match.name;

    // Item diff monitoring
    if (this.monitoredContainers.has(eId) && existing) {
      this.diffAndAnnounce(pairedName, existing.items, items);
    }

    this.containers.set(eId, {
      id: eId,
      name: pairedName,
      capacity: payload.capacity || 30,
      hasProtection: payload.hasProtection,
      protectionExpiry: payload.protectionExpiry, // TC upkeep timestamp in sec
      items,
      lastUpdate: Date.now()
    });

    // Check decay
    if (payload.hasProtection === false && !this.decayAlertSent.has(eId)) {
      this.decayAlertSent.add(eId);
      const title = `🚨 [TC DECAYING ALERT] ${pairedName}`;
      const msg = `Tool Cupboard "${pairedName}" is out of resources and base is DECAYING!`;
      console.warn(`[StorageTracker] ${msg}`);
      if (this.matrixClient) {
        this.matrixClient.sendRaidAlert(pairedName, eId, this.rustClient.activeServer?.name || "Server", {
          "Alert": "BASE DECAY DETECTED",
          "Status": "ZERO UPKEEP REMAINING"
        }).catch(() => {});
      }
    } else if (payload.hasProtection) {
      this.decayAlertSent.delete(eId);
    }
  }

  diffAndAnnounce(containerName, oldItems, newItems) {
    const oldMap = new Map();
    for (const item of oldItems) {
      oldMap.set(item.name, (oldMap.get(item.name) || 0) + item.quantity);
    }
    const newMap = new Map();
    for (const item of newItems) {
      newMap.set(item.name, (newMap.get(item.name) || 0) + item.quantity);
    }

    const diffs = [];
    for (const [name, qty] of newMap.entries()) {
      const oldQty = oldMap.get(name) || 0;
      if (qty > oldQty) {
        diffs.push(`+${qty - oldQty}x ${name}`);
      } else if (qty < oldQty) {
        diffs.push(`-${oldQty - qty}x ${name}`);
      }
    }
    for (const [name, oldQty] of oldMap.entries()) {
      if (!newMap.has(name)) {
        diffs.push(`-${oldQty}x ${name}`);
      }
    }

    if (diffs.length > 0) {
      const msg = `📦 [${containerName} Monitor] ${diffs.join(", ")}`;
      console.log(`[StorageMonitor] ${msg}`);
      if (this.matrixClient) {
        this.matrixClient.sendAlert(`📦 Storage Update: ${containerName}`, diffs.join(", "));
      }
    }
  }

  async fetchEntity(entityId) {
    if (!this.rustClient.client || !this.rustClient.client.isConnected()) return null;
    return new Promise((resolve) => {
      try {
        this.rustClient.client.getEntityInfo(Number(entityId), (res) => {
          if (res?.response?.entityInfo?.payload) {
            this.updateContainerData(entityId, res.response.entityInfo.payload);
            resolve(this.containers.get(Number(entityId)));
          } else {
            resolve(null);
          }
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  findContainer(query) {
    const q = String(query || "").toLowerCase().trim();
    const idNum = Number(q);
    if (!isNaN(idNum) && this.containers.has(idNum)) {
      return this.containers.get(idNum);
    }
    for (const c of this.containers.values()) {
      if (c.name.toLowerCase() === q || c.name.toLowerCase().includes(q)) {
        return c;
      }
    }
    return null;
  }

  // --- COMMAND HANDLERS ---

  async getContents(nameOrId, withIcons = false) {
    if (!this.rustClient.client?.isConnected()) return "⚠️ Not connected to Rust server.";
    let container = this.findContainer(nameOrId);

    // If not cached, attempt refresh
    if (!container) {
      const idNum = Number(nameOrId);
      if (!isNaN(idNum)) {
        container = await this.fetchEntity(idNum);
      }
    }

    if (!container) {
      return `⚠️ Storage monitor "${nameOrId}" not found. Pair it with the Wire Tool first!`;
    }

    if (!container.items || container.items.length === 0) {
      return `📦 [${container.name}] Container is completely EMPTY (0/${container.capacity} slots).`;
    }

    const itemsSummary = container.items.map(i => `${i.quantity}x ${i.name}`).join(", ");
    return `📦 [${container.name} (${container.items.length}/${container.capacity} slots)] ${itemsSummary}`;
  }

  searchContains(itemName, withIcons = false) {
    const q = String(itemName || "").toLowerCase().trim();
    if (!q) return "Usage: !contains <item name>";

    const matches = [];
    for (const c of this.containers.values()) {
      let totalCount = 0;
      for (const item of c.items || []) {
        if (item.name.toLowerCase().includes(q) || item.shortname.toLowerCase().includes(q)) {
          totalCount += item.quantity;
        }
      }
      if (totalCount > 0) {
        matches.push({ container: c.name, count: totalCount });
      }
    }

    if (matches.length === 0) {
      return `📦 No paired containers found containing "${itemName}".`;
    }

    matches.sort((a, b) => b.count - a.count);
    const list = matches.map(m => `"${m.container}": ${m.count.toLocaleString()}x`).join(" | ");
    return `🔍 [Contains: "${itemName}"] Found in: ${list}`;
  }

  getUpkeep(nameOrId) {
    const tcs = [];
    for (const c of this.containers.values()) {
      if (c.protectionExpiry !== undefined || c.name.toLowerCase().includes("tc") || c.name.toLowerCase().includes("cupboard")) {
        tcs.push(c);
      }
    }

    if (tcs.length === 0) {
      return "ℹ️ No paired Tool Cupboards detected. Pair a Storage Monitor to your TC!";
    }

    const list = tcs.map(tc => {
      if (tc.protectionExpiry) {
        const remainingSec = Math.max(0, tc.protectionExpiry - Math.floor(Date.now() / 1000));
        const hours = (remainingSec / 3600).toFixed(1);
        const days = (remainingSec / 86400).toFixed(1);
        const status = remainingSec > 0 ? `🟢 ${days}d (${hours}h)` : "🔴 DECAYING";
        return `"${tc.name}": ${status}`;
      } else {
        // Fallback: estimate from items inside
        const wood = tc.items.find(i => i.shortname === "wood")?.quantity || 0;
        const stone = tc.items.find(i => i.shortname === "stones")?.quantity || 0;
        const metal = tc.items.find(i => i.shortname === "metal.fragments")?.quantity || 0;
        const hqm = tc.items.find(i => i.shortname === "metal.refined")?.quantity || 0;
        return `"${tc.name}": ${wood}w, ${stone}s, ${metal}m, ${hqm}hqm`;
      }
    }).join(" | ");

    return `🛡️ [TC Upkeep] ${list}`;
  }

  getRecycleBox(nameOrId, isSafeZone = false) {
    const container = this.findContainer(nameOrId);
    if (!container) return `⚠️ Container "${nameOrId}" not found.`;
    if (!container.items || container.items.length === 0) return `📦 "${container.name}" is empty.`;

    const { GameDatabase } = require("./game-database");
    let totalScrap = 0;
    let totalHqm = 0;
    let totalMetal = 0;
    let totalCloth = 0;

    for (const item of container.items) {
      const rec = GameDatabase.getRecycle(`${item.quantity} ${item.name}`, isSafeZone);
      // Parse scrap, hqm, metal
      const scrapMatch = rec.match(/(\d+)x scrap/);
      if (scrapMatch) totalScrap += parseInt(scrapMatch[1], 10);
      const hqmMatch = rec.match(/(\d+)x hqm/);
      if (hqmMatch) totalHqm += parseInt(hqmMatch[1], 10);
      const metalMatch = rec.match(/(\d+)x metalFragments/);
      if (metalMatch) totalMetal += parseInt(metalMatch[1], 10);
      const clothMatch = rec.match(/(\d+)x cloth/);
      if (clothMatch) totalCloth += parseInt(clothMatch[1], 10);
    }

    const loc = isSafeZone ? "Safe Zone (80%)" : "Monument (100%)";
    return `♻️ [Recycle Yield: "${container.name}" @ ${loc}] Scrap: ${totalScrap.toLocaleString()} | HQM: ${totalHqm} | Metal: ${totalMetal.toLocaleString()} | Cloth: ${totalCloth}`;
  }

  toggleMonitor(nameOrId) {
    const container = this.findContainer(nameOrId);
    if (!container) return `⚠️ Container "${nameOrId}" not found.`;

    if (this.monitoredContainers.has(container.id)) {
      this.monitoredContainers.delete(container.id);
      return `📦 Stopped monitoring changes for "${container.name}".`;
    } else {
      this.monitoredContainers.add(container.id);
      return `📦 Now monitoring item additions/removals for "${container.name}"!`;
    }
  }

  checkUpkeepAlerts() {
    for (const c of this.containers.values()) {
      if (c.protectionExpiry) {
        const remainingSec = c.protectionExpiry - Math.floor(Date.now() / 1000);
        if (remainingSec > 0 && remainingSec < 7200) { // Less than 2 hours left
          const hrs = (remainingSec / 3600).toFixed(1);
          if (this.matrixClient) {
            this.matrixClient.sendAlert(
              `⚠️ Low TC Upkeep Warning: ${c.name}`,
              `Tool Cupboard has only ${hrs} hours of upkeep remaining! Replenish resources soon.`
            );
          }
        }
      }
    }
  }

  getState() {
    const containerList = Array.from(this.containers.values()).map(c => {
      let upkeepHours = null;
      let upkeepDays = null;
      let isDecaying = false;
      if (c.protectionExpiry) {
        const remainingSec = Math.max(0, c.protectionExpiry - Math.floor(Date.now() / 1000));
        upkeepHours = parseFloat((remainingSec / 3600).toFixed(1));
        upkeepDays = parseFloat((remainingSec / 86400).toFixed(1));
        isDecaying = remainingSec <= 0;
      }
      return {
        ...c,
        isMonitored: this.monitoredContainers.has(c.id),
        upkeepHours,
        upkeepDays,
        isDecaying
      };
    });

    const tcs = containerList.filter(c => c.protectionExpiry !== undefined || c.name.toLowerCase().includes("tc") || c.name.toLowerCase().includes("cupboard"));

    return {
      containers: containerList,
      tcs,
      monitoredIds: Array.from(this.monitoredContainers)
    };
  }

  calculateRecycleYield(containerId, isSafeZone = false) {
    const container = this.containers.get(Number(containerId));
    if (!container) return null;
    const { GameDatabase } = require("./game-database");
    let totalScrap = 0;
    let totalHqm = 0;
    let totalMetal = 0;
    let totalCloth = 0;

    for (const item of container.items || []) {
      const rec = GameDatabase.getRecycle(`${item.quantity} ${item.name}`, isSafeZone);
      const scrapMatch = rec.match(/(\d+)x scrap/);
      if (scrapMatch) totalScrap += parseInt(scrapMatch[1], 10);
      const hqmMatch = rec.match(/(\d+)x hqm/);
      if (hqmMatch) totalHqm += parseInt(hqmMatch[1], 10);
      const metalMatch = rec.match(/(\d+)x metalFragments/);
      if (metalMatch) totalMetal += parseInt(metalMatch[1], 10);
      const clothMatch = rec.match(/(\d+)x cloth/);
      if (clothMatch) totalCloth += parseInt(clothMatch[1], 10);
    }

    return {
      containerId: container.id,
      name: container.name,
      isSafeZone: !!isSafeZone,
      scrap: totalScrap,
      hqm: totalHqm,
      metal: totalMetal,
      cloth: totalCloth
    };
  }

  getClanArmoryTotals() {
    const nowSec = Math.floor(Date.now() / 1000);

    const explosives = {
      rockets: 0,
      hvRockets: 0,
      fireRockets: 0,
      mlrsRockets: 0,
      c4: 0,
      satchels: 0,
      beancans: 0,
      f1Grenades: 0,
      exploAmmo: 0
    };

    const resources = {
      sulfur: 0,
      gunpowder: 0,
      explosivesComp: 0,
      metalFragments: 0,
      hqm: 0,
      lowGradeFuel: 0,
      scrap: 0
    };

    const tcs = [];

    for (const c of this.containers.values()) {
      const isTc = c.protectionExpiry !== undefined || c.name.toLowerCase().includes("tc") || c.name.toLowerCase().includes("cupboard");
      if (isTc) {
        let upkeepHours = null;
        let upkeepDays = null;
        let isDecaying = false;
        let status = "Unknown";
        if (c.protectionExpiry) {
          const rem = Math.max(0, c.protectionExpiry - nowSec);
          upkeepHours = parseFloat((rem / 3600).toFixed(1));
          upkeepDays = parseFloat((rem / 86400).toFixed(1));
          isDecaying = rem <= 0;
          status = isDecaying ? "🔴 Decaying" : (upkeepHours < 24 ? "🟡 Warning (<24h)" : "🟢 Protected");
        }

        let wood = 0, stones = 0, metal = 0, hqm = 0;
        for (const item of c.items || []) {
          const sn = (item.shortname || "").toLowerCase();
          if (sn === "wood") wood += item.quantity;
          else if (sn === "stones") stones += item.quantity;
          else if (sn === "metal.fragments") metal += item.quantity;
          else if (sn === "metal.refined") hqm += item.quantity;
        }

        tcs.push({
          id: c.id,
          name: c.name,
          protectionExpiry: c.protectionExpiry,
          upkeepHours,
          upkeepDays,
          isDecaying,
          status,
          wood,
          stones,
          metal,
          hqm
        });
      }

      // Check items in container
      for (const item of c.items || []) {
        const sn = (item.shortname || "").toLowerCase();
        const qty = item.quantity || 0;

        if (sn === "ammo.rocket.basic") explosives.rockets += qty;
        else if (sn === "ammo.rocket.hv") explosives.hvRockets += qty;
        else if (sn === "ammo.rocket.fire") explosives.fireRockets += qty;
        else if (sn === "ammo.rocket.mlrs") explosives.mlrsRockets += qty;
        else if (sn === "explosive.timed") explosives.c4 += qty;
        else if (sn === "explosive.satchel") explosives.satchels += qty;
        else if (sn === "grenade.beancan") explosives.beancans += qty;
        else if (sn === "grenade.f1") explosives.f1Grenades += qty;
        else if (sn === "ammo.rifle.explosive") explosives.exploAmmo += qty;
        else if (sn === "sulfur") resources.sulfur += qty;
        else if (sn === "gunpowder") resources.gunpowder += qty;
        else if (sn === "explosives") resources.explosivesComp += qty;
        else if (sn === "metal.fragments") resources.metalFragments += qty;
        else if (sn === "metal.refined") resources.hqm += qty;
        else if (sn === "lowgradefuel") resources.lowGradeFuel += qty;
        else if (sn === "scrap") resources.scrap += qty;
      }
    }

    const totalSulfurPower = 
      resources.sulfur * 1 +
      resources.gunpowder * 2 +
      resources.explosivesComp * 110 +
      explosives.rockets * 1400 +
      explosives.c4 * 2200 +
      explosives.satchels * 480 +
      explosives.beancans * 120 +
      explosives.hvRockets * 200 +
      explosives.fireRockets * 720 +
      Math.round(explosives.exploAmmo * 25);

    return {
      containersCount: this.containers.size,
      tcs,
      explosives,
      resources,
      totalSulfurPower
    };
  }

  getBoomSummary() {
    const data = this.getClanArmoryTotals();
    const e = data.explosives;
    if (data.containersCount === 0) {
      return "ℹ️ No paired storage containers found. Pair a Storage Monitor to your boom boxes!";
    }
    return `🚀 [Clan Boom Aggregator] Rockets: ${e.rockets} | C4: ${e.c4} | Satchels: ${e.satchels} | Explo Ammo: ${e.exploAmmo.toLocaleString()} | HV Rockets: ${e.hvRockets} | Total Raid Sulfur Potential: ${data.totalSulfurPower.toLocaleString()}`;
  }

  getSulfurSummary() {
    const data = this.getClanArmoryTotals();
    const r = data.resources;
    if (data.containersCount === 0) {
      return "ℹ️ No paired storage containers found. Pair a Storage Monitor to your sulfur/GP boxes!";
    }
    return `🔥 [Clan Sulfur Reserves] Raw Sulfur: ${r.sulfur.toLocaleString()} | Gunpowder: ${r.gunpowder.toLocaleString()} | Explosives: ${r.explosivesComp} | Total Raid Sulfur Potential: ${data.totalSulfurPower.toLocaleString()}`;
  }

  getArmorySummary() {
    const data = this.getClanArmoryTotals();
    const e = data.explosives;
    const r = data.resources;
    if (data.containersCount === 0) {
      return "ℹ️ No paired storage containers found. Pair a Storage Monitor to your boxes!";
    }
    return `🏰 [Clan Armory Overview] 🚀 Rockets: ${e.rockets} | 💥 C4: ${e.c4} | 🧨 Satchels: ${e.satchels} | 💥 Explo Ammo: ${e.exploAmmo.toLocaleString()} | 🔥 Sulfur: ${r.sulfur.toLocaleString()} | ⚡ GP: ${r.gunpowder.toLocaleString()} | 🧱 HQM: ${r.hqm.toLocaleString()} | 💣 Total Raid Sulfur Power: ${data.totalSulfurPower.toLocaleString()}`;
  }

  getMultiTcSummary() {
    const data = this.getClanArmoryTotals();
    const tcs = data.tcs;
    if (tcs.length === 0) {
      return "ℹ️ No Tool Cupboards paired. Attach a Storage Monitor to your main and external TCs!";
    }
    const formatted = tcs.map(tc => {
      const timeStr = tc.upkeepDays !== null ? (tc.isDecaying ? "🔴 DECAYING" : `${tc.upkeepDays}d (${tc.upkeepHours}h)`) : "Unknown";
      return `"${tc.name}": ${timeStr} [${tc.wood}w, ${tc.stones}s, ${tc.metal}m, ${tc.hqm}hqm]`;
    }).join(" | ");
    return `🛡️ [Multi-TC Upkeep Grid (${tcs.length} TCs)] ${formatted}`;
  }
}

module.exports = StorageTracker;
