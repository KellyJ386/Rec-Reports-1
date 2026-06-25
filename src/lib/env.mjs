const urlFields = new Set(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_APP_URL", "OBSERVABILITY_DSN"]);
const requiredClientFields = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const optionalServerFields = ["SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL", "OBSERVABILITY_DSN"];

function assertUrl(name, value) {
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

export function readClientEnv(source = process.env) {
  const env = {
    NEXT_PUBLIC_APP_URL: source.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  };

  for (const field of requiredClientFields) {
    if (!source[field]) {
      throw new Error(`${field} is required.`);
    }
    env[field] = source[field];
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
    if (source[field]) {
      env[field] = source[field];
      if (urlFields.has(field)) {
        assertUrl(field, source[field]);
      }
    }
  }
  return env;
}
