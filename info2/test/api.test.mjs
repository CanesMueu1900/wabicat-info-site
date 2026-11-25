import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApiHandler, apiConstants } from "../netlify/functions/api-core.mjs";

const PRODUCTION_HOST = apiConstants.productionHost;
const TEST_TOKEN = randomBytes(40).toString("base64url");

function makeItems() {
  return Array.from({ length: 6 }, (_, index) => ({
    id: `fixture-${index + 1}`,
    title: `Synthetic article ${index + 1}`,
    summary: `Synthetic summary ${index + 1}`,
    body: `Synthetic body ${index + 1}`,
    category: "Test",
    sourceUrl: "https://example.invalid/source",
    publishedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
  }));
}

class MemoryStore {
  constructor(items = makeItems()) { this.items = structuredClone(items); this.etag = "v1"; }
  async getWithMetadata(key, options) {
    assert.equal(key, "items.json");
    assert.deepEqual(options, { type: "json" });
    return { data: structuredClone(this.items), etag: this.etag };
  }
  async setJSON(key, items, options) {
    assert.equal(key, "items.json");
    if (options.onlyIfMatch !== this.etag) return { modified: false };
    this.items = structuredClone(items);
    this.etag = `v${Number(this.etag.slice(1)) + 1}`;
    return { modified: true };
  }
}

function setup({ context = "production", token = TEST_TOKEN, items = makeItems(), etag = "v1", deployId = "deploy-test" } = {}) {
  const store = new MemoryStore(items);
  store.etag = etag;
  const calls = [];
  const handler = createApiHandler({
    env: { CONTEXT: context, DEPLOY_ID: deployId, ADMIN_API_KEY: token },
    getStore: (options) => { calls.push(options); return store; },
    now: () => new Date("2026-11-25T00:00:00.000Z"),
    makeId: () => "created-test-id",
  });
  return { handler, store, calls };
}

async function request(handler, method, path, { token, body, host = PRODUCTION_HOST } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const req = new Request(`https://${host}${path}`, init);
  const idMatch = path.match(/^\/api\/items\/([^/?]+)$/);
  return handler(req, { params: idMatch ? { id: decodeURIComponent(idMatch[1]) } : {} });
}

async function payload(response) { return response.json(); }

 test("public list preserves pagination fields and six-item fixture contract", async () => {
  const { handler, calls } = setup();
  const response = await request(handler, "GET", "/api/items?limit=2&offset=1");
  assert.equal(response.status, 200);
  const data = await payload(response);
  assert.deepEqual(Object.keys(data).sort(), ["hasMore", "items", "limit", "offset", "total"]);
  assert.equal(data.total, 6);
  assert.equal(data.offset, 1);
  assert.equal(data.limit, 2);
  assert.equal(data.items.length, 2);
  assert.equal(data.hasMore, true);
  assert.deepEqual(Object.keys(data.items[0]).sort(), ["body", "category", "id", "publishedAt", "sourceUrl", "summary", "title", "updatedAt"]);
  assert.equal(calls[0].name, apiConstants.productionStore);
});

