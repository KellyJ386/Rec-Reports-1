import test from "node:test";
import assert from "node:assert/strict";
import { readClientEnv } from "../src/lib/env.mjs";

test("readClientEnv validates required public Supabase settings", () => {
  assert.deepEqual(
    readClientEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://demo.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000"
    }),
    {
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      NEXT_PUBLIC_SUPABASE_URL: "https://demo.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon"
    }
  );
});

test("readClientEnv rejects invalid Supabase URLs", () => {
  assert.throws(() =>
    readClientEnv({ NEXT_PUBLIC_SUPABASE_URL: "not-a-url", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" })
  );
});
