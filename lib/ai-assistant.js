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

  buildSystemContext() {
    const srv = this.rustClient.activeServer?.name || "Unknown Server";
    const pop = this.rustClient.serverInfo ? `${this.rustClient.serverInfo.players}/${this.rustClient.serverInfo.maxPlayers} (Queue: ${this.rustClient.serverInfo.queuedPlayers || 0})` : "Unknown";
    const time = this.rustClient.timeInfo ? `Time: ${this.rustClient.timeInfo.time.toFixed(1)}h (Sunrise: ${this.rustClient.timeInfo.sunrise.toFixed(1)}h, Sunset: ${this.rustClient.timeInfo.sunset.toFixed(1)}h)` : "Unknown";

    const team = (this.rustClient.teamInfo?.members || []).map(m => {
      const state = m.isAlive ? (m.isOnline ? "Alive/Online" : "Sleeping") : "Dead";
      return `${m.name || m.steamId} (${state})`;
    }).join(", ");

    const notes = Array.from(this.savedNotes.entries()).map(([k, v]) => `${k}: ${v}`).join("; ");

    return `You are RustPlus AI, an expert Rust companion tactical assistant.
Current Live Context:
- Active Server: ${srv}
- Population: ${pop}
- Game Time: ${time}
- Team Members: ${team || "None"}
- Base Team Notes: ${notes || "None"}

Guidelines:
- Provide direct, concise, and tactical answers about Rust raiding costs, crafting, monuments, electricity, or current server state.
- Keep answers ultra-compact so they fit in in-game team chat when needed.`;
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
        return await this.callGroq(apiKey, aiConfig.model || "llama-3.3-70b-versatile", systemPrompt, question, source);
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
      const payload = JSON.stringify({
        model: model || "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question }
        ],
        max_tokens: source === "game" ? 60 : 300,
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
            const text = data?.choices?.[0]?.message?.content || "No response received.";
            const clean = text.replace(/[\r\n]+/g, " ").trim();
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
