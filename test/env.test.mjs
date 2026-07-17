import test from "node:test";
import assert from "node:assert/strict";
import { readClientEnv } from "../src/lib/env.mjs";

test("readClientEnv validates required public Supabase settings", () => {
  assert.deepEqual(
    readClientEnv({
      SUPABASE_URL: "https://demo.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      APP_URL: "http://localhost:3000"
    }),
    {
      APP_URL: "http://localhost:3000",
      SUPABASE_URL: "https://demo.supabase.co",
      SUPABASE_ANON_KEY: "anon"
    }
  );
});

test("readClientEnv rejects invalid Supabase URLs", () => {
  assert.throws(() => readClientEnv({ SUPABASE_URL: "not-a-url", SUPABASE_ANON_KEY: "anon" }));
});

test("readClientEnv falls back to legacy NEXT_PUBLIC_* names when the new names are unset", () => {
  assert.deepEqual(
    readClientEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://legacy.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "legacy-anon",
      NEXT_PUBLIC_APP_URL: "http://localhost:4000"
    }),
    {
      APP_URL: "http://localhost:4000",
      SUPABASE_URL: "https://legacy.supabase.co",
      SUPABASE_ANON_KEY: "legacy-anon"
    }
  );
});

test("readClientEnv prefers the new canonical names over the legacy fallback", () => {
  assert.deepEqual(
    readClientEnv({
      SUPABASE_URL: "https://demo.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      NEXT_PUBLIC_SUPABASE_URL: "https://legacy.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "legacy-anon"
    }),
    {
      APP_URL: "http://localhost:3000",
      SUPABASE_URL: "https://demo.supabase.co",
      SUPABASE_ANON_KEY: "anon"
    }
  );
});
