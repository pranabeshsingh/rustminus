/**
 * In-Game & Matrix AI Assistant
 * Provides intelligent tactical Rust responses using Gemini or OpenAI.
 * Enabled/Disabled via WebUI Settings (defaults to disabled).
 */

const https = require("https");

class AIAssistant {
  constructor(configManager, rustClient) {
    this.configManager = configManager;
    this.rustClient = rustClient;
    this.savedNotes = new Map(); // noteName -> noteText
  }

  getConfig() {
    const cfg = this.configManager.getConfig();
    return cfg.ai || {
      enabled: false,
      provider: "gemini", // "gemini" | "openai"
      apiKey: "",
      model: "gemini-1.5-flash",
      customPrompt: ""
    };
  }

  // --- Saved Notes System (!note, !notes) ---
  saveNote(name, text) {
    const cleanName = String(name).trim();
    if (!cleanName || !text) return "Usage: !note <name> <message>";
    if (this.savedNotes.size >= 10 && !this.savedNotes.has(cleanName)) {
      return "⚠️ Maximum limit of 10 saved notes reached. Clear notes with !notes-clear.";
    }
    this.savedNotes.set(cleanName, String(text).trim());
    return `📝 Stored note "${cleanName}": "${text}" (Added to AI context).`;
  }

  getNotes(name) {
    if (name) {
      const val = this.savedNotes.get(String(name).trim());
      return val ? `📝 [Note: ${name}] ${val}` : `⚠️ Note "${name}" not found.`;
    }
    if (this.savedNotes.size === 0) return "ℹ️ No saved notes stored.";
    const list = Array.from(this.savedNotes.entries()).map(([k, v]) => `"${k}": ${v}`).join(" | ");
    return `📝 [Saved Notes (${this.savedNotes.size}/10)] ${list}`;
  }

  clearNotes(name) {
    if (name) {
      if (this.savedNotes.delete(String(name).trim())) {
        return `📝 Cleared note "${name}".`;
      }
      return `⚠️ Note "${name}" not found.`;
    }
    this.savedNotes.clear();
    return "📝 Cleared all saved notes.";
  }

