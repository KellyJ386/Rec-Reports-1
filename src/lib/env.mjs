const urlFields = new Set(["SUPABASE_URL", "APP_URL", "OBSERVABILITY_DSN"]);
const requiredClientFields = ["SUPABASE_URL", "SUPABASE_ANON_KEY"];
const optionalServerFields = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
  "DATABASE_URL",
  "OBSERVABILITY_DSN",
  "CRON_SECRET",
  "DEBUG_ERRORS",
  "EMAIL_PROVIDER",
  "EMAIL_API_KEY",
  "EMAIL_FROM",
  "PUSH_PROVIDER",
  "FCM_SERVICE_ACCOUNT_JSON",
  "FIREBASE_WEB_CONFIG_JSON"
];

// CRON_SECRET (OP-13, src/lib/http/internal-routes.mjs) gates the internal
// notification-drain route: the route compares an incoming bearer token
// against this value (never the normal facility-token/JWT auth) and returns
// 503 -- disabled, never open -- when it is unset. Vercel injects it
// automatically as the cron request's Authorization header once the env var
// of this exact name is configured on the project (see vercel.json).
//
// DEBUG_ERRORS (P-9, scripts/server.mjs + api/[...path].mjs) overrides the
// production detail-leak guard on the generic 500 response: Vercel sets
// VERCEL_ENV=production automatically on a production deployment, and both
// last-resort error handlers hide `error.message` there unless DEBUG_ERRORS
// is also set (any non-empty value other than "false"/"0"). Every other
// environment (VERCEL_ENV unset -- local/dev, or "preview") shows the detail
// unconditionally, matching this app's behavior before DEBUG_ERRORS existed.
//
// EMAIL_PROVIDER/EMAIL_API_KEY/EMAIL_FROM (P-4, src/lib/notifications/
// email.mjs + adapters.mjs) and PUSH_PROVIDER/FCM_SERVICE_ACCOUNT_JSON
// (P-5, src/lib/notifications/fcm.mjs + adapters.mjs) configure the
// worker's real delivery adapters (src/lib/notifications/worker.mjs's
// config.emailAdapter/pushAdapter, built by
// buildAdaptersFromEnv in adapters.mjs). EMAIL_PROVIDER/PUSH_PROVIDER unset
// or "noop" -> the zero-network noop adapter (every delivery marked 'sent'
// with no provider configured, same as before P-4/P-5 existed).
// EMAIL_PROVIDER=resend requires EMAIL_API_KEY and EMAIL_FROM;
// PUSH_PROVIDER=fcm requires FCM_SERVICE_ACCOUNT_JSON (base64-encoded
// Google service-account JSON -- base64 because the raw JSON embeds a
// multi-line PEM private key, which is not safe to carry as a literal env
// var value); either missing credential throws at adapter-build time
// (buildAdaptersFromEnv), never silently falling back to noop.
//
// FIREBASE_WEB_CONFIG_JSON (P-5, scripts/server.mjs's GET /public-config)
// is the owner-supplied Firebase Web SDK config object (apiKey, authDomain,
// projectId, messagingSenderId, appId, ...) as a raw JSON string -- unlike
// FCM_SERVICE_ACCOUNT_JSON this is NOT base64 and carries no secret: it is
// the same public client config Firebase's own web docs say is safe to ship
// to the browser, handed back verbatim (as `firebaseWebConfig`) so the "Enable
// notifications" button in src/public/js/app.js knows whether push
// enrollment is available at all. Unset or malformed JSON -> the field is
// simply omitted from the response, never a request failure.
//
// SUPABASE_STORAGE_BUCKET (OP-16, src/lib/storage.mjs) is optional like the
// fields above, but unlike them it always ends up set on the returned env --
// it falls back to the "attachments" default below rather than being left
// undefined when unset, since every storage-client caller needs a bucket
// name to build requests against.
const STORAGE_BUCKET_DEFAULT = "attachments";

// One-release fallback: this app used to read these under the abandoned
// Next.js NEXT_PUBLIC_* naming convention (a holdover from before the
// zero-dependency rewrite). The new, framework-neutral names are preferred;
// the old names are still honored so existing deployments keep working until
// they're reconfigured with the new names. Remove this map (and the fallback
// read below) once the old names are no longer set anywhere.
const legacyNames = {
  SUPABASE_URL: "NEXT_PUBLIC_SUPABASE_URL",
  SUPABASE_ANON_KEY: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  APP_URL: "NEXT_PUBLIC_APP_URL"
};

function readWithFallback(source, name) {
  const legacyName = legacyNames[name];
  return source[name] ?? (legacyName ? source[legacyName] : undefined);
}

function assertUrl(name, value) {
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

export function readClientEnv(source = process.env) {
  const env = {
    APP_URL: readWithFallback(source, "APP_URL") ?? "http://localhost:3000"
  };

  for (const field of requiredClientFields) {
    const value = readWithFallback(source, field);
    if (!value) {
      throw new Error(`${field} is required.`);
    }
    env[field] = value;
  }

  for (const [field, value] of Object.entries(env)) {
    if (urlFields.has(field)) {
      assertUrl(field, value);
    }
  }

  return env;
}

export function readServerEnv(source = process.env) {
  const env = readClientEnv(source);
  for (const field of optionalServerFields) {
    const value = readWithFallback(source, field);
    if (value) {
      env[field] = value;
      if (urlFields.has(field)) {
        assertUrl(field, value);
      }
    }
  }
  env.SUPABASE_STORAGE_BUCKET = source.SUPABASE_STORAGE_BUCKET || STORAGE_BUCKET_DEFAULT;
  return env;
}
