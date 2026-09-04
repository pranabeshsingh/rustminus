/**
 * Rust Game Database & Calculators
 * Contains static data & mathematical calculators for:
 * - Raiding durability (hard/soft, explosives, bullets, melee, siege)
 * - Crafting breakdowns (raw sulfur, metal, charcoal, components)
 * - Mixing table recipes
 * - Recycler yields (monument 100% vs safe zone 80%)
 * - Monument radiation, keycards, and puzzle data
 * - Auto Turret 40m sphere interference calculator
 */

// Durability & Raiding Costs (standard official stats)
const DurabilityData = {
  "sheet metal door": {
    hp: 250,
    c4: 1,
    rockets: 2,
    satchels: 4,
    explo: 63,
    bullets: { "5.56": 200, "pistol": 400 },
    meleeSoft: { "spear": "N/A", "pickaxe": "N/A" },
    meleeHard: { "salvaged_sword": 140 }
  },
  "garage door": {
    hp: 600,
    c4: 2,
    rockets: 3, // 3 rockets or 2 rockets + 40 explo
    satchels: 9,
    explo: 150,
    bullets: { "5.56": 480, "pistol": 960 },
    meleeSoft: { "pickaxe": "N/A" },
    meleeHard: { "salvaged_sword": 350 }
  },
  "armored door": {
    hp: 800,
    c4: 2,
    rockets: 4,
    satchels: 12,
    explo: 200,
    bullets: { "5.56": 640, "pistol": 1280 },
    meleeSoft: { "pickaxe": "N/A" },
    meleeHard: { "salvaged_sword": 500 }
  },
  "wooden door": {
    hp: 200,
    c4: 1,
    rockets: 1,
    satchels: 2,
    explo: 18,
    bullets: { "5.56": 45, "pistol": 90, "shotgun_incendiary": 5 },
    meleeSoft: { "machete": 15, "salvaged_sword": 10 },
    meleeHard: { "salvaged_sword": 18, "metal_hatchet": 15 }
  },
  "wooden wall": {
    hp: 250,
    c4: 1,
    rockets: 2,
    satchels: 3,
    explo: 49,
    bullets: { "5.56": 120 },
    meleeSoft: { "salvaged_sword": 23, "metal_hatchet": 20 },
    meleeHard: { "metal_hatchet": 40 }
  },
  "stone wall": {
    hp: 500,
    c4: 2,
    rockets: 4,
    satchels: 10,
    explo: 185,
    bullets: { "5.56": "N/A" },
    meleeSoft: { "metal_pickaxe": 7, "jackhammer": 1 },
    meleeHard: { "metal_pickaxe": 60 }
  },
  "sheet metal wall": {
    hp: 1000,
    c4: 4,
    rockets: 8,
    satchels: 23,
    explo: 400,
    bullets: { "5.56": "N/A" },
    meleeSoft: { "metal_pickaxe": 14, "jackhammer": 2 },
    meleeHard: { "jackhammer": 20 }
  },
  "armored wall": {
    hp: 2000,
    c4: 8,
    rockets: 15,
    satchels: 46,
    explo: 799,
    bullets: { "5.56": "N/A" },
    meleeSoft: { "jackhammer": 4 },
    meleeHard: { "jackhammer": 40 }
  },
  "auto turret": {
    hp: 1000,
    c4: 1,
    rockets: 2,
    satchels: 3,
    explo: 56,
    bullets: { "5.56": 134, "high_velocity_rocket": 3 },
    meleeSoft: { "mace": 25 },
    meleeHard: { "mace": 25 }
  },
  "sam site": {
    hp: 1000,
    c4: 1,
    rockets: 2,
    satchels: 4,
    explo: 60,
    bullets: { "5.56": 150 },
    meleeSoft: { "mace": 30 },
    meleeHard: { "mace": 30 }
  },
  "high external stone wall": {
    hp: 500,
    c4: 2,
    rockets: 4,
    satchels: 10,
    explo: 185,
    bullets: { "5.56": "N/A" },
    meleeSoft: { "metal_pickaxe": 60 },
    meleeHard: { "metal_pickaxe": 60 }
  },
  "high external wooden wall": {
    hp: 500,
    c4: 1,
    rockets: 2,
    satchels: 6,
    explo: 98,
    bullets: { "5.56": 240 },
    meleeSoft: { "metal_hatchet": 40 },
    meleeHard: { "metal_hatchet": 40 }
  },
  "reinforced glass window": {
    hp: 500,
    c4: 2,
    rockets: 3,
    satchels: 9,
    explo: 150,
    bullets: { "5.56": "N/A" },
    meleeSoft: { "salvaged_hammer": 50 },
    meleeHard: { "salvaged_hammer": 50 }
  },
  "tool cupboard": {
    hp: 100,
    c4: 1,
    rockets: 1,
    satchels: 1,
    explo: 10,
    bullets: { "5.56": 20, "pistol": 40 },
    meleeSoft: { "salvaged_sword": 5 },
    meleeHard: { "salvaged_sword": 5 }
  }
};

