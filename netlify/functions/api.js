const crypto = require("crypto");
const { connectLambda, getStore } = require("@netlify/blobs");

const DELETE_WINDOW_MS = 3 * 60 * 1000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const STORE_NAME = "our-sea-fish-tank";
const STATE_KEY = "state";
const MAX_MESSAGES = 100;
const DEFAULT_QUALITY_THRESHOLD = 75;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    },
    body: JSON.stringify(payload)
  };
}

function getClientId(event) {
  return String(event.headers["x-client-id"] || event.headers["X-Client-Id"] || "").slice(0, 120);
}

function getQualityThreshold(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(60, Math.min(95, Math.round(number))) : DEFAULT_QUALITY_THRESHOLD;
}

function isAdmin(event) {
  const expected = process.env.ADMIN_PASSWORD;
  const supplied = String(event.headers["x-admin-password"] || event.headers["X-Admin-Password"] || "");
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function requireAdmin(event) {
  if (!isAdmin(event)) throw Object.assign(new Error("管理员验证失败"), { status: 401 });
}

function getEightMonthCutoff() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 8);
  return cutoff.getTime();
}

function cleanupExpiredFish(state) {
  const cutoff = getEightMonthCutoff();
  // Keep legacy fish whose timestamp was not stored by an earlier deployment.
  const fish = state.fish.filter((item) => {
    const createdAt = Number(item.createdAt);
    return !Number.isFinite(createdAt) || createdAt >= cutoff;
  });
  return { fish, changed: fish.length !== state.fish.length };
}

function cleanupMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => String(message.content || "").trim())
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
    .slice(-MAX_MESSAGES);
}

