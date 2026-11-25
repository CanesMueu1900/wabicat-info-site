import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const PRODUCTION_HOST = "info2.wabicat.kdns.fr";
const PRODUCTION_STORE = "wabicat-info2-production";
const DATA_KEY = "items.json";
const MAX_BODY_BYTES = 256 * 1024;
const MIN_TOKEN_BYTES = 32;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function requestScope(env, url) {
  const production = String(env.CONTEXT || "").toLowerCase() === "production"
    && url.hostname.toLowerCase() === PRODUCTION_HOST;
  if (production) return { production: true, storeName: PRODUCTION_STORE };

  // Never let a deploy preview or branch deploy read/write the production store.
  // Each non-production deployment gets its own store; absent deploy identity fails closed.
  const deployId = String(env.DEPLOY_ID || "");
  if (!deployId) return { production: false, storeName: null };
  const suffix = createHash("sha256").update(deployId).digest("hex").slice(0, 16);
  return { production: false, storeName: `wabicat-info2-preview-${suffix}` };
}

function constantTimeMatch(candidate, expected) {
  if (typeof expected !== "string" || Buffer.byteLength(expected, "utf8") < MIN_TOKEN_BYTES) return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthorized(request, expected) {
  const authorization = request.headers.get("authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  const supplied = bearer ? bearer[1] : (request.headers.get("x-admin-token") || "");
  return constantTimeMatch(supplied, expected);
}

function safeItem(item) {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    body: item.body,
    category: item.category,
    sourceUrl: item.sourceUrl,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
  };
}

async function readJson(request) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "Request body is too large (256 KiB limit).");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "Body must be a JSON object.");
  }
}

function checkedText(value, max, field, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${field} is required.`);
    return "";
  }
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text.`);
  const result = value.trim();
  if (required && !result) throw new HttpError(400, `${field} is required.`);
  if (result.length > max) throw new HttpError(400, `${field} must be at most ${max} characters.`);
  return result;
}

function inputFields(data, previous = {}) {
  const allowed = new Set(["title", "summary", "body", "category", "sourceUrl"]);
  if (Object.keys(data).some((key) => !allowed.has(key))) throw new HttpError(400, "Unsupported field.");
  const title = data.title === undefined ? previous.title : checkedText(data.title, 180, "title", true);
  const summary = data.summary === undefined ? (previous.summary || "") : checkedText(data.summary, 500, "summary");
  const body = data.body === undefined ? (previous.body || "") : checkedText(data.body, 12000, "body");
  const category = data.category === undefined ? (previous.category || "资讯") : checkedText(data.category, 60, "category");
  const sourceUrl = data.sourceUrl === undefined ? (previous.sourceUrl || "") : checkedText(data.sourceUrl, 2048, "sourceUrl");
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    } catch {
      throw new HttpError(400, "sourceUrl must be a valid http(s) URL.");
    }
  }
  return { title, summary, body, category, sourceUrl };
}

function listResponse(items, url) {
  const query = (url.searchParams.get("q") || "").trim().toLocaleLowerCase();
  const sorted = [...items].sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
  const filtered = query
    ? sorted.filter((item) => [item.title, item.summary, item.body, item.category]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query)))
    : sorted;
  const rawLimit = Number.parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20));
  const rawOffset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
  const offset = Math.min(filtered.length, Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0));
  const page = filtered.slice(offset, offset + limit).map(safeItem);
  return { items: page, total: filtered.length, offset, limit, hasMore: offset + page.length < filtered.length };
}

function routeItemId(context) {
  const value = context?.params?.id;
  return typeof value === "string" && value.length ? value : null;
}