const DurabilityAliases = {
  "sheet": "sheet metal wall",
  "metal wall": "sheet metal wall",
  "metal door": "sheet metal door",
  "garage": "garage door",
  "armored": "armored wall",
  "armour": "armored wall",
  "armored door": "armored door",
  "stone": "stone wall",
  "wood wall": "wooden wall",
  "wood door": "wooden door",
  "turret": "auto turret",
  "sam": "sam site",
  "sams": "sam site",
  "tc": "tool cupboard",
  "cupboard": "tool cupboard",
  "high ext stone": "high external stone wall",
  "he stone": "high external stone wall",
  "he wood": "high external wooden wall"
};

const CraftingRecipes = {
  "rocket": {
    craftTimeSec: 10,
    inputs: { "explosives": 10, "gunpowder": 150, "metal pipe": 2 },
    raw: { sulfur: 1400, charcoal: 1950, metalFragments: 100, "metal pipe": 2 }
  },
  "c4": {
    craftTimeSec: 30,
    inputs: { "explosives": 20, "cloth": 5, "tech trash": 2 },
    raw: { sulfur: 2200, charcoal: 3000, metalFragments: 200, cloth: 5, "tech trash": 2 }
  },
  "explosives": {
    craftTimeSec: 5,
    inputs: { "gunpowder": 50, "low grade fuel": 3, "sulfur": 10, "metal fragments": 10 },
    raw: { sulfur: 110, charcoal: 150, metalFragments: 10, lowGradeFuel: 3 }
  },
  "gunpowder": {
    craftTimeSec: 2,
    inputs: { "sulfur": 2, "charcoal": 3 },
    raw: { sulfur: 2, charcoal: 3 }
  },
  "explosive 5.56 rifle ammo": {
    craftTimeSec: 3,
    yield: 2,
    inputs: { "metal fragments": 10, "gunpowder": 20, "sulfur": 10 },
    raw: { sulfur: 25, charcoal: 30, metalFragments: 5 }
  },
  "satchel charge": {
    craftTimeSec: 10,
    inputs: { "beancan grenade": 4, "small stash": 1, "rope": 1 },
    raw: { sulfur: 480, charcoal: 720, metalFragments: 80, cloth: 10, rope: 1 }
  },
  "medical syringe": {
    craftTimeSec: 2,
    inputs: { "cloth": 10, "low grade fuel": 10, "metal fragments": 10 },
    raw: { cloth: 10, lowGradeFuel: 10, metalFragments: 10 }
  },
  "auto turret": {
    craftTimeSec: 15,
    inputs: { "targeting computer": 1, "cctv camera": 1, "high quality metal": 10 },
    raw: { "targeting computer": 1, "cctv camera": 1, hqm: 10 }
  }
};

const MixingRecipes = {
  "pure max health tea": "4x Advanced Max Health Tea (Yield: 1)",
  "pure ore tea": "4x Advanced Ore Tea (Yield: 1)",
  "pure wood tea": "4x Advanced Wood Tea (Yield: 1)",
  "pure scrap tea": "4x Advanced Scrap Tea (Yield: 1)",
  "advanced ore tea": "4x Basic Ore Tea (Yield: 1)",
  "advanced scrap tea": "4x Basic Scrap Tea (Yield: 1)",
  "explosives": "50x Gunpowder + 3x Low Grade Fuel + 10x Sulfur + 10x Metal Fragments",
  "gunpowder": "2x Sulfur + 3x Charcoal (Faster batch mixing)"
};