function normalizeNewMessage(input) {
  const name = String(input.name || "").trim().slice(0, 32);
  const content = String(input.content || "").trim().replace(/\s+/g, " ").slice(0, 30);
  const sessionId = String(input.sessionId || "").slice(0, 120);
  if (!name || !content || !sessionId) {
    throw Object.assign(new Error("弹幕内容无效"), { status: 400 });
  }
  return { id: crypto.randomUUID(), name, content, sessionId, createdAt: Date.now() };
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

function clamp(value, min, max, fallback) {
  return Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
}

function normalizeNewFish(input, ownerId, state) {
  const name = String(input.name || "").trim().slice(0, 18);
  const src = String(input.src || "");
  if (!name) throw Object.assign(new Error("请先为小鱼取名"), { status: 400 });
  if (!/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(src) || src.length > 3_500_000) {
    throw Object.assign(new Error("鱼苗图片无效或过大"), { status: 400 });
  }
  if (!ownerId) throw Object.assign(new Error("缺少提交者标识"), { status: 400 });
  if (state.fish.some((fish) => fish.name.trim().toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"))) {
    throw Object.assign(new Error(`已经有这条叫${name}的小鱼了哦，请换个名字`), { status: 409 });
  }
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

function getRoute(event) {
  let path = event.queryStringParameters?.path;
  if (!path) {
    path = event.path || "";
    if (!path && event.rawUrl) path = new URL(event.rawUrl).pathname;
    path = String(path).replace(/^\/(?:\.netlify\/functions\/api|api)/, "");
  }
  return `/${decodeURIComponent(String(path || "").split("?")[0]).replace(/^\/+/, "")}`;
}

exports.handler = async (event) => {
  try {
    connectLambda(event);
    // Some Netlify projects do not expose the uncached edge endpoint required by strong reads.
    // The default Blob read mode works in both standard Functions and deployed sites.
    const store = getStore({ name: STORE_NAME });
    const stored = await store.get(STATE_KEY, { type: "json" });
    let state = {
      fish: Array.isArray(stored?.fish) ? stored.fish : [],
      messages: cleanupMessages(stored?.messages),
      qualityThreshold: getQualityThreshold(stored?.qualityThreshold)
    };
    const cleaned = cleanupExpiredFish(state);
    const messagesChanged = state.messages.length !== (Array.isArray(stored?.messages) ? stored.messages.length : 0);
    state = { fish: cleaned.fish, messages: state.messages, qualityThreshold: state.qualityThreshold };
    const clientId = getClientId(event);
    const route = getRoute(event);

    if (cleaned.changed || messagesChanged) await store.setJSON(STATE_KEY, state);

    if (event.httpMethod === "GET" && route === "/state") {
      return json(200, {
        fish: state.fish.map((fish) => presentFish(fish, clientId)),
        messages: state.messages,
        qualityThreshold: state.qualityThreshold,
        serverTime: Date.now()
      });
    }

    if (event.httpMethod === "POST" && route === "/admin/verify") {
      requireAdmin(event);
      return json(200, { ok: true, qualityThreshold: state.qualityThreshold });
    }

    if (event.httpMethod === "POST" && route === "/admin/settings") {
      requireAdmin(event);
      let input;
      try {
        input = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { error: "设置格式无效" });
      }
      state.qualityThreshold = getQualityThreshold(input.qualityThreshold);
      await store.setJSON(STATE_KEY, state);
      return json(200, { qualityThreshold: state.qualityThreshold });
    }

    if (event.httpMethod === "POST" && route === "/admin/fish/delete-batch") {
      requireAdmin(event);
      let input;
      try {
        input = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { error: "删除格式无效" });
      }
      const ids = new Set((Array.isArray(input.ids) ? input.ids : []).map((id) => String(id)).slice(0, 100));
      if (!ids.size) return json(400, { error: "请选择要删除的鱼苗" });
      const before = state.fish.length;
      state.fish = state.fish.filter((fish) => !ids.has(fish.id));
      await store.setJSON(STATE_KEY, state);
      return json(200, { removed: before - state.fish.length });
    }

    if (event.httpMethod === "DELETE" && route === "/admin/messages") {
      requireAdmin(event);
      state.messages = [];
      await store.setJSON(STATE_KEY, state);
      return json(200, { ok: true });
    }

    if (event.httpMethod === "POST" && route === "/messages") {
      if (Buffer.byteLength(event.body || "", "utf8") > 4096) return json(413, { error: "弹幕内容过长" });
      let input;
      try {
        input = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { error: "弹幕格式无效" });
      }
      const message = normalizeNewMessage(input);
      state.messages.push(message);
      state.messages = cleanupMessages(state.messages);
      await store.setJSON(STATE_KEY, state);
      return json(201, { message });
    }

    if (event.httpMethod === "POST" && route === "/fish") {
      if (Buffer.byteLength(event.body || "", "utf8") > MAX_BODY_BYTES) return json(413, { error: "请求数据过大" });
      let input;
      try {
        input = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { error: "请求格式无效" });
      }
      const fish = normalizeNewFish(input, clientId, state);
      state.fish.push(fish);
      await store.setJSON(STATE_KEY, state);
      return json(201, { fish: presentFish(fish, clientId) });
    }

    const match = route.match(/^\/fish\/([^/]+)(?:\/(like))?$/);
    if (match && event.httpMethod === "POST" && match[2] === "like") {
      const fish = state.fish.find((item) => item.id === decodeURIComponent(match[1]));
      if (!fish) return json(404, { error: "这条小鱼已经不在鱼缸里了" });
      fish.hearts = Math.max(0, Number(fish.hearts) || 0) + 1;
      await store.setJSON(STATE_KEY, state);
      return json(200, { fish: presentFish(fish, clientId) });
    }

    if (match && event.httpMethod === "DELETE" && !match[2]) {
      const id = decodeURIComponent(match[1]);
      const index = state.fish.findIndex((item) => item.id === id);
      if (index < 0) return json(404, { error: "这条小鱼已经不在鱼缸里了" });
      const fish = state.fish[index];
      if (!isAdmin(event) && (!clientId || fish.ownerId !== clientId || Date.now() - fish.createdAt > DELETE_WINDOW_MS)) {
        return json(403, { error: "只有自己三分钟内画的鱼可以删除" });
      }
      state.fish.splice(index, 1);
      await store.setJSON(STATE_KEY, state);
      return json(200, { ok: true });
    }

    return json(404, { error: "接口不存在" });
  } catch (error) {
    return json(error.status || 500, { error: error.message || "服务器错误" });
  }
};