test("single-item read preserves the item envelope and public response", async () => {
  const { handler } = setup();
  const response = await request(handler, "GET", "/api/items/fixture-1");
  assert.equal(response.status, 200);
  const data = await payload(response);
  assert.deepEqual(Object.keys(data), ["item"]);
  assert.equal(data.item.id, "fixture-1");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("health stays public and does not disclose environment or key", async () => {
  const { handler } = setup();
  const response = await request(handler, "GET", "/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await payload(response), { ok: true });
});

test("missing and wrong tokens are rejected before storage access", async () => {
  for (const token of [undefined, "wrong-value"]) {
    const { handler, calls } = setup();
    const response = await request(handler, "POST", "/api/items", { token, body: { title: "Attempt" } });
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(await response.text(), new RegExp(TEST_TOKEN));
  }
});

test("short or unset production key fails closed without exposing its value", async () => {
  for (const token of ["", "short-test-key"]) {
    const { handler, calls } = setup({ token });
    const response = await request(handler, "POST", "/api/items", { token, body: { title: "Attempt" } });
    assert.equal(response.status, 503);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(await response.text(), /short-test-key/);
  }
});

test("deploy previews remain read-only even if a key is accidentally present", async () => {
  const { handler, calls } = setup({ context: "deploy-preview" });
  const response = await request(handler, "POST", "/api/items", { token: TEST_TOKEN, body: { title: "Attempt" } });
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

test("preview reads are isolated in a deployment-specific store", async () => {
  const { handler, calls } = setup({ context: "deploy-preview", host: undefined });
  const response = await request(handler, "GET", "/api/items", { host: "info2-preview.netlify.app" });
  assert.equal(response.status, 200);
  assert.match(calls[0].name, /^wabicat-info2-preview-[0-9a-f]{16}$/);
  assert.notEqual(calls[0].name, apiConstants.productionStore);
});

test("production key cannot write through another hostname", async () => {
  const { handler, calls } = setup();
  const response = await request(handler, "POST", "/api/items", { token: TEST_TOKEN, host: "info2-wabicat-preview.netlify.app", body: { title: "Attempt" } });
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

test("missing deploy identity fails closed for preview reads and writes", async () => {
  const store = new MemoryStore();
  const calls = [];
  const handler = createApiHandler({
    env: { CONTEXT: "deploy-preview", ADMIN_API_KEY: TEST_TOKEN },
    getStore: (options) => { calls.push(options); return store; },
  });
  const read = await request(handler, "GET", "/api/items", { host: "deploy-preview.netlify.app" });
  const write = await request(handler, "POST", "/api/items", { host: "deploy-preview.netlify.app", token: TEST_TOKEN, body: { title: "x" } });
  assert.equal(read.status, 503);
  assert.equal(write.status, 404);
  assert.equal(calls.length, 0);
});

test("missing blob data is not auto-seeded or overwritten", async () => {
  let writes = 0;
  const handler = createApiHandler({
    env: { CONTEXT: "production", ADMIN_API_KEY: TEST_TOKEN },
    getStore: () => ({ getWithMetadata: async () => null, setJSON: async () => { writes++; return { modified: true }; } }),
  });
  const read = await request(handler, "GET", "/api/items");
  const write = await request(handler, "POST", "/api/items", { token: TEST_TOKEN, body: { title: "Attempt" } });
  assert.equal(read.status, 503);
  assert.equal(write.status, 503);
  assert.equal(writes, 0);
});

test("authorized create, edit, and delete preserve field semantics", async () => {
  const { handler, store } = setup();
  const createdResponse = await request(handler, "POST", "/api/items", {
    token: TEST_TOKEN,
    body: { title: "  New synthetic article  ", summary: "Summary", body: "Text", category: "Test", sourceUrl: "https://example.invalid/new" },
  });
  assert.equal(createdResponse.status, 201);
  const created = (await payload(createdResponse)).item;
  assert.equal(created.id, "created-test-id");
  assert.equal(created.title, "New synthetic article");
  assert.equal(created.publishedAt, "2026-11-25T00:00:00.000Z");
  assert.deepEqual(Object.keys(created).sort(), ["body", "category", "id", "publishedAt", "sourceUrl", "summary", "title", "updatedAt"]);

  const patchedResponse = await request(handler, "PATCH", `/api/items/${created.id}`, { token: TEST_TOKEN, body: { title: "Updated title" } });
  assert.equal(patchedResponse.status, 200);
  const updated = (await payload(patchedResponse)).item;
  assert.equal(updated.title, "Updated title");
  assert.equal(updated.summary, "Summary");
  assert.equal(updated.body, "Text");
  assert.equal(updated.updatedAt, "2026-11-25T00:00:00.000Z");

  const deleteResponse = await request(handler, "DELETE", `/api/items/${created.id}`, { token: TEST_TOKEN });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await payload(deleteResponse), { deleted: { id: created.id } });
  assert.equal(store.items.length, 6);
});

test("wrong token and failures never echo any token", async () => {
  const { handler } = setup();
  const response = await request(handler, "POST", "/api/items", { token: `${TEST_TOKEN}x`, body: { title: "Attempt" } });
  const text = await response.text();
  assert.equal(response.status, 401);
  assert.equal(text.includes(TEST_TOKEN), false);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("input validation enforces limits, URLs, and allowed fields", async () => {
  const { handler } = setup();
  const cases = [
    { title: "" },
    { title: "t".repeat(181) },
    { title: "ok", summary: "s".repeat(501) },
    { title: "ok", body: "b".repeat(12001) },
    { title: "ok", category: "c".repeat(61) },
    { title: "ok", sourceUrl: "javascript:alert(1)" },
    { title: "ok", unexpected: "field" },
  ];
  for (const body of cases) {
    const response = await request(handler, "POST", "/api/items", { token: TEST_TOKEN, body });
    assert.equal(response.status, 400);
  }
});

test("body size is limited and malformed JSON is rejected", async () => {
  const { handler } = setup();
  const large = JSON.stringify({ title: "a" }) + " ".repeat(apiConstants.maxBodyBytes);
  const tooLarge = await request(handler, "POST", "/api/items", { token: TEST_TOKEN, body: large });
  assert.equal(tooLarge.status, 413);
  const malformed = await request(handler, "POST", "/api/items", { token: TEST_TOKEN, body: "{" });
  assert.equal(malformed.status, 400);
});

test("unexpected storage errors return a generic body, not internal details", async () => {
  const handler = createApiHandler({
    env: { CONTEXT: "production", ADMIN_API_KEY: TEST_TOKEN },
    getStore: () => ({
      getWithMetadata: async () => ({ data: makeItems(), etag: "v1" }),
      setJSON: async () => { throw new Error(`internal failure ${TEST_TOKEN}`); },
    }),
  });
  const response = await request(handler, "POST", "/api/items", { token: TEST_TOKEN, body: { title: "safe" } });
  const text = await response.text();
  assert.equal(response.status, 500);
  assert.equal(text.includes(TEST_TOKEN), false);
  assert.equal(text.includes("internal failure"), false);
});

test("optimistic concurrency conflict is returned without overwriting", async () => {
  const { handler, store } = setup();
  const original = structuredClone(store.items);
  const raced = createApiHandler({
    env: { CONTEXT: "production", ADMIN_API_KEY: TEST_TOKEN },
    getStore: () => ({
      getWithMetadata: async () => ({ data: original, etag: "old-etag" }),
      setJSON: async () => ({ modified: false }),
    }),
  });
  const response = await request(raced, "POST", "/api/items", { token: TEST_TOKEN, body: { title: "Raced" } });
  assert.equal(response.status, 409);
  assert.equal(store.items.length, 6);
});
