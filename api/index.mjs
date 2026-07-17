// Vercel Node.js serverless function (Node 20 runtime, ESM).
//
// Vercel invokes this with Node-style (req, res) and preserves the original
// request path (e.g. /api/admin/v1/me) via the rewrite in vercel.json. We reuse
// the exact same request listener as scripts/server.mjs (npm start), so routing,
// auth, validation, security headers, and JSON responses are identical between
// the long-running server and the serverless deployment. No port is bound here.
import { createRequestListener } from "../scripts/server.mjs";

const listener = createRequestListener();

export default function handler(req, res) {
  listener(req, res);
}
