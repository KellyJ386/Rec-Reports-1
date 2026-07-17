const urlFields = new Set(["SUPABASE_URL", "APP_URL", "OBSERVABILITY_DSN"]);
const requiredClientFields = ["SUPABASE_URL", "SUPABASE_ANON_KEY"];
const optionalServerFields = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_JWT_SECRET",
  "DATABASE_URL",
  "OBSERVABILITY_DSN"
];

// Legacy Next.js-style names, kept as a temporary fallback for one release.
// Prefer the new canonical name; only fall back when it is unset.
const legacyFieldNames = {
  SUPABASE_URL: "NEXT_PUBLIC_SUPABASE_URL",
  SUPABASE_ANON_KEY: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  APP_URL: "NEXT_PUBLIC_APP_URL"
};

function readField(source, field) {
  const legacyName = legacyFieldNames[field];
  return source[field] ?? (legacyName ? source[legacyName] : undefined);
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
    APP_URL: readField(source, "APP_URL") ?? "http://localhost:3000"
  };

  for (const field of requiredClientFields) {
    const value = readField(source, field);
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
    const value = readField(source, field);
    if (value) {
      env[field] = value;
      if (urlFields.has(field)) {
        assertUrl(field, value);
      }
    }
  }
  return env;
}