const RecyclingYields = {
  "tech trash": { hqm: 1, scrap: 20 },
  "rifle body": { hqm: 2, scrap: 25, metalFragments: 25 },
  "smg body": { hqm: 2, scrap: 15, metalFragments: 15 },
  "semi automatic body": { hqm: 2, scrap: 15, metalFragments: 15 },
  "metal spring": { hqm: 1, scrap: 10 },
  "metal pipe": { hqm: 1, scrap: 5 },
  "sheet metal": { scrap: 8, metalFragments: 100, hqm: 1 },
  "road signs": { scrap: 5, hqm: 1 },
  "gears": { scrap: 10, metalFragments: 13 },
  "electric fuse": { scrap: 20 },
  "cctv camera": { hqm: 2, scrap: 50, techTrash: 2 },
  "targeting computer": { hqm: 1, scrap: 50, techTrash: 3 },
  "empty propane tank": { scrap: 1, metalFragments: 50 },
  "metal blade": { scrap: 2, metalFragments: 15 },
  "tarp": { cloth: 50 },
  "sewing kit": { cloth: 10, rope: 2 }
};

const MonumentData = {
  "large oil rig": { rad: 0, cards: ["blue", "red"], lootRespawn: "30-45m", desc: "Red card puzzle, heavy scientists, locked crate." },
  "small oil rig": { rad: 0, cards: ["blue", "red"], lootRespawn: "30-45m", desc: "Red card puzzle, heavy scientists, locked crate." },
  "launch site": { rad: 25, cards: ["green", "red"], lootRespawn: "25-35m", desc: "Requires 25 Rad protection for main building, Bradley APC outside." },
  "military tunnel": { rad: 25, cards: ["green", "blue", "red"], lootRespawn: "30-40m", desc: "Scientists underground, full puzzle sequence for elite crates." },
  "airfield": { rad: 10, cards: ["green", "blue", "red"], lootRespawn: "20-30m", desc: "Underground bunker puzzles, recyclers inside hangar and underground." },
  "the dome": { rad: 10, cards: [], lootRespawn: "15-20m", desc: "Parkour puzzle, 4 military crates on top, no keycard required." },
  "power plant": { rad: 15, cards: ["green", "blue", "red"], lootRespawn: "20-30m", desc: "Cooling towers & generator puzzles." },
  "water treatment plant": { rad: 10, cards: ["blue"], lootRespawn: "20-30m", desc: "Wheel puzzle, recycler, pump stations." },
  "train yard": { rad: 15, cards: ["blue", "red"], lootRespawn: "20-30m", desc: "Card puzzles in main tower and warehouse." },
  "sewer branch": { rad: 10, cards: ["green", "blue"], lootRespawn: "15-20m", desc: "Low rad beginner puzzle with blue card reward." },
  "satellite dish": { rad: 10, cards: ["green", "blue"], lootRespawn: "15-20m", desc: "Quick green card puzzle." },
  "outpost": { rad: 0, cards: [], lootRespawn: "N/A", desc: "Safe zone: vending machines, 80% recycler, workbench 1, repair bench." },
  "bandit camp": { rad: 0, cards: [], lootRespawn: "N/A", desc: "Safe zone: gambling wheel, airwolf heli vendor, 80% recycler." }
};