export function createApiHandler({ getStore, env = process.env, now = () => new Date(), makeId = randomUUID }) {
  return async function handler(request, context = {}) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const itemId = routeItemId(context);
    const scope = requestScope(env, url);

    if (method === "GET" && url.pathname === "/api/health") return json({ ok: true });

    const isList = method === "GET" && url.pathname === "/api/items";
    const isItemRead = method === "GET" && itemId !== null && url.pathname.startsWith("/api/items/");
    if (isList || isItemRead) {
      if (!scope.storeName) return json({ error: "Content is unavailable." }, 503);
      try {
        const blobs = getStore({ name: scope.storeName, consistency: "strong" });
        const record = await blobs.getWithMetadata(DATA_KEY, { type: "json" });
        if (!record || !Array.isArray(record.data) || typeof record.etag !== "string" || !record.etag) {
          return json({ error: "Content is unavailable." }, 503);
        }
        if (isList) {
          return json(listResponse(record.data, url), 200, { "cache-control": "public, max-age=30" });
        }
        const item = record.data.find((entry) => entry?.id === itemId);
        return item ? json({ item: safeItem(item) }, 200) : json({ error: "Item not found." }, 404);
      } catch {
        return json({ error: "Content is unavailable." }, 503);
      }
    }

    const isWrite = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
    if (!isWrite || !url.pathname.startsWith("/api/")) {
      return json({ error: "Unsupported API method or route." }, 405, { allow: "GET, POST, PATCH, PUT, DELETE" });
    }

    // Exact production context + custom host is required. Deploy previews never inherit write access.
    if (!scope.production) return json({ error: "Not found." }, 404);
    const token = typeof env.ADMIN_API_KEY === "string" ? env.ADMIN_API_KEY : "";
    if (Buffer.byteLength(token, "utf8") < MIN_TOKEN_BYTES) {
      return json({ error: "Publishing API is not configured yet." }, 503);
    }
    if (!isAuthorized(request, token)) return json({ error: "A valid API token is required." }, 401);

    if (!scope.storeName) return json({ error: "Content is unavailable." }, 503);
    try {
      const blobs = getStore({ name: scope.storeName, consistency: "strong" });
      const record = await blobs.getWithMetadata(DATA_KEY, { type: "json" });
      if (!record || !Array.isArray(record.data) || typeof record.etag !== "string" || !record.etag) {
        return json({ error: "Content is unavailable." }, 503);
      }
      const items = record.data;
      const etag = record.etag;

      if (method === "POST" && url.pathname === "/api/items") {
        const data = await readJson(request);
        const timestamp = now().toISOString();
        const item = { id: makeId(), ...inputFields(data), publishedAt: timestamp, updatedAt: timestamp };
        const result = await blobs.setJSON(DATA_KEY, [...items, item], { onlyIfMatch: etag });
        return result.modified
          ? json({ item: safeItem(item) }, 201)
          : json({ error: "Content changed concurrently; reload and retry." }, 409);
      }

      if ((method === "PATCH" || method === "PUT") && itemId !== null) {
        const index = items.findIndex((entry) => entry?.id === itemId);
        if (index < 0) return json({ error: "Item not found." }, 404);
        const data = await readJson(request);
        const updated = { ...items[index], ...inputFields(data, items[index]), updatedAt: now().toISOString() };
        const next = [...items];
        next[index] = updated;
        const result = await blobs.setJSON(DATA_KEY, next, { onlyIfMatch: etag });
        return result.modified
          ? json({ item: safeItem(updated) }, 200)
          : json({ error: "Content changed concurrently; reload and retry." }, 409);
      }

      if (method === "DELETE" && itemId !== null) {
        const index = items.findIndex((entry) => entry?.id === itemId);
        if (index < 0) return json({ error: "Item not found." }, 404);
        const [deleted] = items.splice(index, 1);
        const result = await blobs.setJSON(DATA_KEY, items, { onlyIfMatch: etag });
        return result.modified
          ? json({ deleted: { id: deleted.id } }, 200)
          : json({ error: "Content changed concurrently; reload and retry." }, 409);
      }

      return json({ error: "Unsupported API method or route." }, 405, { allow: "GET, POST, PATCH, PUT, DELETE" });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return json({ error: status < 500 ? error.message : "Could not save content." }, status);
    }
  };
}

export const apiConstants = Object.freeze({
  productionHost: PRODUCTION_HOST,
  productionStore: PRODUCTION_STORE,
  maxBodyBytes: MAX_BODY_BYTES,
  minimumTokenBytes: MIN_TOKEN_BYTES,
});
