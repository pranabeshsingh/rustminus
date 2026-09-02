const puppeteer = require("puppeteer-core");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function getVoiceConfig() {
  let cfg = {};
  try {
    const configPath = path.join(__dirname, "..", "data", "config.json");
    if (fs.existsSync(configPath)) {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  } catch (e) {}
  return {
    matrixUrl: process.env.MATRIX_URL || cfg.matrix?.homeserverUrl || "https://voice.trylocalhost.com",
    username: process.env.MATRIX_USERNAME || cfg.matrix?.username || "rustplus_bot",
    password: process.env.MATRIX_PASSWORD || cfg.matrix?.password || ""
  };
}

const vCfg = getVoiceConfig();
const MATRIX_URL = vCfg.matrixUrl;
const USERNAME = vCfg.username;
const PASSWORD = vCfg.password;
const PROFILE_DIR = path.join(__dirname, "..", "data", "browser_profile");
const IPC_PORT = 3005;

let browser = null;
let page = null;
let isReady = false;

// Ensure profile dir exists and clean up locks
function cleanLocks() {
  try {
    if (!fs.existsSync(PROFILE_DIR)) {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
    }
    const files = fs.readdirSync(PROFILE_DIR);
    for (const f of files) {
      if (f.startsWith("Singleton") || f === "lockfile") {
        try { fs.unlinkSync(path.join(PROFILE_DIR, f)); } catch(e) {}
      }
    }
  } catch(e) {}
}

async function startVoiceSpeaker() {
  console.log("[VoiceSpeaker] Launching permanent single-session browser instance...");
  cleanLocks();

  try {
    browser = await puppeteer.launch({
      executablePath: "/snap/bin/chromium",
      headless: "new",
      userDataDir: PROFILE_DIR,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-web-security"
      ]
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    const context = browser.defaultBrowserContext();
    await context.overridePermissions(MATRIX_URL, ["microphone", "camera", "notifications"]);

    // Inject Web Audio Destination into getUserMedia
    await page.evaluateOnNewDocument(() => {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const dest = audioCtx.createMediaStreamDestination();
      window.__audioCtx = audioCtx;
      window.__dest = dest;

      const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async function(constraints) {
        console.log("[Injected GUM] getUserMedia called. Returning permanent single-device audio destination.");
        if (audioCtx.state === "suspended") {
          await audioCtx.resume();
        }
        return dest.stream;
      };

      window.playAudioOnce = async function(base64Audio) {
        try {
          if (audioCtx.state === "suspended") {
            await audioCtx.resume();
          }
          const binaryStr = atob(base64Audio);
          const len = binaryStr.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer);
          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.loop = false; // NEVER LOOP
          source.connect(dest);
          source.start();
          console.log(`[In-Call Audio] Played alert ONCE (duration: ${audioBuffer.duration.toFixed(2)}s)`);
          return true;
        } catch (err) {
          console.error("[In-Call Audio] Error playing audio:", err);
          return false;
        }
      };
    });

    page.on("console", msg => console.log(`[Browser] ${msg.type()}: ${msg.text()}`));

    console.log("[VoiceSpeaker] Navigating to Matrix client...");
    await page.goto(MATRIX_URL, { waitUntil: "networkidle2" });
    await new Promise(r => setTimeout(r, 2000));

    // Check if login is required
    const isLoginPage = await page.$('input[name="usernameInput"]');
    if (isLoginPage) {
      console.log("[VoiceSpeaker] Logging in and establishing permanent device session...");
      await page.type('input[name="usernameInput"]', USERNAME);
      await page.type('input[name="passwordInput"]', PASSWORD);
      const loginButton = await page.$('button[type="submit"]') || (await page.$$('button'))[3];
      if (loginButton) await loginButton.click();
      await new Promise(r => setTimeout(r, 5000));
    } else {
      console.log("[VoiceSpeaker] Reusing existing authenticated permanent device session.");
    }

    // Select Rust space
    console.log("[VoiceSpeaker] Selecting Rust space...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const rustSpace = btns.find(b => b.innerText.trim() === "R" || b.innerText.trim() === "Ru");
      if (rustSpace) rustSpace.click();
    });
    await new Promise(r => setTimeout(r, 2000));

    // Open voice room
    console.log("[VoiceSpeaker] Opening voice room...");
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));
      const voiceLink = links.find(a => a.innerText.toLowerCase().includes("voice"));
      if (voiceLink) voiceLink.click();
    });
    await new Promise(r => setTimeout(r, 4000));

    // Click "Join" Call button if not already in call
    console.log("[VoiceSpeaker] Verifying call membership...");
    const joined = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const joinBtn = btns.find(b => b.innerText.trim().toLowerCase() === "join");
      if (joinBtn) {
        joinBtn.click();
        return true;
      }
      return false;
    });
    console.log("[VoiceSpeaker] Joined call:", joined);
    await new Promise(r => setTimeout(r, 5000));

    isReady = true;
    console.log("=========================================================================");
    console.log(" 🎙️ SINGLE PERMANENT BOT CONNECTED & STANDING BY IN VOICE CALL (NO DUPLICATES)");
    console.log("=========================================================================");

  } catch (err) {
    console.error("[VoiceSpeaker] Error initializing:", err.message);
    isReady = false;
    setTimeout(startVoiceSpeaker, 10000);
  }
}

// Local IPC HTTP server for on-demand alert speaking
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/speak-now") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        if (!data.audioBase64) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "audioBase64 required" }));
        }

        if (!page || !isReady) {
          res.writeHead(503, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Voice call speaker not ready yet" }));
        }

        console.log(`[VoiceSpeaker IPC] Speaking alert live into WebRTC call (single play): ${data.title || "Alert"}`);
        const result = await page.evaluate((b64) => window.playAudioOnce(b64), data.audioBase64);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, played: result }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(IPC_PORT, "127.0.0.1", () => {
  console.log(`[VoiceSpeaker IPC] Listening on 127.0.0.1:${IPC_PORT}`);
});

startVoiceSpeaker();