const MonumentCameras = {
  "large oil rig": [
    { code: "OILRIG1", desc: "Helipad" },
    { code: "OILRIG2", desc: "Crane" },
    { code: "OILRIG3", desc: "Exhaust" },
    { code: "OILRIG4", desc: "Moonpool" },
    { code: "OILRIG5", desc: "Lower Deck" },
    { code: "OILRIG6", desc: "Top Deck" }
  ],
  "oil rig": [
    { code: "OILRIG01", desc: "Helipad" },
    { code: "OILRIG02", desc: "Crane" },
    { code: "OILRIG03", desc: "Lower Walkway" },
    { code: "OILRIG04", desc: "Dock" }
  ],
  "dome": [
    { code: "DOME1", desc: "Top Exterior" },
    { code: "DOME2", desc: "Walkway Mid" },
    { code: "DOME3", desc: "Lower Ground" }
  ],
  "airfield": [
    { code: "AIRFIELD1", desc: "Runway West" },
    { code: "AIRFIELD2", desc: "Runway East" },
    { code: "AIRFIELD3", desc: "Hangar" },
    { code: "AIRFIELD4", desc: "Tower" }
  ],
  "launch site": [
    { code: "LAUNCHSITE1", desc: "Launch Pad" },
    { code: "LAUNCHSITE2", desc: "Main Building Roof" },
    { code: "LAUNCHSITE3", desc: "Factory Entrance" },
    { code: "LAUNCHSITE4", desc: "Trench" }
  ],
  "water treatment plant": [
    { code: "WATERPLANT1", desc: "Silo Roof" },
    { code: "WATERPLANT2", desc: "Basin" },
    { code: "WATERPLANT3", desc: "Recycler Yard" }
  ],
  "train yard": [
    { code: "TRAINYARD1", desc: "Central Crane" },
    { code: "TRAINYARD2", desc: "Main Warehouse" },
    { code: "TRAINYARD3", desc: "Turntable" }
  ],
  "military tunnels": [
    { code: "MILITARYTUNNELS1", desc: "Entrance Trench" },
    { code: "MILITARYTUNNELS2", desc: "Silo Room" }
  ],
  "bandit camp": [
    { code: "BANDIT1", desc: "Town Center" },
    { code: "BANDIT2", desc: "Casino Wheel" }
  ],
  "outpost": [
    { code: "OUTPOST1", desc: "Main Gate" },
    { code: "OUTPOST2", desc: "Vending Alley" }
  ]
};

class GameDatabase {
  static getDurability(query, type = "explosive", isSoft = false) {
    const q = query.toLowerCase().trim();
    const resolvedName = DurabilityAliases[q] || q;
    const matchKey = Object.keys(DurabilityData).find(k => k === resolvedName || k.includes(resolvedName));

    if (!matchKey) {
      return `⚠️ Item/building block "${query}" not found in durability database.`;
    }

    const data = DurabilityData[matchKey];
    const nameCap = matchKey.toUpperCase();

    if (type === "bullet") {
      const bullets = data.bullets || {};
      const list = Object.entries(bullets).map(([k, v]) => `${v}x ${k}`).join(" | ");
      return `💥 [${nameCap} Bullet Durability (HP: ${data.hp})] ${list || "Immune to bullets"}`;
    }

    if (type === "melee") {
      const toolMap = isSoft ? (data.meleeSoft || {}) : (data.meleeHard || {});
      const list = Object.entries(toolMap).map(([k, v]) => `${v}x ${k.replace(/_/g, " ")}`).join(" | ");
      return `⚔️ [${nameCap} Melee Durability (${isSoft ? "SOFT SIDE" : "HARD SIDE"})] ${list || "Immune to melee"}`;
    }

    if (type === "siege") {
      const c4Equiv = Math.ceil(data.c4 * 1.5);
      return `🏹 [${nameCap} Siege Durability (HP: ${data.hp})] Catapult / Siege Equivalent: ~${c4Equiv} direct hits | Rockets: ${data.rockets}`;
    }

    // Default: Explosives
    return `💥 [${nameCap} Raid Cost (HP: ${data.hp})] C4: ${data.c4} | Rockets: ${data.rockets} | Satchels: ${data.satchels} | Explo Ammo: ${data.explo}`;
  }

  static getCraft(query, count = 1) {
    const q = query.toLowerCase().trim();
    const match = Object.keys(CraftingRecipes).find(k => k === q || k.includes(q));
    if (!match) return `⚠️ Crafting recipe for "${query}" not found. Try: rocket, c4, explosives, gunpowder, syringe, satchel.`;

    const recipe = CraftingRecipes[match];
    const multiplier = Math.max(1, Math.floor(Number(count) || 1));
    const nameCap = match.toUpperCase();

    const rawList = Object.entries(recipe.raw).map(([k, v]) => {
      const total = (typeof v === "number") ? (v * multiplier).toLocaleString() : `${multiplier}x ${v}`;
      return `${total} ${k}`;
    }).join(", ");

    const totalTime = recipe.craftTimeSec * multiplier;
    return `🔨 [Craft ${multiplier}x ${nameCap}] Raw Cost: ${rawList} (Time: ~${totalTime}s)`;
  }