  formatHours(val) {
    if (val === undefined || val === null) return "--:--";
    let h = Math.floor(val);
    let m = Math.floor((val - h) * 60);
    if (h >= 24) h %= 24;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  buildSystemContext() {
    const srv = this.rustClient.activeServer?.name || "Unknown Server";
    const pop = this.rustClient.serverInfo ? `${this.rustClient.serverInfo.players}/${this.rustClient.serverInfo.maxPlayers} (Queue: ${this.rustClient.serverInfo.queuedPlayers || 0})` : "Unknown";

    // 1. Time & Celestial Cycle
    let timeStr = "Unknown";
    if (this.rustClient.timeInfo) {
      const t = this.rustClient.timeInfo;
      const cd = this.rustClient.timeNotifier ? this.rustClient.timeNotifier.calculateCountdown(t) : null;
      const isDay = t.time >= t.sunrise && t.time < t.sunset;
      const countdownStr = cd ? `(~${Math.round(cd.minUntil)} real mins to ${cd.isDay ? 'Night' : 'Day'})` : '';
      timeStr = `Clock: ${this.formatHours(t.time)} | ${isDay ? '☀️ Day' : '🌙 Night'} ${countdownStr} | Sunrise: ${this.formatHours(t.sunrise)}, Sunset: ${this.formatHours(t.sunset)}`;
    }

    // 2. Team Roster with Map Grid Coordinates
    const teamMembers = (this.rustClient.teamInfo?.members || []).map(m => {
      const state = m.isAlive ? (m.isOnline ? "Alive/Online" : "Sleeping") : "Dead";
      const grid = (m.x !== undefined && m.y !== undefined && typeof this.rustClient.calculateGrid === "function")
        ? this.rustClient.calculateGrid(m.x, m.y)
        : null;
      const gridStr = grid ? ` @ Grid ${grid}` : "";
      return `${m.name || m.steamId} (${state}${gridStr})`;
    });

    // 3. Active World Map Events (Cargo, Heli, Chinook, Crates, Explosions)
    const activeEvents = [];
    if (this.rustClient.activeMarkers) {
      for (const m of this.rustClient.activeMarkers.values()) {
        if ([2, 4, 5, 6, 8].includes(m.type)) {
          activeEvents.push(`${m.typeName || "Event"} @ Grid ${m.grid || "Unknown"}`);
        }
      }
    }

    // 4. Tool Cupboard Upkeep Status
    const tcs = [];
    if (this.rustClient.storageTracker?.containers) {
      for (const c of this.rustClient.storageTracker.containers.values()) {
        if (c.protectionExpiry !== undefined || c.name?.toLowerCase().includes("tc") || c.name?.toLowerCase().includes("cupboard")) {
          if (c.protectionExpiry) {
            const sec = Math.max(0, c.protectionExpiry - Math.floor(Date.now() / 1000));
            const hrs = (sec / 3600).toFixed(1);
            const status = sec > 0 ? `${hrs}h upkeep remaining` : "DECAYING";
            tcs.push(`"${c.name}": ${status}`);
          }
        }
      }
    }

    // 5. Smart Switches & Defenses
    const switches = (this.rustClient.activeServer?.switches || []).slice(0, 6).map(s => {
      return `${s.name || s.id}: ${s.value ? "ON" : "OFF"}`;
    });

    // 6. Recent Event Log Items
    const recent = (this.rustClient.recentEvents || []).slice(0, 3).map(e => {
      return `[${e.type || "event"}] ${e.title}: ${e.message}`;
    });

    // 7. Base Team Notes (Door codes, coordinates)
    const notes = Array.from(this.savedNotes.entries()).map(([k, v]) => `${k}: ${v}`).join("; ");

    // 8. Clan Custom Directives from WebUI Settings
    const customPrompt = (this.getConfig().customPrompt || "").trim();

    let context = `You are RustPlus AI, an expert Rust tactical and companion assistant.
Current Live Game Intelligence:
- Active Server: ${srv}
- Population: ${pop}
- Game Time: ${timeStr}
- Team Roster: ${teamMembers.length > 0 ? teamMembers.join(", ") : "None detected"}
- Active World Events: ${activeEvents.length > 0 ? activeEvents.join(" | ") : "None currently active"}
- Base Upkeep & TCs: ${tcs.length > 0 ? tcs.join(" | ") : "No paired TCs / Storage Monitors"}
- Base Smart Switches: ${switches.length > 0 ? switches.join(", ") : "No configured switches"}
- Recent Events: ${recent.length > 0 ? recent.join(" ; ") : "None"}
- Base Team Notes: ${notes || "None"}`;

    if (customPrompt) {
      context += `\n- Clan Directives: ${customPrompt}`;
    }

    context += `\n
Guidelines:
- Provide direct, concise, and tactical answers about Rust raiding costs, crafting, monuments, electricity, base defense, or live game status.
- Keep answers ultra-compact so they fit in in-game team chat or Matrix.`;

    return context;
  }

  async ask(question, source = "game") {
    const aiConfig = this.getConfig();

    if (!aiConfig.enabled) {
      return "ℹ️ The AI Assistant is currently disabled in WebUI settings.";
    }

    const apiKey = (aiConfig.apiKey || "").trim();
    if (!apiKey) {
      return "⚠️ AI API Key is not configured. Please enter your Gemini or OpenAI key in WebUI Settings.";
    }

    const provider = (aiConfig.provider || "gemini").toLowerCase();
    const systemPrompt = this.buildSystemContext();

    try {
      if (provider === "groq" || apiKey.startsWith("gsk_")) {
        return await this.callGroq(apiKey, aiConfig.model || "qwen/qwen3.8-27b", systemPrompt, question, source);
      } else if (provider === "openai") {
        return await this.callOpenAI(apiKey, aiConfig.model || "gpt-4o-mini", systemPrompt, question, source);
      } else {
        return await this.callGemini(apiKey, aiConfig.model || "gemini-1.5-flash", systemPrompt, question, source);
      }
    } catch (err) {
      console.error("[AIAssistant] Error:", err.message);
      return `⚠️ AI error: ${err.message}`;
    }
  }

  callGemini(apiKey, model, systemPrompt, question, source) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `${systemPrompt}\n\nUser Question: ${question}` }]
          }
        ],
        generationConfig: {
          maxOutputTokens: source === "game" ? 60 : 300,
          temperature: 0.2
        }
      });

      const options = {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (data.error) {
              return reject(new Error(data.error.message || "Gemini API Error"));
            }
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response received.";
            const clean = text.replace(/[\r\n]+/g, " ").trim();
            resolve(`🤖 [AI] ${clean}`);
          } catch (e) {
            reject(new Error("Invalid Gemini response format"));
          }
        });
      });

      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  callOpenAI(apiKey, model, systemPrompt, question, source) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model: model || "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question }
        ],
        max_tokens: source === "game" ? 60 : 300,
        temperature: 0.2
      });

      const options = {
        hostname: "api.openai.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (data.error) {
              return reject(new Error(data.error.message || "OpenAI API Error"));
            }
            const text = data?.choices?.[0]?.message?.content || "No response received.";
            const clean = text.replace(/[\r\n]+/g, " ").trim();
            resolve(`🤖 [AI] ${clean}`);
          } catch (e) {
            reject(new Error("Invalid OpenAI response format"));
          }
        });
      });

      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  callGroq(apiKey, model, systemPrompt, question, source) {
    return new Promise((resolve, reject) => {
      let modelToUse = model || "qwen/qwen3.8-27b";
      // Auto-fallback if old/decommissioned llama or mixtral models are passed
      if (modelToUse.includes("llama-3") || modelToUse.includes("mixtral")) {
        modelToUse = "qwen/qwen3.8-27b";
      }

      const payload = JSON.stringify({
        model: modelToUse,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question }
        ],
        max_tokens: source === "game" ? 80 : 400,
        temperature: 0.2
      });

      const options = {
        hostname: "api.groq.com",
        path: "/openai/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (data.error) {
              return reject(new Error(data.error.message || "Groq API Error"));
            }
            let text = data?.choices?.[0]?.message?.content;
            if (!text && data?.choices?.[0]?.message?.reasoning) {
              text = data.choices[0].message.reasoning;
            }
            const clean = (text || "No response received.")
              .replace(/<think>[\s\S]*?<\/think>/gi, "")
              .replace(/[\r\n]+/g, " ")
              .trim();
            resolve(`🤖 [AI] ${clean}`);
          } catch (e) {
            reject(new Error("Invalid Groq response format"));
          }
        });
      });

      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = AIAssistant;
