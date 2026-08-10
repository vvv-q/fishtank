const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "fish.json");
const DELETE_WINDOW_MS = 3 * 60 * 1000;
const MAX_MESSAGES = 160;
const MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_QUALITY_THRESHOLD = 75;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PUBLIC_EXTENSIONS = new Set([".html", ".css", ".js", ".png", ".jpg", ".jpeg", ".webp", ".ttf", ".woff2", ".txt"]);
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

fs.mkdirSync(DATA_DIR, { recursive: true });
let database = readDatabase();
cleanupExpiredFish();

function readDatabase() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      fish: Array.isArray(parsed.fish) ? parsed.fish : [],
      messages: cleanupMessages(parsed.messages),
      qualityThreshold: getQualityThreshold(parsed.qualityThreshold)
    };
  } catch {
    return { fish: [], messages: [], qualityThreshold: DEFAULT_QUALITY_THRESHOLD };
  }
}

function cleanupMessages(messages) {
  const cutoff = Date.now() - MESSAGE_RETENTION_MS;
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => Number(message.createdAt) >= cutoff && String(message.content || "").trim())
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
    .slice(-MAX_MESSAGES);
}

function getQualityThreshold(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(60, Math.min(95, Math.round(number))) : DEFAULT_QUALITY_THRESHOLD;
}

function isAdmin(request) {
  const expected = process.env.ADMIN_PASSWORD;
  const supplied = String(request.headers["x-admin-password"] || "");
  return Boolean(expected && supplied && expected === supplied);
}

function persistDatabase() {
  const temporary = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(database, null, 2), "utf8");
  fs.renameSync(temporary, DATA_FILE);
}

function getEightMonthCutoff() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 8);
  return cutoff.getTime();
}

function cleanupExpiredFish() {
  const cutoff = getEightMonthCutoff();
  const before = database.fish.length;
  database.fish = database.fish.filter((fish) => {
    const createdAt = Number(fish.createdAt);
    return !Number.isFinite(createdAt) || createdAt >= cutoff;
  });
  if (database.fish.length !== before) persistDatabase();
}

function getClientId(request) {
  return String(request.headers["x-client-id"] || "").slice(0, 120);
}