  static getMix(query, count = 1) {
    const q = query.toLowerCase().trim();
    const match = Object.keys(MixingRecipes).find(k => k === q || k.includes(q));
    if (!match) return `⚠️ Mixing table recipe for "${query}" not found. Try: pure ore tea, pure max health tea, pure scrap tea, explosives, gunpowder.`;
    const mult = Math.max(1, Math.floor(Number(count) || 1));
    return `⚗️ [Mixing Table] ${mult}x ${match.toUpperCase()}: ${MixingRecipes[match]}`;
  }

  static getRecycle(query, isSafeZone = false) {
    const q = query.toLowerCase().trim();
    let amount = 1;
    let itemName = q;

    const matchLeadingNum = q.match(/^(\d+)\s+(.+)$/);
    if (matchLeadingNum) {
      amount = parseInt(matchLeadingNum[1], 10);
      itemName = matchLeadingNum[2].trim();
    }

    const key = Object.keys(RecyclingYields).find(k => k === itemName || k.includes(itemName));
    if (!key) return `⚠️ Component "${itemName}" not found in recycler database. Try: tech trash, rifle body, metal pipe, metal spring, road signs, gears, sheet metal.`;

    const yieldData = RecyclingYields[key];
    const mult = isSafeZone ? 0.8 : 1.0;
    const itemsOut = [];

    for (const [res, val] of Object.entries(yieldData)) {
      const outAmount = Math.floor(val * amount * mult);
      if (outAmount > 0) itemsOut.push(`${outAmount}x ${res}`);
    }

    const zoneLabel = isSafeZone ? "Safe Zone (80%)" : "Monument Recycler (100%)";
    return `♻️ [Recycle ${amount}x ${key.toUpperCase()} @ ${zoneLabel}] Yields: ${itemsOut.join(", ") || "Nothing"}`;
  }

  static getMonumentInfo(query) {
    const q = query.toLowerCase().replace(/[\s_-]+/g, "").trim();
    const match = Object.keys(MonumentData).find(k => {
      const norm = k.toLowerCase().replace(/[\s_-]+/g, "");
      return norm === q || norm.includes(q) || q.includes(norm);
    });
    if (!match) return `⚠️ Monument "${query}" not found. Try: dome, airfield, oil, launch, water.`;
    const m = MonumentData[match];
    const cardsStr = m.cards.length > 0 ? m.cards.join(", ") : "None";
    return `🏛️ [${match.toUpperCase()}] Rad Protection: ${m.rad}% | Cards Required: ${cardsStr} | Loot Respawn: ${m.lootRespawn} | ${m.desc}`;
  }

  static getKeycardMonuments(color) {
    const col = color.toLowerCase().trim();
    const matches = Object.entries(MonumentData).filter(([k, v]) => v.cards.includes(col));
    if (matches.length === 0) return `ℹ️ No monuments found requiring ${color} card.`;
    const names = matches.map(([k]) => k.toUpperCase()).join(", ");
    return `💳 [${col.toUpperCase()} Keycard Monuments] Required at: ${names}`;
  }

  static getRadiationInfo(monumentName) {
    const q = monumentName.toLowerCase().replace(/[\s_-]+/g, "").trim();
    const match = Object.keys(MonumentData).find(k => {
      const norm = k.toLowerCase().replace(/[\s_-]+/g, "");
      return norm === q || norm.includes(q) || q.includes(norm);
    });
    if (!match) return `⚠️ Monument "${monumentName}" not found.`;
    const m = MonumentData[match];
    return `☢️ [${match.toUpperCase()} Radiation] Minimum Armor Required: ${m.rad}% Rad Protection.`;
  }

