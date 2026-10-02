import test from "node:test";
import assert from "node:assert/strict";
import { loadModuleConfig, makeConfigLoader } from "../src/lib/http/module-config.mjs";
import { createClient } from "../src/lib/supabase-rest.mjs";

const MODULE_WORK_ORDERS = { id: "mod-work-orders", code: "work_orders" };
const FACILITY_ROW = { id: "fac-1", organization_id: "org-1" };

function facilityOverride(patch) {
  return { config_patch_jsonb: patch };
}

function orgSetting(config) {
  return { config_jsonb: config };
}

// Stubs globalThis.fetch, dispatching on the PostgREST table name. `respond`
// receives (table) and returns the row array for that table, or throws /
// returns undefined to simulate "no rows". Pass `fail: true` for a table to
// have the stub reject the fetch outright (simulating a network failure).
function stubFetch(t, respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    calls.push(table);
    const result = respond(table, parsed);
    if (result && result.networkError) {
      throw new Error("network failure");
    }
    if (result && result.httpError) {
      return { ok: false, status: result.status ?? 500, text: async () => JSON.stringify({ message: "error" }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(result ?? []) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function client() {
  return createClient({ url: "https://example.supabase.co", key: "service-key" });
}

test("loadModuleConfig: facility override wins over organization setting", async (t) => {
  stubFetch(t, (table) => {
    if (table === "modules") return [MODULE_WORK_ORDERS];
    if (table === "facilities") return [FACILITY_ROW];
    if (table === "organization_module_settings") {
      return [orgSetting({ "workOrders.defaultPriority": "high" })];
    }
    if (table === "facility_module_overrides") {
      return [facilityOverride({ "workOrders.defaultPriority": "urgent" })];
    }
    return [];
  });

  const config = await loadModuleConfig({ client: client(), facilityId: "fac-1", moduleCode: "work_orders" });
  assert.equal(config["workOrders.defaultPriority"], "urgent");
});

test("loadModuleConfig: organization setting wins over the registry default", async (t) => {
  stubFetch(t, (table) => {
    if (table === "modules") return [MODULE_WORK_ORDERS];
    if (table === "facilities") return [FACILITY_ROW];
    if (table === "organization_module_settings") {
      return [orgSetting({ "workOrders.slaHoursUrgent": 6 })];
    }
    return [];
  });

  const config = await loadModuleConfig({ client: client(), facilityId: "fac-1", moduleCode: "work_orders" });
  assert.equal(config["workOrders.slaHoursUrgent"], 6);
  // Untouched keys still fall back to the registry default.
  assert.equal(config["workOrders.slaHoursRoutine"], 72);
  assert.equal(config["workOrders.defaultPriority"], "medium");
});

test("loadModuleConfig: with neither layer set, config reproduces registry defaults", async (t) => {
  stubFetch(t, (table) => {
    if (table === "modules") return [MODULE_WORK_ORDERS];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });

  const config = await loadModuleConfig({ client: client(), facilityId: "fac-1", moduleCode: "work_orders" });
  assert.deepEqual(config, {
    "workOrders.defaultPriority": "medium",
    "workOrders.slaHoursUrgent": 24,
    "workOrders.slaHoursRoutine": 72,
    // WO-21: off by default -- a facility that has configured nothing sees
    // this key resolve to the registry default alongside the pre-existing
    // three, same as every other unset key here.
    "workOrders.autoCreateFromReportDefects": false,
    "workOrders.pmHorizonDays": 30
  });
});

test("loadModuleConfig: missing module row degrades to {} rather than throwing", async (t) => {
  stubFetch(t, () => []);

  const config = await loadModuleConfig({ client: client(), facilityId: "fac-1", moduleCode: "work_orders" });
  assert.deepEqual(config, {});
});

test("loadModuleConfig: missing facility row still resolves (no org layer, degrades gracefully)", async (t) => {
  stubFetch(t, (table) => {
    if (table === "modules") return [MODULE_WORK_ORDERS];
    if (table === "facilities") return [];
    if (table === "facility_module_overrides") {
      return [facilityOverride({ "workOrders.defaultPriority": "low" })];
    }
    return [];
  });

  const config = await loadModuleConfig({ client: client(), facilityId: "fac-1", moduleCode: "work_orders" });
  assert.equal(config["workOrders.defaultPriority"], "low");
});

test("loadModuleConfig: a thrown PostgrestError (non-2xx) degrades to {} rather than throwing", async (t) => {
  stubFetch(t, (table) => {
    if (table === "modules") return { httpError: true, status: 403 };
    return [];
  });

  const config = await loadModuleConfig({ client: client(), facilityId: "fac-1", moduleCode: "work_orders" });
  assert.deepEqual(config, {});
});

test("loadModuleConfig: a rejected fetch (network failure) degrades to {} rather than throwing", async (t) => {
  stubFetch(t, (table) => {
    if (table === "modules") return { networkError: true };
    return [];
  });

  await assert.doesNotReject(async () => {
    const config = await loadModuleConfig({ client: client(), facilityId: "fac-1", moduleCode: "work_orders" });
    assert.deepEqual(config, {});
  });
});

test("loadModuleConfig: unknown moduleCode (no settings defined) still resolves to {}", async (t) => {
  stubFetch(t, (table) => {
    if (table === "modules") return [{ id: "mod-unknown", code: "not_a_real_module" }];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });

  const config = await loadModuleConfig({ client: client(), facilityId: "fac-1", moduleCode: "not_a_real_module" });
  assert.deepEqual(config, {});
});

test("makeConfigLoader: memoizes repeated lookups for the same facility+module", async (t) => {
  const calls = stubFetch(t, (table) => {
    if (table === "modules") return [MODULE_WORK_ORDERS];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });

  const loadConfig = makeConfigLoader(client());
  const first = await loadConfig({ facilityId: "fac-1", moduleCode: "work_orders" });
  const modulesCallsAfterFirst = calls.filter((t) => t === "modules").length;
  const second = await loadConfig({ facilityId: "fac-1", moduleCode: "work_orders" });
  const modulesCallsAfterSecond = calls.filter((t) => t === "modules").length;

  assert.deepEqual(first, second);
  assert.equal(modulesCallsAfterFirst, 1);
  assert.equal(modulesCallsAfterSecond, 1, "second lookup for the same key must not refetch");
});

test("makeConfigLoader: concurrent calls for the same key share one in-flight lookup", async (t) => {
  const calls = stubFetch(t, (table) => {
    if (table === "modules") return [MODULE_WORK_ORDERS];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });

  const loadConfig = makeConfigLoader(client());
  const [a, b] = await Promise.all([
    loadConfig({ facilityId: "fac-1", moduleCode: "work_orders" }),
    loadConfig({ facilityId: "fac-1", moduleCode: "work_orders" })
  ]);

  assert.deepEqual(a, b);
  assert.equal(calls.filter((t) => t === "modules").length, 1);
});

test("makeConfigLoader: distinct facility/module keys are looked up independently", async (t) => {
  const calls = stubFetch(t, (table) => {
    if (table === "modules") return [MODULE_WORK_ORDERS];
    if (table === "facilities") return [FACILITY_ROW];
    return [];
  });

  const loadConfig = makeConfigLoader(client());
  await loadConfig({ facilityId: "fac-1", moduleCode: "work_orders" });
  await loadConfig({ facilityId: "fac-2", moduleCode: "work_orders" });

  assert.equal(calls.filter((t) => t === "modules").length, 2);
});
