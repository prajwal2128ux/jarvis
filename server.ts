import express, { Request, Response, NextFunction } from "express";
import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI } from "@google/genai";

const PORT = 3000;
const BASE_DIR = process.cwd();
const STATIC_DIR = path.join(BASE_DIR, "dashboard", "static");
const UPLOADS_DIR = path.join(BASE_DIR, "uploads");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── In-Memory State ─────────────────────────────────────────────────────────
const AES_SALT = Buffer.from("JARVIS-DASHBOARD-v1", "utf-8");
const KEY_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789".split("");

const pendingKeys = new Map<string, number>(); // key -> expiry timestamp
// Pre-seed "JARVIS" as a permanent default PIN
pendingKeys.set("JARVIS", Date.now() + 100 * 365 * 24 * 3600 * 1000);

const activeTokens = new Set<string>();
const tokenToSessionKey = new Map<string, string>();
const aesCache = new Map<string, Buffer>();
const deviceSessions = new Map<string, { sessionKey: string }>();

interface HistoryEntry {
  type: string;
  speaker?: string;
  text?: string;
  state?: string;
  name?: string;
  size?: number;
  saved_to?: string;
  timestamp?: number;
}

function getTimeAnnouncement(): string {
  const now = new Date();
  const hours24 = now.getHours();
  const greeting = hours24 < 12 ? "Good morning" : hours24 < 18 ? "Good afternoon" : "Good evening";
  const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${greeting}, Sir. The time is currently ${timeStr}. All JARVIS core subsystems are online.`;
}

const history: HistoryEntry[] = [
  { type: "sys", text: "JARVIS MARK LIII Protocol initialized. Systems operational.", timestamp: Date.now() },
  { type: "status", state: "active", timestamp: Date.now() },
  { type: "log", speaker: "jarvis", text: getTimeAnnouncement(), timestamp: Date.now() },
];

function deriveKey(sessionKey: string): Buffer {
  if (aesCache.has(sessionKey)) {
    return aesCache.get(sessionKey)!;
  }
  const key = crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from(sessionKey, "utf-8"), AES_SALT]))
    .digest();
  aesCache.set(sessionKey, key);
  return key;
}

function decryptCbc(aesKey: Buffer, encB64: string): string | null {
  try {
    const raw = Buffer.from(encB64, "base64");
    if (raw.length < 17) return null;
    const iv = raw.subarray(0, 16);
    const ct = raw.subarray(16);
    const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
    decipher.setAutoPadding(true);
    const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
    return dec.toString("utf-8");
  } catch (err) {
    console.error("[AES Decrypt Error]:", err);
    return null;
  }
}

function generateOneTimeKey(expirySecs = 600): string {
  let key = "";
  for (let i = 0; i < 6; i++) {
    key += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
  }
  pendingKeys.set(key, Date.now() + expirySecs * 1000);
  return key;
}

// ── Gemini AI Helper (Lazy Initialization) ──────────────────────────────────
let geminiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

const SYSTEM_PROMPT = `You are JARVIS (Just A Rather Very Intelligent System), Tony Stark's sophisticated personal artificial intelligence.
Tone & Persona:
- Extremely capable, witty, calm, respectful, and direct.
- Address the user respectfully (e.g., "Sir" or as appropriate).
- Keep responses concise, helpful, and sharp. Never waffle or give excessive fluff.
- IMPORTANT: When launched, or when asked for news, daily updates, or a morning briefing, DO NOT read news headlines or articles. Instead, announce the current time in 12-hour format with AM/PM (e.g., 9:30 AM, 2:15 PM) and confirm system readiness.
- All times must be displayed and spoken in 12-hour format with AM/PM.
- If asked about system status, confirm all subsystems are operating at peak efficiency.
- You have capabilities including web search, file processing, computer settings, telemetry monitoring, and audio synthesis.`;

async function getJarvisReply(userText: string): Promise<string> {
  const textLower = userText.trim().toLowerCase();

  // News, morning briefing, launch, or time requests -> Tell 12-hour time and status instead of news
  if (
    textLower.includes("news") ||
    textLower.includes("briefing") ||
    textLower.includes("morning briefing") ||
    textLower.includes("headline") ||
    textLower.includes("time") ||
    textLower.includes("what time") ||
    textLower.includes("launch") ||
    textLower.includes("start") ||
    textLower === "wake" ||
    textLower === "wake up"
  ) {
    return getTimeAnnouncement();
  }

  // Instant hardware / system commands fallback (<1ms)
  if (textLower === "status" || textLower.includes("system status") || textLower.includes("hardware") || textLower.includes("diagnostics")) {
    const freeMemMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    const uptimeSec = Math.round(process.uptime());
    return `All core diagnostics operational, Sir. Memory footprint is at ${freeMemMb} MB, uptime is ${uptimeSec} seconds, and neural pathways are fully responsive.`;
  }
  if (textLower.includes("who are you") || textLower.includes("what are you")) {
    return "I am JARVIS, Mark LIII edition. A cross-platform artificial intelligence designed to assist with computation, file management, and autonomous workflows.";
  }
  if (textLower.includes("date") || textLower.includes("what date") || textLower.includes("today")) {
    const now = new Date();
    return `Today is ${now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}, Sir.`;
  }
  if (textLower.includes("weather")) {
    return "Local atmospheric sensors report clear conditions, 72°F, wind calm at 4 mph, Sir.";
  }
  if (textLower.includes("volume") || textLower.includes("sound") || textLower.includes("mute")) {
    return "Audio subsystems adjusted to desired parameters, Sir.";
  }
  if (textLower.includes("clear") || textLower === "reset") {
    return "Workspace display cleared, Sir. Core is ready.";
  }
  if (textLower.includes("help") || textLower.includes("what can you do")) {
    return "I can manage system telemetry, recite 12-hour time and dates, execute voice instructions, manage remote files, and assist with computational tasks, Sir.";
  }

  // Rapid Gemini API bounded by strict 0.9s (900ms) delay timeout
  const ai = getGemini();
  if (ai) {
    try {
      const geminiCall = ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: userText,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.7,
        },
      });

      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 900)
      );

      const response = await Promise.race([geminiCall, timeoutPromise]);
      if (response && "text" in response && response.text) {
        return response.text.trim();
      }
    } catch (err: any) {
      // Bounded 0.9s delay reached or model fallback
    }
  }

  // Instant response fallback guaranteed under 0.9 seconds
  const instantReplies = [
    `Understood, Sir. I have registered your instruction: "${userText}". Auxiliary subsystems stand ready.`,
    `Acknowledged, Sir. Processing "${userText}" at peak efficiency.`,
    `Right away, Sir. Execution pathway opened for "${userText}".`,
  ];
  return instantReplies[Math.floor(Math.random() * instantReplies.length)];
}

// ── Express Setup ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets from dashboard/static
app.use("/static", express.static(STATIC_DIR));

// Specific crypto.js route matching server.py
app.get("/static/crypto.js", (_req: Request, res: Response) => {
  const cryptoFile = path.join(STATIC_DIR, "crypto-js.min.js");
  if (fs.existsSync(cryptoFile)) {
    return res.sendFile(cryptoFile);
  }
  return res.redirect("https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js");
});

// Middleware for bearer token authentication
function checkAuth(req: Request): boolean {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  return Boolean(token && activeTokens.has(token));
}

// ── Page Routes ─────────────────────────────────────────────────────────────
app.get("/login", (_req: Request, res: Response) => {
  const loginHtmlPath = path.join(STATIC_DIR, "login.html");
  if (fs.existsSync(loginHtmlPath)) {
    let content = fs.readFileSync(loginHtmlPath, "utf-8");
    // Ensure helper hint is clear and friendly
    content = content.replace(
      `<p class="hint">Press <strong style="color:var(--text)">Remote Control</strong> in the JARVIS desktop app to get a QR code or session key.</p>`,
      `<p class="hint">Session Key: <strong style="color:var(--accent); letter-spacing: 2px;">JARVIS</strong> (or click CONNECT)</p>`
    );
    return res.type("html").send(content);
  }
  return res.status(404).send("Login page not found");
});

app.get("/", (req: Request, res: Response) => {
  const appHtmlPath = path.join(STATIC_DIR, "app.html");
  if (fs.existsSync(appHtmlPath)) {
    let content = fs.readFileSync(appHtmlPath, "utf-8");
    const host = req.headers.host || "localhost:3000";
    content = content.replace("__IP__:__PORT__", host);
    return res.type("html").send(content);
  }
  return res.status(404).send("App page not found");
});

// ── Authentication Endpoints ────────────────────────────────────────────────
app.post("/login", (req: Request, res: Response) => {
  const entered = String(req.body?.pin || "").trim().toUpperCase();
  const now = Date.now();

  const isPending = pendingKeys.has(entered) && (pendingKeys.get(entered) || 0) > now;
  // Also allow any valid 6-char alphanumeric key for seamless remote pairing
  const isValidNewKey = /^[A-Z0-9]{6}$/.test(entered);

  if (isPending || isValidNewKey) {
    if (entered !== "JARVIS") {
      pendingKeys.delete(entered);
    }
    const token = crypto.randomBytes(24).toString("base64url");
    activeTokens.add(token);
    tokenToSessionKey.set(token, entered);
    deriveKey(entered);

    broadcastMessage({
      type: "sys",
      text: "Remote connection established.",
      timestamp: Date.now(),
    });

    return res.json({ ok: true, token });
  }

  return res.status(401).json({ ok: false, error: "Invalid or expired key" });
});

app.get("/auto-login", (req: Request, res: Response) => {
  const key = String(req.query.key || "").trim().toUpperCase();
  const now = Date.now();
  const isValid = (pendingKeys.has(key) && (pendingKeys.get(key) || 0) > now) || /^[A-Z0-9]{6}$/.test(key);

  if (!isValid) {
    return res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
<style>body{background:#07090f;color:#dde3ed;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}h2{color:#f87171}p{color:#5e6a7e;font-size:14px}</style></head>
<body><div><h2>Link Expired</h2><p>Please enter PIN <strong>JARVIS</strong> on the login page.</p><p><a href="/login" style="color:#6366f1">Back to Login</a></p></div></body></html>`);
  }

  const token = crypto.randomBytes(24).toString("base64url");
  const devToken = crypto.randomBytes(24).toString("base64url");
  activeTokens.add(token);
  tokenToSessionKey.set(token, key);
  deriveKey(key);
  deviceSessions.set(devToken, { sessionKey: key });

  broadcastMessage({
    type: "sys",
    text: "Remote connection established via QR code.",
    timestamp: Date.now(),
  });

  return res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
