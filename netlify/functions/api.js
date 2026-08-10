const crypto = require("crypto");
const { connectLambda, getStore } = require("@netlify/blobs");

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const STORE_NAME = "our-sea-fish-tank";
const STATE_KEY = "state";
const MAX_MESSAGES = 100;
const DEFAULT_QUALITY_THRESHOLD = 75;
const ACCOUNT_RENAME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DAILY_LIKES_PER_FISH = 50;
const DAILY_FOOD_REWARD = 15;

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

function getAccount(event, state) {
  const username = String(event.headers["x-account-name"] || "").trim();
  const password = String(event.headers["x-account-password"] || "");
  const account = (state.accounts || []).find((item) => item.username === username);
  if (!account || !password || !/^[a-f0-9]{128}$/i.test(String(account.hash || ""))) return null;
  const hash = crypto.scryptSync(password, account.salt, 64).toString("hex");
  const actual = Buffer.from(account.hash, "hex");
  return actual.length === 64 && crypto.timingSafeEqual(Buffer.from(hash, "hex"), actual) ? account : null;
}

function requireAccount(event, state) {
  const account = getAccount(event, state);
  if (!account) throw Object.assign(new Error("请先登录后再操作"), { status: 401 });
  return account;
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

function getTodayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function cleanupLikeLimits(likeLimits) {
  const today = getTodayKey();
  return Object.fromEntries(Object.entries(likeLimits || {}).filter(([key, value]) => (
    key.startsWith(`${today}|`) && Number(value) > 0
  )));
}

function presentAccount(account) {
  if (!account) return null;
  return {
    username: account.username,
    food: Math.max(0, Number(account.food) || 0),
    lastFoodClaimDay: account.lastFoodClaimDay || "",
    lastRenamedAt: Number(account.lastRenamedAt) || 0
  };
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

function presentFish(fish, clientId, account) {
  const { ownerId, ...publicFish } = fish;
  const isMine = Boolean((account && ownerId === account.username) || (clientId && ownerId === clientId));
  return {
    ...publicFish,
    isMine,
    canDelete: isMine
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
    food: 0,
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
      accounts: Array.isArray(stored?.accounts) ? stored.accounts : [],
      likeLimits: cleanupLikeLimits(stored?.likeLimits),
      qualityThreshold: getQualityThreshold(stored?.qualityThreshold)
    };
    const cleaned = cleanupExpiredFish(state);
    const messagesChanged = state.messages.length !== (Array.isArray(stored?.messages) ? stored.messages.length : 0);
    state.fish = cleaned.fish.map((fish) => fish.ownerAccount ? fish : { ...fish, ownerId: "管理员", ownerAccount: "管理员" });
    state = { fish: state.fish, messages: state.messages, accounts: state.accounts, likeLimits: state.likeLimits, qualityThreshold: state.qualityThreshold };
    const clientId = getClientId(event);
    const route = getRoute(event);

    if (cleaned.changed || messagesChanged) await store.setJSON(STATE_KEY, state);

    if (event.httpMethod === "GET" && route === "/state") {
      const account = getAccount(event, state);
      return json(200, {
        fish: state.fish.map((fish) => presentFish(fish, clientId, account)),
        messages: state.messages,
        account: presentAccount(account),
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
      if (!ids.size) return json(400, { error: "请选择要放生的鱼苗" });
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

    if (event.httpMethod === "POST" && route === "/admin/messages/delete-batch") {
      requireAdmin(event);
      let input;
      try {
        input = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { error: "删除格式无效" });
      }
      const ids = new Set((Array.isArray(input.ids) ? input.ids : []).map((id) => String(id)).slice(0, MAX_MESSAGES));
      if (!ids.size) return json(400, { error: "请选择要删除的弹幕" });
      const before = state.messages.length;
      state.messages = state.messages.filter((message) => !ids.has(message.id));
      await store.setJSON(STATE_KEY, state);
      return json(200, { removed: before - state.messages.length });
    }

    if (event.httpMethod === "POST" && route === "/messages") {
      if (Buffer.byteLength(event.body || "", "utf8") > 4096) return json(413, { error: "弹幕内容过长" });
      let input;
      try {
        input = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { error: "弹幕格式无效" });
      }
      const account = getAccount(event, state);
      if (!account && !isAdmin(event)) {
        return json(401, { error: "请先登录后再发送弹幕" });
      }
      input.name = isAdmin(event) ? "管理员-v" : account.username;
      const message = normalizeNewMessage(input);
      state.messages.push(message);
      state.messages = cleanupMessages(state.messages);
      await store.setJSON(STATE_KEY, state);
      return json(201, { message });
    }

    if (event.httpMethod === "POST" && route === "/auth/register") {
      const input = JSON.parse(event.body || "{}");
      const username = String(input.username || "").trim().slice(0, 18);
      const password = String(input.password || "");
      if (!/^[\w\u4e00-\u9fa5]{2,18}$/.test(username) || password.length < 6) return json(400, { error: "用户名为 2-18 位，密码至少 6 位" });
      if (state.accounts.some((item) => item.username === username)) {
        return json(409, { error: `已经有叫${username}的账户了哦，请换一个名字` });
      }
      state.accounts.push({ username, salt: crypto.randomBytes(16).toString("hex"), hash: "", lastRenamedAt: 0, food: 0, lastFoodClaimDay: "" });
      state.accounts.at(-1).hash = crypto.scryptSync(password, state.accounts.at(-1).salt, 64).toString("hex");
      await store.setJSON(STATE_KEY, state);
      return json(201, { username });
    }

    if (event.httpMethod === "POST" && route === "/auth/login") {
      const account = requireAccount(event, state);
      return json(200, presentAccount(account));
    }

    if (event.httpMethod === "POST" && route === "/auth/rename") {
      let input;
      try {
        input = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { error: "账户名格式无效" });
      }
      const account = requireAccount(event, state);
      const username = String(input.username || "").trim().slice(0, 18);
      if (!/^[\w\u4e00-\u9fa5]{2,18}$/.test(username)) {
        return json(400, { error: "账户名为 2-18 位" });
      }
      if (username === account.username) return json(200, { username, lastRenamedAt: Number(account.lastRenamedAt) || 0 });
      if (state.accounts.some((item) => item.username === username)) {
        return json(409, { error: `已经有叫${username}的账户了哦，请换一个名字` });
      }
      const now = Date.now();
      const lastRenamedAt = Number(account.lastRenamedAt) || 0;
      if (lastRenamedAt && now - lastRenamedAt < ACCOUNT_RENAME_COOLDOWN_MS) {
        return json(429, { error: "账户名每周只能修改一次" });
      }
      const oldUsername = account.username;
      account.username = username;
      account.lastRenamedAt = now;
      state.fish = state.fish.map((fish) => fish.ownerId === oldUsername
        ? { ...fish, ownerId: username, ownerAccount: username }
        : fish);
      await store.setJSON(STATE_KEY, state);
      return json(200, { username, lastRenamedAt: now });
    }

    if (event.httpMethod === "POST" && route === "/fish") {
      if (Buffer.byteLength(event.body || "", "utf8") > MAX_BODY_BYTES) return json(413, { error: "请求数据过大" });
      let input;
      try {
        input = JSON.parse(event.body || "{}");
      } catch {
        return json(400, { error: "请求格式无效" });
      }
      const account = requireAccount(event, state);
      const fish = normalizeNewFish(input, account.username, state);
      fish.ownerAccount = account.username;
      state.fish.push(fish);
      await store.setJSON(STATE_KEY, state);
      return json(201, { fish: presentFish(fish, clientId, account) });
    }

    if (event.httpMethod === "POST" && route === "/food/claim") {
      const account = requireAccount(event, state);
      const today = getTodayKey();
      if (account.lastFoodClaimDay === today) {
        return json(429, { error: "今天已经领取过鱼粮了" });
      }
      account.food = Math.max(0, Number(account.food) || 0) + DAILY_FOOD_REWARD;
      account.lastFoodClaimDay = today;
      await store.setJSON(STATE_KEY, state);
      return json(200, presentAccount(account));
    }

    const match = route.match(/^\/fish\/([^/]+)(?:\/(like|feed))?$/);
    if (match && event.httpMethod === "POST" && match[2] === "like") {
      const fish = state.fish.find((item) => item.id === decodeURIComponent(match[1]));
      if (!fish) return json(404, { error: "这条小鱼已经不在鱼缸里了" });
      const account = requireAccount(event, state);
      if (fish.ownerId === account.username) {
        return json(403, { error: "\u4e0d\u80fd\u7ed9\u81ea\u5df1\u7684\u9c7c\u70b9\u8d5e\u54e6" });
      }
      const likeKey = `${getTodayKey()}|${account.username}|${fish.id}`;
      const likesToday = Math.max(0, Number(state.likeLimits[likeKey]) || 0);
      if (likesToday >= MAX_DAILY_LIKES_PER_FISH) {
        return json(429, { error: "今天给这条鱼的点赞次数已达到 50 次" });
      }
      state.likeLimits[likeKey] = likesToday + 1;
      fish.hearts = Math.max(0, Number(fish.hearts) || 0) + 1;
      await store.setJSON(STATE_KEY, state);
      return json(200, { fish: presentFish(fish, clientId, account) });
    }

    if (match && event.httpMethod === "POST" && match[2] === "feed") {
      const fish = state.fish.find((item) => item.id === decodeURIComponent(match[1]));
      if (!fish) return json(404, { error: "这条小鱼已经不在鱼缸里了" });
      const account = requireAccount(event, state);
      if (fish.ownerId !== account.username) return json(403, { error: "只能喂养自己的鱼苗" });
      if ((Number(account.food) || 0) < 1) return json(400, { error: "鱼粮不够啦" });
      account.food -= 1;
      fish.food = Math.max(0, Number(fish.food) || 0) + 1;
      await store.setJSON(STATE_KEY, state);
      return json(200, { fish: presentFish(fish, clientId, account), food: account.food });
    }

    if (match && event.httpMethod === "DELETE" && !match[2]) {
      const id = decodeURIComponent(match[1]);
      const index = state.fish.findIndex((item) => item.id === id);
      if (index < 0) return json(404, { error: "这条小鱼已经不在鱼缸里了" });
      const fish = state.fish[index];
      const account = getAccount(event, state);
      if (!isAdmin(event) && (!account || fish.ownerId !== account.username)) {
        return json(403, { error: "只能放生自己的鱼苗" });
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
