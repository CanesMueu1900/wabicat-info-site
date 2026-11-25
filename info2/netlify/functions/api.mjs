import { getStore } from "@netlify/blobs";
import { createApiHandler } from "./api-core.mjs";

const handler = createApiHandler({ getStore, env: process.env });
export default handler;

export const config = {
  path: ["/api/health", "/api/items", "/api/items/:id"],
};
