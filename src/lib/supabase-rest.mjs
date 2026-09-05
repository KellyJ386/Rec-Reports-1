export class PostgrestError extends Error {
  constructor(message, { status, body }) {
    super(message);
    this.name = "PostgrestError";
    this.status = status;
    this.body = body;
  }
}

export function createClient({ url, key, authToken } = {}) {
  if (!url) throw new Error("createClient requires a url");
  if (!key) throw new Error("createClient requires a key");
  return { url: String(url).replace(/\/+$/, ""), key, authToken: authToken ?? key };
}

// Operators supported for object-tagged filter values, e.g.
// { report_date: { gte: "2026-01-01" } } -> report_date=gte.2026-01-01
// { status: { in: ["a", "b"] } } -> status=in.(a,b)
// Plain scalar values keep emitting eq.<value> unchanged for backward
// compatibility with every existing caller.
const FILTER_OPERATORS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "in"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Validates filter shapes and throws BEFORE any fetch is issued on an unknown
// operator key, so a typo never silently reaches PostgREST as a raw value.
function appendFilters(params, filters) {
  for (const [column, value] of Object.entries(filters ?? {})) {
    if (isPlainObject(value)) {
      for (const [operator, operand] of Object.entries(value)) {
        if (!FILTER_OPERATORS.has(operator)) {
          throw new Error(`unsupported filter operator "${operator}" for column "${column}"`);
        }
        if (operator === "in") {
          const list = Array.isArray(operand) ? operand : [operand];
          params.append(column, `in.(${list.join(",")})`);
        } else {
          params.append(column, `${operator}.${operand}`);
        }
      }
    } else {
      params.append(column, `eq.${value}`);
    }
  }
}

function buildQuery({ filters, select, limit, offset, order, extra } = {}) {
  const params = new URLSearchParams();
  if (select) params.set("select", Array.isArray(select) ? select.join(",") : select);
  appendFilters(params, filters);
  if (order) params.set("order", order);
  if (limit !== undefined && limit !== null) params.set("limit", String(limit));
  if (offset !== undefined && offset !== null) params.set("offset", String(offset));
  if (extra) {
    for (const [key, value] of Object.entries(extra)) params.set(key, value);
  }
  return params.toString();
}

function buildHeaders(client, { returning, prefer, count } = {}) {
  const preferParts = [];
  if (prefer) preferParts.push(prefer);
  if (returning) preferParts.push("return=representation");
  if (count) preferParts.push(`count=${count}`);
  const headers = {
    apikey: client.key,
    Authorization: `Bearer ${client.authToken ?? client.key}`,
    "Content-Type": "application/json"
  };
  if (preferParts.length > 0) headers.Prefer = preferParts.join(",");
  return headers;
}

async function request(client, method, table, { query, body, headers } = {}) {
  const search = query ? `?${query}` : "";
  const response = await fetch(`${client.url}/rest/v1/${table}${search}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new PostgrestError(`PostgREST ${method} ${table} failed with status ${response.status}`, {
      status: response.status,
      body: data
    });
  }
  return data;
}

export async function pgSelect(client, table, options = {}) {
  const { count } = options;
  const query = buildQuery(options);
  const headers = buildHeaders(client, { count });
  return request(client, "GET", table, { query, headers });
}

export async function pgInsert(client, table, rows, options = {}) {
  const { returning = true, onConflict, merge = false } = options;
  const query = onConflict ? buildQuery({ extra: { on_conflict: onConflict } }) : "";
  const headers = buildHeaders(client, {
    returning,
    prefer: merge ? "resolution=merge-duplicates" : undefined
  });
  return request(client, "POST", table, { query, body: rows, headers });
}

export async function pgUpdate(client, table, filters, patch, options = {}) {
  const { returning = true } = options;
  const query = buildQuery({ filters });
  const headers = buildHeaders(client, { returning });
  return request(client, "PATCH", table, { query, body: patch, headers });
}

export async function pgDelete(client, table, filters, options = {}) {
  const { returning = false } = options;
  const query = buildQuery({ filters });
  const headers = buildHeaders(client, { returning });
  return request(client, "DELETE", table, { query, headers });
}