function presentFish(fish, clientId) {
  const { ownerId, ...publicFish } = fish;
  const isMine = Boolean(clientId && ownerId === clientId);
  return {
    ...publicFish,
    isMine,
    canDelete: Boolean(isMine && Date.now() - fish.createdAt <= DELETE_WINDOW_MS)
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("请求数据过大"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("请求格式无效"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function normalizeNewFish(input, ownerId) {
  const name = String(input.name || "").trim().slice(0, 18);
  const src = String(input.src || "");
  if (!name) throw Object.assign(new Error("请先为小鱼取名"), { status: 400 });
  if (!/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(src) || src.length > 3_500_000) {
    throw Object.assign(new Error("鱼苗图片无效或过大"), { status: 400 });
  }
  if (!ownerId) throw Object.assign(new Error("缺少提交者标识"), { status: 400 });
  if (database.fish.some((fish) => fish.name.trim().toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"))) {
    throw Object.assign(new Error(`已经有这条叫${name}的小鱼了哦，请换个名字`), { status: 409 });
  }

  const clamp = (value, min, max, fallback) => Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Number(value)))
    : fallback;
  return {
    id: crypto.randomUUID(),
    name,
    src,
    imageWidth: clamp(input.imageWidth, 1, 900, 180),
    imageHeight: clamp(input.imageHeight, 1, 900, 90),
    createdAt: Date.now(),
    hearts: 0,
    x: clamp(input.x, 0, 1, Math.random()),
    y: clamp(input.y, 0.12, 0.78, 0.45),
    speed: clamp(Math.abs(input.speed), 0.008, 0.08, 0.025),
    size: clamp(input.size, 54, 180, 108),
    depth: clamp(input.depth, 0.18, 0.96, 0.52),
    facing: input.facing === -1 ? -1 : 1,
    swimDirection: input.swimDirection === -1 ? -1 : 1,
    orientationVersion: 2,
    bob: clamp(input.bob, 0, Math.PI * 2, Math.random() * Math.PI * 2),
    ownerId
  };
}

function normalizeNewMessage(input) {
  const name = String(input.name || "").trim().slice(0, 32);
  const content = String(input.content || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const sessionId = String(input.sessionId || "").slice(0, 120);
  if (!name || !content || !sessionId) throw Object.assign(new Error("弹幕内容无效"), { status: 400 });
  return { id: crypto.randomUUID(), name, content, sessionId, createdAt: Date.now() };
}

async function handleApi(request, response, url) {
  cleanupExpiredFish();
  const clientId = getClientId(request);

  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, {
      fish: database.fish.map((fish) => presentFish(fish, clientId)),
      messages: database.messages,
      qualityThreshold: database.qualityThreshold,
      serverTime: Date.now()
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/verify") {
    if (!isAdmin(request)) throw Object.assign(new Error("管理员验证失败"), { status: 401 });
    sendJson(response, 200, { ok: true, qualityThreshold: database.qualityThreshold });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/settings") {
    if (!isAdmin(request)) throw Object.assign(new Error("管理员验证失败"), { status: 401 });
    database.qualityThreshold = getQualityThreshold((await readJson(request)).qualityThreshold);
    persistDatabase();
    sendJson(response, 200, { qualityThreshold: database.qualityThreshold });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/messages") {
    const message = normalizeNewMessage(await readJson(request));
    database.messages.push(message);
    database.messages = cleanupMessages(database.messages);
    persistDatabase();
    sendJson(response, 201, { message });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/fish") {
    const input = await readJson(request);
    const fish = normalizeNewFish(input, clientId);
    database.fish.push(fish);
    persistDatabase();
    sendJson(response, 201, { fish: presentFish(fish, clientId) });
    return;
  }

  const match = url.pathname.match(/^\/api\/fish\/([^/]+)(?:\/(like))?$/);
  if (match && request.method === "POST" && match[2] === "like") {
    const fish = database.fish.find((item) => item.id === match[1]);
    if (!fish) throw Object.assign(new Error("这条小鱼已经不在鱼缸里了"), { status: 404 });
    fish.hearts = Math.max(0, Number(fish.hearts) || 0) + 1;
    persistDatabase();
    sendJson(response, 200, { fish: presentFish(fish, clientId) });
    return;
  }

  if (match && request.method === "DELETE" && !match[2]) {
    const index = database.fish.findIndex((item) => item.id === match[1]);
    if (index < 0) throw Object.assign(new Error("这条小鱼已经不在鱼缸里了"), { status: 404 });
    const fish = database.fish[index];
    if (!isAdmin(request) && (!clientId || fish.ownerId !== clientId || Date.now() - fish.createdAt > DELETE_WINDOW_MS)) {
      throw Object.assign(new Error("只有自己三分钟内画的鱼可以删除"), { status: 403 });
    }
    database.fish.splice(index, 1);
    persistDatabase();
    sendJson(response, 200, { ok: true });
    return;
  }

  throw Object.assign(new Error("接口不存在"), { status: 404 });
}

function serveStatic(request, response, url) {
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const extension = path.extname(relative).toLowerCase();
  const filePath = path.resolve(ROOT, relative);
  const isPublicPath = relative === "index.html" || relative.startsWith("assets/");
  if (!isPublicPath || !PUBLIC_EXTENSIONS.has(extension) || !filePath.startsWith(`${ROOT}${path.sep}`)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": extension === ".ttf" ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else serveStatic(request, response, url);
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.message || "服务器错误" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Our Sea is running at http://localhost:${PORT}`);
});

setInterval(cleanupExpiredFish, 60 * 60 * 1000).unref();