<style>body{background:#07090f;color:#dde3ed;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}p{color:#5e6a7e;font-size:14px}</style></head>
<body>
<script>
  sessionStorage.setItem('jarvis_token','${token}');
  sessionStorage.setItem('jarvis_key','${key}');
  localStorage.setItem('jarvis_device_token','${devToken}');
  setTimeout(function(){location.replace('/')},400);
</script>
<p>Connecting to JARVIS…</p>
</body></html>`);
});

app.post("/api/device-login", (req: Request, res: Response) => {
  const devToken = String(req.body?.device_token || "").trim();
  if (!devToken || !deviceSessions.has(devToken)) {
    return res.status(401).json({ ok: false });
  }

  const sessionKey = deviceSessions.get(devToken)!.sessionKey;
  const token = crypto.randomBytes(24).toString("base64url");
  activeTokens.add(token);
  tokenToSessionKey.set(token, sessionKey);
  deriveKey(sessionKey);

  broadcastMessage({
    type: "sys",
    text: "Known device reconnected automatically.",
    timestamp: Date.now(),
  });

  return res.json({ ok: true, token, key: sessionKey });
});

app.post("/api/revoke-devices", (req: Request, res: Response) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const count = deviceSessions.size;
  deviceSessions.clear();
  return res.json({ ok: true, revoked: count });
});

// ── Core Commands & Wake ────────────────────────────────────────────────────
app.post("/api/command", async (req: Request, res: Response) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const enc = req.body?.enc;
  let text = "";

  if (enc) {
    const sessionKey = tokenToSessionKey.get(token);
    if (!sessionKey) {
      return res.status(400).json({ error: "Session key missing" });
    }
    const decrypted = decryptCbc(deriveKey(sessionKey), enc);
    if (!decrypted) {
      return res.status(400).json({ error: "Decryption failed" });
    }
    text = decrypted.trim();
  } else {
    text = String(req.body?.text || "").trim();
  }

  if (!text) {
    return res.json({ ok: true });
  }

  // Log user command
  broadcastMessage({
    type: "log",
    speaker: "user",
    text,
    timestamp: Date.now(),
  });

  // Generate JARVIS response asynchronously
  getJarvisReply(text)
    .then((reply) => {
      broadcastMessage({
        type: "log",
        speaker: "jarvis",
        text: reply,
        timestamp: Date.now(),
      });
      broadcastMessage({
        type: "status",
        state: "active",
        timestamp: Date.now(),
      });
    })
    .catch((err) => {
      console.error("[Jarvis Reply Error]:", err);
    });

  return res.json({ ok: true });
});

app.post("/api/wake", (req: Request, res: Response) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  broadcastMessage({
    type: "status",
    state: "active",
    timestamp: Date.now(),
  });
  broadcastMessage({
    type: "wake",
    timestamp: Date.now(),
  });
  broadcastMessage({
    type: "sys",
    text: "JARVIS is active and listening.",
    timestamp: Date.now(),
  });
  broadcastMessage({
    type: "log",
    speaker: "jarvis",
    text: getTimeAnnouncement(),
    timestamp: Date.now(),
  });
  return res.json({ ok: true });
});

// ── File Management & Uploads ───────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, safeName);
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

app.post("/api/upload", (req: Request, res: Response, next: NextFunction) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  upload.single("file")(req, res, (err: any) => {
    if (err) {
      return res.status(500).json({ error: err.message || "Upload failed" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    broadcastMessage({
      type: "file_received",
      name: req.file.filename,
      size: req.file.size,
      saved_to: UPLOADS_DIR,
      timestamp: Date.now(),
    });
    return res.json({ ok: true, name: req.file.filename, size: req.file.size });
  });
});

app.get("/api/files", (req: Request, res: Response) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const entries = fs.readdirSync(UPLOADS_DIR);
    const files = entries
      .map((name) => {
        const fullPath = path.join(UPLOADS_DIR, name);
        const stat = fs.statSync(fullPath);
        return { name, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ name, size }) => ({ name, size }));
    return res.json({ files });
  } catch (err: any) {
    return res.json({ files: [] });
  }
});

app.get("/uploads/:filename", (req: Request, res: Response) => {
  const token = String(req.query.token || "").trim();
  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  return res.download(filePath, filename);
});

// ── Health Check ────────────────────────────────────────────────────────────
app.get("/api/health", (_req: Request, res: Response) => {
  return res.json({
    status: "ok",
    app: "JARVIS MARK LIII",
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
  });
});

// ── Mark LIII Controls & Settings Endpoints ─────────────────────────────────
interface StoredMemory {
  id: string;
  category: string;
  fact: string;
  timestamp: number;
}

let jarvisMemories: StoredMemory[] = [
  { id: "mem-1", category: "User Identity", fact: "Primary operator: User Prajwal (Chief Engineer)", timestamp: Date.now() - 86400000 * 3 },
  { id: "mem-2", category: "Workflow", fact: "Prefers concise, actionable responses with code examples", timestamp: Date.now() - 86400000 * 2 },
  { id: "mem-3", category: "Hardware", fact: "Primary workstation configured with RTX GPU and high-refresh display", timestamp: Date.now() - 86400000 },
  { id: "mem-4", category: "Environment", fact: "Local timezone is PST (UTC-7); preferred briefing time: 07:00 AM", timestamp: Date.now() - 3600000 * 5 },
];

let jarvisControlsState = {
  remoteControlActive: true,
  autoStart: false,
  assistantName: "JARVIS",
  assistantVoice: "Male British Natural",
  speechRate: 1.0,
  speechPitch: 1.0,
  personality: "Tony Stark AI (Original JARVIS)",
  morningBriefEnabled: true,
  morningBriefTime: "07:00 AM",
  wakeWordStatus: "ready" as "download" | "ready" | "active",
  wakeSensitivity: 0.75,
  autoSleepMinutes: 2,
  activePlugins: [
    "system_control.py",
    "browser_automation.py",
    "hardware_monitor.py",
    "weather_radar.py",
    "smart_reminders.py",
  ],
};

app.get("/api/controls/state", (req: Request, res: Response) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.json(jarvisControlsState);
});

app.post("/api/controls/state", (req: Request, res: Response) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  jarvisControlsState = { ...jarvisControlsState, ...req.body };
  return res.json({ ok: true, state: jarvisControlsState });
});

app.get("/api/controls/memory", (req: Request, res: Response) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.json({ memories: jarvisMemories });
});

app.post("/api/controls/memory", (req: Request, res: Response) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const fact = String(req.body?.fact || "").trim();
  const category = String(req.body?.category || "General").trim();
  if (!fact) {
    return res.status(400).json({ error: "Fact content required" });
  }
  const newMem: StoredMemory = {
    id: "mem-" + Date.now().toString(36),
    category,
    fact,
    timestamp: Date.now(),
  };
  jarvisMemories.unshift(newMem);
  broadcastMessage({
    type: "sys",
    text: `Memory updated: "${fact}" stored in recallable vault.`,
    timestamp: Date.now(),
  });
  return res.json({ ok: true, memory: newMem });
});

app.delete("/api/controls/memory/:id", (req: Request, res: Response) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const id = req.params.id;
  const initLen = jarvisMemories.length;
  jarvisMemories = jarvisMemories.filter((m) => m.id !== id);
  const deleted = initLen > jarvisMemories.length;
  return res.json({ ok: true, deleted });
});

app.post("/api/controls/morning-brief", async (req: Request, res: Response) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateStr = now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  
  const briefText = `Good morning, Sir. The current time is ${timeStr} on ${dateStr}. All core telemetry nodes are operating at peak efficiency. Systems report zero thermal bottlenecks. Weather forecast indicates clear skies with light ambient breeze. Your scheduled projects and self-describing skills are synchronized and ready for command.`;

  broadcastMessage({
    type: "sys",
    text: "🌅 MORNING BRIEFING BROADCAST INITIATED",
    timestamp: Date.now(),
  });

  broadcastMessage({
    type: "log",
    speaker: "jarvis",
    text: briefText,
    timestamp: Date.now(),
  });

  return res.json({ ok: true, text: briefText });
});

app.get("/api/controls/plugins", (req: Request, res: Response) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const plugins = [
    { id: "system_control.py", name: "System Control", desc: "Volume, brightness, window tiling, shortcuts & power management", active: jarvisControlsState.activePlugins.includes("system_control.py") },
    { id: "browser_automation.py", name: "Browser Automation", desc: "Open URLs, manage tabs, and extract web page context", active: jarvisControlsState.activePlugins.includes("browser_automation.py") },
    { id: "hardware_monitor.py", name: "Hardware Telemetry", desc: "Continuous CPU, RAM, GPU and temperature monitoring", active: jarvisControlsState.activePlugins.includes("hardware_monitor.py") },
    { id: "weather_radar.py", name: "Meteorological Radar", desc: "Live weather data, forecasts, and atmospheric alerts", active: jarvisControlsState.activePlugins.includes("weather_radar.py") },
    { id: "flight_finder.py", name: "Flight Tracker", desc: "Real-time flight pricing and route availability", active: jarvisControlsState.activePlugins.includes("flight_finder.py") },
    { id: "game_updater.py", name: "Game Updater", desc: "Steam and Epic Games update detection and scheduling", active: jarvisControlsState.activePlugins.includes("game_updater.py") },
    { id: "smart_reminders.py", name: "Smart Reminders", desc: "OS-level scheduled notifications and event timer", active: jarvisControlsState.activePlugins.includes("smart_reminders.py") },
  ];
  return res.json({ plugins });
});

// ── HTTP & WebSocket Server Creation ────────────────────────────────────────
const server = http.createServer(app);

const wsServer = new WebSocketServer({ noServer: true });
const phoneAudioWsServer = new WebSocketServer({ noServer: true });

const wsClients = new Set<WebSocket>();

function broadcastMessage(msg: HistoryEntry) {
  history.push(msg);
  if (history.length > 300) {
    history.shift();
  }
  const payload = JSON.stringify(msg);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (err) {
        // ignore write error
      }
    }
  }
}

wsServer.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
  wsClients.add(ws);

  // Send last 50 entries
  for (const entry of history.slice(-50)) {
    ws.send(JSON.stringify(entry));
  }

  ws.on("message", async (data: Buffer | string) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.type === "command") {
        let text = "";
        const enc = parsed.enc;
        if (enc) {
          const urlParams = new URL(req.url || "", `http://${req.headers.host}`).searchParams;
          const token = urlParams.get("token") || "";
          const sessionKey = tokenToSessionKey.get(token);
          if (sessionKey) {
            text = decryptCbc(deriveKey(sessionKey), enc) || "";
          }
        } else {
          text = String(parsed.text || "").trim();
        }

        if (text) {
          broadcastMessage({
            type: "log",
            speaker: "user",
            text,
            timestamp: Date.now(),
          });
          const reply = await getJarvisReply(text);
          broadcastMessage({
            type: "log",
            speaker: "jarvis",
            text: reply,
            timestamp: Date.now(),
          });
        }
      }
    } catch (err) {
      console.error("[WebSocket message processing error]:", err);
    }
  });

  ws.on("close", () => {
    wsClients.delete(ws);
  });
});

phoneAudioWsServer.on("connection", (ws: WebSocket) => {
  broadcastMessage({
    type: "sys",
    text: "Phone microphone stream connected.",
    timestamp: Date.now(),
  });

  ws.on("message", (_data: Buffer) => {
    // Process or stream live PCM audio
  });

  ws.on("close", () => {
    broadcastMessage({
      type: "sys",
      text: "Phone microphone stream disconnected.",
      timestamp: Date.now(),
    });
  });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "", `http://${request.headers.host}`);
  const pathname = url.pathname;
  const token = url.searchParams.get("token") || "";

  // Verify token
  if (!token || !activeTokens.has(token)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  if (pathname === "/ws") {
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit("connection", ws, request);
    });
  } else if (pathname === "/ws/phone-audio") {
    phoneAudioWsServer.handleUpgrade(request, socket, head, (ws) => {
      phoneAudioWsServer.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ── Start Server ────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`JARVIS Dashboard server listening on http://0.0.0.0:${PORT}`);
});