  static getDurabilityData(query) {
    const q = (query || "").toLowerCase().trim();
    const resolvedName = DurabilityAliases[q] || q;
    const matchKey = Object.keys(DurabilityData).find(k => k === resolvedName || k.includes(resolvedName));
    if (!matchKey) return null;
    const d = DurabilityData[matchKey];
    return {
      target: matchKey,
      hp: d.hp,
      c4: d.c4,
      rockets: d.rockets,
      satchels: d.satchels,
      explo556: d.explo,
      pickaxesHard: d.meleeHard?.["metal_pickaxe"] || d.meleeHard?.["jackhammer"] || d.meleeHard?.["salvaged_sword"] || null,
      pickaxesSoft: d.meleeSoft?.["metal_pickaxe"] || d.meleeSoft?.["jackhammer"] || null,
      spearsHard: d.meleeHard?.["stone_spear"] || d.meleeHard?.["wooden_spear"] || null,
      spearsSoft: d.meleeSoft?.["stone_spear"] || d.meleeSoft?.["wooden_spear"] || null,
      hvRockets: d.bullets?.["high_velocity_rocket"] || null,
      mlrsRockets: d.mlrs || null,
      heGrenades: d.bullets?.["he_grenade"] || null,
      shotgunIncendiary: d.bullets?.["shotgun_incendiary"] || null
    };
  }

  static getCraftData(query, count = 1) {
    const q = (query || "").toLowerCase().trim();
    const match = Object.keys(CraftingRecipes).find(k => k === q || k.includes(q));
    if (!match) return null;
    const recipe = CraftingRecipes[match];
    const multiplier = Math.max(1, Math.floor(Number(count) || 1));
    const ingredients = {};
    for (const [k, v] of Object.entries(recipe.raw || {})) {
      ingredients[k] = (typeof v === "number") ? v * multiplier : `${multiplier}x ${v}`;
    }
    return {
      name: match,
      workbench: recipe.workbenchTier || (match.includes("c4") || match.includes("rocket") ? 3 : match.includes("explosive") || match.includes("auto") ? 2 : 1),
      totalCraftTime: `${recipe.craftTimeSec * multiplier}s`,
      ingredients
    };
  }

  static getRecycleData(query, count = 1, isSafeZone = false) {
    const q = (query || "").toLowerCase().trim();
    let amount = Number(count) || 1;
    let itemName = q;
    const matchLeadingNum = q.match(/^(\d+)\s+(.+)$/);
    if (matchLeadingNum) {
      amount = parseInt(matchLeadingNum[1], 10);
      itemName = matchLeadingNum[2].trim();
    }
    const match = Object.keys(RecyclingYields).find(k => k === itemName || k.includes(itemName));
    if (!match) return null;
    const yieldData = RecyclingYields[match];
    const factor = isSafeZone ? 0.8 : 1.0;
    const yieldResult = {};
    for (const [k, v] of Object.entries(yieldData)) {
      yieldResult[k] = Math.floor(v * amount * factor);
    }
    return {
      name: match,
      isSafeZone: !!isSafeZone,
      yield: yieldResult
    };
  }

  static getMonumentCameras(query = "") {
    const q = (query || "").toLowerCase().trim();
    if (!q) {
      const list = Object.entries(MonumentCameras)
        .map(([mon, cams]) => `${mon.toUpperCase()} (${cams.length} cams: ${cams.map(c => c.code).join(", ")})`)
        .join(" | ");
      return `📹 [Monument Cameras] ${list}`;
    }

    const matches = Object.entries(MonumentCameras).filter(([mon]) => mon.includes(q) || q.includes(mon));
    if (matches.length === 0) {
      return `⚠️ No monument cameras found matching "${query}". Available: oil rig, large oil rig, dome, airfield, launch site, water treatment, train yard, military tunnels.`;
    }

    const res = matches.map(([mon, cams]) => {
      const camList = cams.map(c => `${c.code} (${c.desc})`).join(", ");
      return `📹 [${mon.toUpperCase()}] ${camList}`;
    }).join(" | ");

    return res;
  }

