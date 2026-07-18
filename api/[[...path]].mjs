import { handleRequest } from "../scripts/server.mjs";

// Vercel serverless entry point. The optional catch-all filename routes every
// /api/* request (both /api/admin/v1/* and /api/v1/*) to this one function,
// which delegates to the shared dispatch in scripts/server.mjs so the
// serverless deployment and the local Node server run identical routing. Static
// assets under dist/ are served by Vercel's static hosting, not this function.
export default async function handler(request, response) {
  try {
    await handleRequest(request, response);
  } catch (error) {
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: "internal server error", detail: error.message }));
    } else {
      response.end();
    }
  }
}
