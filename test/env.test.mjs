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
  assert.throws(() =>
    readClientEnv({ SUPABASE_URL: "not-a-url", SUPABASE_ANON_KEY: "anon" })
  );
});

test("readClientEnv falls back to the deprecated NEXT_PUBLIC_* names when the new names are unset", () => {
  assert.deepEqual(
    readClientEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://demo.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000"
    }),
    {
      APP_URL: "http://localhost:3000",
      SUPABASE_URL: "https://demo.supabase.co",
      SUPABASE_ANON_KEY: "anon"
    }
  );
});

test("readClientEnv prefers the new names when both spellings are set", () => {
  assert.deepEqual(
    readClientEnv({
      SUPABASE_URL: "https://new.supabase.co",
      SUPABASE_ANON_KEY: "new-anon",
      APP_URL: "http://new.localhost:3000",
      NEXT_PUBLIC_SUPABASE_URL: "https://old.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "old-anon",
      NEXT_PUBLIC_APP_URL: "http://old.localhost:3000"
    }),
    {
      APP_URL: "http://new.localhost:3000",
      SUPABASE_URL: "https://new.supabase.co",
      SUPABASE_ANON_KEY: "new-anon"
    }
  );
});

test("readClientEnv rejects invalid Supabase URLs supplied via the deprecated NEXT_PUBLIC_* name", () => {
  assert.throws(() =>
    readClientEnv({ NEXT_PUBLIC_SUPABASE_URL: "not-a-url", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" })
  );
});

test("readClientEnv requires the anon key even when only the deprecated URL name is set", () => {
  assert.throws(() => readClientEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://demo.supabase.co" }));
});
