const urlFields = new Set(["SUPABASE_URL", "APP_URL", "OBSERVABILITY_DSN"]);
const requiredClientFields = ["SUPABASE_URL", "SUPABASE_ANON_KEY"];
const optionalServerFields = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
  "DATABASE_URL",
  "OBSERVABILITY_DSN",
  "CRON_SECRET"
];

// CRON_SECRET (OP-13, src/lib/http/internal-routes.mjs) gates the internal
// notification-drain route: the route compares an incoming bearer token
// against this value (never the normal facility-token/JWT auth) and returns
// 503 -- disabled, never open -- when it is unset. Vercel injects it
// automatically as the cron request's Authorization header once the env var
// of this exact name is configured on the project (see vercel.json).
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
