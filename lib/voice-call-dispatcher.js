const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const https = require("https");
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
    password: process.env.MATRIX_PASSWORD || cfg.matrix?.password || "",
    voiceRoomId: process.env.MATRIX_VOICE_ROOM_ID || cfg.matrix?.voiceCallRoomId || cfg.matrix?.rooms?.voiceCall || ""
  };
}

const vCfg = getVoiceConfig();
const MATRIX_URL = vCfg.matrixUrl;
const USERNAME = vCfg.username;
const PASSWORD = vCfg.password;
const VOICE_ROOM_ID = vCfg.voiceRoomId;
const PROFILE_DIR = path.join(__dirname, "..", "data", "browser_profile");

// Queue to prevent concurrent browser collision
let isSpeaking = false;
const queue = [];

function cleanLocks() {
  try {
    if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
    const files = fs.readdirSync(PROFILE_DIR);
    for (const f of files) {
      if (f.startsWith("Singleton") || f === "lockfile") {
        try { fs.unlinkSync(path.join(PROFILE_DIR, f)); } catch(e) {}
      }
    }
  } catch(e) {}
}

function req(apiPath, method="GET", token=null, data=null) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${MATRIX_URL}${apiPath}`);
    const postData = data ? JSON.stringify(data) : "";
    const r = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + (u.search||""),
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "Authorization": `Bearer ${token}` } : {}),
        ...(postData ? { "Content-Length": Buffer.byteLength(postData) } : {})
      }
    }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(body||"{}") }));
    });
    r.on("error", reject);
    if (postData) r.write(postData);
    r.end();
  });
}

async function clearRoomCallMemberships() {
  try {
    const loginRes = await req("/_matrix/client/v3/login", "POST", null, {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: USERNAME },
      password: PASSWORD
    });
    const token = loginRes.data.access_token;
    if (!token) return;

    const stateRes = await req(`/_matrix/client/v3/rooms/${encodeURIComponent(VOICE_ROOM_ID)}/state`, "GET", token);
    const callMembers = (stateRes.data || []).filter(e => e.type === "org.matrix.msc3401.call.member" && e.sender === `@${USERNAME}:voice.trylocalhost.com`);
    
    for (const m of callMembers) {
      if (Object.keys(m.content || {}).length > 0) {
        await req(
          `/_matrix/client/v3/rooms/${encodeURIComponent(VOICE_ROOM_ID)}/state/org.matrix.msc3401.call.member/${encodeURIComponent(m.state_key)}`,
          "PUT",
          token,
          {}
        );
      }
    }
  } catch (err) {
    console.warn("[VoiceDispatcher] Clear state notice:", err.message);
  }
}

async function processQueue() {
  if (isSpeaking || queue.length === 0) return;
  isSpeaking = true;
  const item = queue.shift();

  try {
    await executeSpeakAndDisconnect(item.text, item.title, item.voice);
    item.resolve({ success: true, spoken: true, title: item.title, text: item.text });
  } catch (err) {
    console.error("[VoiceDispatcher] Error during voice transmission:", err);
    item.reject(err);
  } finally {
    isSpeaking = false;
    if (queue.length > 0) {
      setTimeout(processQueue, 1000);
    }
  }
}

async function executeSpeakAndDisconnect(text, title = "Tactical Alert", voice = "en-US-ChristopherNeural") {
  console.log(`[VoiceDispatcher] ===> Initiating ephemeral voice call alert: "${title}"`);
  
  // 1. Synthesize 150% speed audio with edge-tts
  const tmpDir = "/opt/rustplus-manager/data/audio";
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const wavPath = path.join(tmpDir, `live_${Date.now()}.wav`);
  const mp3Path = path.join(tmpDir, `live_${Date.now()}.mp3`);

  const sanitizedText = String(text).split('"').join(' ').split("'").join(' ').split('\n').join(' ');
  execSync(`python3 -m edge_tts --voice "${voice}" --rate "+50%" --text "${sanitizedText}" --write-media "${mp3Path}"`, { timeout: 15000 });
  
  execSync(`ffmpeg -y -i "${mp3Path}" -ar 48000 -ac 1 "${wavPath}"`, { stdio: "ignore" });
  const audioBase64 = fs.readFileSync(wavPath).toString("base64");

  // 2. Launch Chromium with clean locks
  cleanLocks();
  console.log("[VoiceDispatcher] Connecting to Matrix call...");
  const browser = await puppeteer.launch({
    executablePath: "/snap/bin/chromium",
    headless: "new",
    userDataDir: PROFILE_DIR,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}`,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-web-security"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    const context = browser.defaultBrowserContext();
    await context.overridePermissions(MATRIX_URL, ["microphone", "camera", "notifications"]);

    // Inject Web Audio Destination into getUserMedia
    await page.evaluateOnNewDocument((b64) => {
      window.__injectedAudio = b64;
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const dest = audioCtx.createMediaStreamDestination();

      const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async function(constraints) {
        if (audioCtx.state === "suspended") await audioCtx.resume();

        const binaryStr = atob(window.__injectedAudio);
        const len = binaryStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);

        const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer);
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.loop = false; // SINGLE PLAY
        source.connect(dest);
        source.start();
        console.log(`[In-Call] Spoke audio once (duration: ${audioBuffer.duration.toFixed(2)}s)`);
        window.__audioDuration = audioBuffer.duration;

        return dest.stream;
      };
    }, audioBase64);

    // Navigate to Cinny
    await page.goto(MATRIX_URL, { waitUntil: "networkidle2" });
    await new Promise(r => setTimeout(r, 1500));

    // Log in if not authenticated
    const isLoginPage = await page.$('input[name="usernameInput"]');
    if (isLoginPage) {
      console.log("[VoiceDispatcher] Authenticating session...");
      await page.type('input[name="usernameInput"]', USERNAME);
      await page.type('input[name="passwordInput"]', PASSWORD);
      const loginBtn = await page.$('button[type="submit"]') || (await page.$$('button'))[3];
      if (loginBtn) await loginBtn.click();
      await new Promise(r => setTimeout(r, 4000));
    }

    // Select Rust space
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const rustSpace = btns.find(b => b.innerText.trim() === "R" || b.innerText.trim() === "Ru");
      if (rustSpace) rustSpace.click();
    });
    await new Promise(r => setTimeout(r, 1500));

    // Open voice room
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));
      const voiceLink = links.find(a => a.innerText.toLowerCase().includes("voice"));
      if (voiceLink) voiceLink.click();
    });
    await new Promise(r => setTimeout(r, 3000));

    // Join the call
    console.log("[VoiceDispatcher] Joining WebRTC call room...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const joinBtn = btns.find(b => b.innerText.trim().toLowerCase() === "join");
      if (joinBtn) joinBtn.click();
    });

    console.log("[VoiceDispatcher] Connected! Speaking alert in live call...");
    // Wait 5 seconds for WebRTC handshake + audio delivery + buffer
    await new Promise(r => setTimeout(r, 6500));

    // Cleanly hang up / disconnect from the call
    console.log("[VoiceDispatcher] Hanging up and leaving call...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const endBtn = btns.find(b => b.innerText.trim().toLowerCase() === "end");
      if (endBtn) endBtn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

  } finally {
    await browser.close();
    cleanLocks();
    // Clean up room state so 0 ghost call members remain
    await clearRoomCallMemberships();
    console.log("[VoiceDispatcher] <=== Disconnected cleanly. Call ended.");
  }
}

function speakAlert(text, title = "Tactical Alert", voice = "en-US-ChristopherNeural") {
  return new Promise((resolve, reject) => {
    queue.push({ text, title, voice, resolve, reject });
    processQueue();
  });
}

module.exports = { speakAlert };