  static calculateRaidCost(targetText, armoryTotals = null) {
    if (!targetText || !targetText.trim()) {
      return {
        success: false,
        error: "Usage: !raidcost <target(s)> (e.g. !raidcost 3 garage doors, 1 sheet metal door)"
      };
    }

    const chunks = targetText.split(/,|\band\b|\+/i).map(c => c.trim()).filter(Boolean);
    const parsedTargets = [];
    let totalRockets = 0;
    let totalC4 = 0;
    let totalSatchels = 0;
    let totalExplo = 0;

    for (const chunk of chunks) {
      let count = 1;
      let nameStr = chunk;
      const m = chunk.match(/^(\d+)\s*(?:x\s*)?(.+)$/i);
      if (m) {
        count = parseInt(m[1], 10);
        nameStr = m[2].trim();
      }

      const lower = nameStr.toLowerCase().replace(/s$/, "");

      if (lower.includes("2x2") || lower.includes("starter")) {
        const isStone = lower.includes("stone") || !lower.includes("sheet");
        const wallKey = isStone ? "stone wall" : "sheet metal wall";
        const doorKey = "sheet metal door";
        const wallR = DurabilityData[wallKey].rockets * 4 * count;
        const wallC = DurabilityData[wallKey].c4 * 4 * count;
        const doorR = DurabilityData[doorKey].rockets * count;
        const doorC = DurabilityData[doorKey].c4 * count;

        totalRockets += wallR + doorR;
        totalC4 += wallC + doorC;
        totalSatchels += (DurabilityData[wallKey].satchels * 4 + DurabilityData[doorKey].satchels) * count;
        totalExplo += (DurabilityData[wallKey].explo * 4 + DurabilityData[doorKey].explo) * count;

        parsedTargets.push({
          name: `${count}x Starter 2x2 (${isStone ? "Stone" : "Metal"})`,
          count,
          rockets: wallR + doorR,
          c4: wallC + doorC,
          satchels: (DurabilityData[wallKey].satchels * 4 + DurabilityData[doorKey].satchels) * count,
          explo: (DurabilityData[wallKey].explo * 4 + DurabilityData[doorKey].explo) * count
        });
        continue;
      }

      const aliasMatch = DurabilityAliases[lower] || DurabilityAliases[nameStr.toLowerCase()];
      const searchKey = aliasMatch || lower;

      const matchedKey = Object.keys(DurabilityData).find(k => 
        k === searchKey || 
        k === searchKey.replace(/s$/, "") || 
        k.includes(searchKey) || 
        searchKey.includes(k)
      );

      if (!matchedKey) {
        continue;
      }

      const dur = DurabilityData[matchedKey];
      const r = dur.rockets * count;
      const c = dur.c4 * count;
      const s = dur.satchels * count;
      const ex = dur.explo * count;

      totalRockets += r;
      totalC4 += c;
      totalSatchels += s;
      totalExplo += ex;

      parsedTargets.push({
        name: `${count}x ${matchedKey.toUpperCase()}`,
        count,
        target: matchedKey,
        rockets: r,
        c4: c,
        satchels: s,
        explo: ex
      });
    }

    if (parsedTargets.length === 0) {
      return {
        success: false,
        error: `⚠️ Could not recognize target structures in "${targetText}". Try: garage door, sheet door, armored door, stone wall, sheet wall, armored wall, auto turret, high ext stone.`
      };
    }

    const sulfurRockets = totalRockets * 1400;
    const sulfurC4 = totalC4 * 2200;
    const minSulfur = Math.min(sulfurRockets, sulfurC4);

    const result = {
      success: true,
      query: targetText,
      targets: parsedTargets,
      totals: {
        rockets: totalRockets,
        c4: totalC4,
        satchels: totalSatchels,
        explo: totalExplo,
        sulfurRockets,
        sulfurC4,
        minSulfur
      }
    };

    if (armoryTotals) {
      const armRockets = armoryTotals.rockets || 0;
      const armC4 = armoryTotals.c4 || 0;
      const armTotalSulfur = armoryTotals.totalRaidSulfur || 0;

      const canRockets = armRockets >= totalRockets;
      const canC4 = armC4 >= totalC4;
      const canTotalSulfur = armTotalSulfur >= minSulfur;

      result.armory = {
        rocketsHave: armRockets,
        rocketsNeed: totalRockets,
        c4Have: armC4,
        c4Need: totalC4,
        sulfurHave: armTotalSulfur,
        sulfurNeed: minSulfur,
        canRaidWithRockets: canRockets,
        canRaidWithC4: canC4,
        canRaidWithTotalSulfur: canTotalSulfur,
        isReady: canRockets || canC4 || canTotalSulfur
      };
    }

    const targetSummary = parsedTargets.map(t => t.name).join(" + ");
    let str = `🎯 [Raid Cost: ${targetSummary}]\n• Rockets: ${totalRockets}x (~${sulfurRockets.toLocaleString()} Sulfur)\n• C4: ${totalC4}x (~${sulfurC4.toLocaleString()} Sulfur)\n• Satchels: ${totalSatchels}x | Explo 5.56: ${totalExplo}x`;

    if (result.armory) {
      const a = result.armory;
      if (a.canRaidWithRockets) {
        str += `\n🏰 [Armory Readiness] ✅ READY FOR ROCKET RAID! (Have ${a.rocketsHave}/${a.rocketsNeed} Rockets)`;
      } else if (a.canRaidWithC4) {
        str += `\n🏰 [Armory Readiness] ✅ READY FOR C4 RAID! (Have ${a.c4Have}/${a.c4Need} C4)`;
      } else if (a.canRaidWithTotalSulfur) {
        str += `\n🏰 [Armory Readiness] 🟡 CRAFTING READY (Have ${a.sulfurHave.toLocaleString()}/${a.sulfurNeed.toLocaleString()} Total Sulfur Eq.)`;
      } else {
        const shortRockets = Math.max(0, a.rocketsNeed - a.rocketsHave);
        str += `\n🏰 [Armory Readiness] ❌ SHORT (Need ${shortRockets} more Rockets or ${(a.sulfurNeed - a.sulfurHave).toLocaleString()} more Sulfur)`;
      }
    }

    result.formattedText = str;
    return result;
  }
}

