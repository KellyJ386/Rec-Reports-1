import { randomUUID } from "node:crypto";
import { handleRequest } from "../scripts/server.mjs";
import { reportError } from "../src/lib/observability.mjs";
import { includeErrorDetail } from "../src/lib/http/errors.mjs";

// Vercel serverless entry point. The optional catch-all filename routes every
// /api/* request (both /api/admin/v1/* and /api/v1/*) to this one function,
// which delegates to the shared dispatch in scripts/server.mjs so the
// serverless deployment and the local Node server run identical routing. Static
// assets under dist/ are served by Vercel's static hosting, not this function.
export default async function handler(request, response) {
  try {
    await handleRequest(request, response);
  } catch (error) {
    // OP-20: handleRequest's own try/catch around the matched route handler
    // already fired (and marked) a report for the common case -- a route
    // handler throwing. This is the serverless-specific last-resort net: it
    // only reports something that escaped from outside that try (routing/env
    // bugs), so the common case is never double-reported. Fire-and-forget,
    // same as everywhere else: never awaited, never allowed to change what
    // happens next. No verified server env is reliably available this far
    // out (that's exactly the kind of failure this net exists to catch), so
    // this reads OBSERVABILITY_DSN directly off process.env.
    // P-9: same requestId-forwarding and production detail-leak guard as
    // scripts/server.mjs's createApp catch -- see its comments for why
    // error.__requestId is preferred over minting a fresh one, and why
    // includeErrorDetail reads raw process.env instead of a validated env.
    const requestId = error.__requestId ?? randomUUID();
    if (!error.__observabilityReported) {
      reportError(error, { dsn: process.env.OBSERVABILITY_DSN, route: null, status: 500, requestId, userId: null });
    }
    if (!response.headersSent) {
      const detail = includeErrorDetail(process.env) ? { detail: error.message } : {};
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: "internal server error", requestId, ...detail }));
    } else {
      response.end();
    }
  }
}