class TurretInterferenceTracker {
  constructor() {
    this.turrets = [];
  }

  addTurret(nameOrX, xOrY, yOrFloor, floor = 1) {
    let name = "Turret";
    let x = 0;
    let y = 0;
    let fl = 1;

    if (typeof nameOrX === "string" && isNaN(Number(nameOrX))) {
      name = nameOrX;
      x = Number(xOrY) || 0;
      y = Number(yOrFloor) || 0;
      fl = Number(floor) || 1;
    } else {
      x = Number(nameOrX) || 0;
      y = Number(xOrY) || 0;
      fl = Number(yOrFloor) || 1;
      name = `Turret #${this.turrets.length + 1}`;
    }

    const item = {
      id: this.turrets.length + 1,
      name,
      x,
      y,
      floor: fl,
      timestamp: Date.now()
    };
    this.turrets.push(item);
    const nearby = this.checkInterference(item.x, item.y, item.floor);
    return {
      total: this.turrets.length,
      turret: item,
      nearbyCount: nearby.count,
      hasInterference: nearby.count > 12
    };
  }

  checkInterference(x, y, floor = 1) {
    const floorHeightMeters = 3;
    const currentZ = floor * floorHeightMeters;
    const radiusMeters = 40;

    let count = 0;
    let closestDist = Infinity;

    for (const t of this.turrets) {
      const tZ = t.floor * floorHeightMeters;
      const dist = Math.sqrt(
        Math.pow(x - t.x, 2) + 
        Math.pow(y - t.y, 2) + 
        Math.pow(currentZ - tZ, 2)
      );

      if (dist <= radiusMeters) {
        count++;
        if (dist > 0 && dist < closestDist) {
          closestDist = dist;
        }
      }
    }

    return {
      count,
      closestMeters: closestDist === Infinity ? 0 : Math.round(closestDist * 10) / 10,
      hasInterference: count > 12,
      limit: 12
    };
  }

  checkOverlap() {
    const overlaps = [];
    for (let i = 0; i < this.turrets.length; i++) {
      for (let j = i + 1; j < this.turrets.length; j++) {
        const t1 = this.turrets[i];
        const t2 = this.turrets[j];
        const dx = t1.x - t2.x;
        const dy = t1.y - t2.y;
        const dz = (t1.floor - t2.floor) * 3;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 40) {
          overlaps.push({
            turretA: t1.name || `Turret #${t1.id}`,
            turretB: t2.name || `Turret #${t2.id}`,
            distanceMeters: Math.round(dist * 10) / 10
          });
        }
      }
    }
    return {
      hasOverlaps: overlaps.length > 0,
      overlaps
    };
  }

  clear() {
    this.turrets = [];
    return true;
  }

  clearTurrets() {
    this.turrets = [];
    return "Cleared all turrets.";
  }
}

module.exports = {
  GameDatabase,
  TurretInterferenceTracker
};
