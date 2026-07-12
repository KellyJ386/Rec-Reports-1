import { createHmac, timingSafeEqual } from "node:crypto";
import { pgSelect } from "../supabase-rest.mjs";

function base64UrlDecode(segment) {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, "base64");
}

function base64UrlEncode(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function verifySupabaseJwt(token, jwtSecret) {
  if (typeof token !== "string" || !jwtSecret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  const expectedSignature = base64UrlEncode(
    createHmac("sha256", jwtSecret).update(`${headerB64}.${payloadB64}`).digest()
  );
  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(signatureB64);
  if (expectedBuffer.length !== providedBuffer.length) return null;
  if (!timingSafeEqual(expectedBuffer, providedBuffer)) return null;

  if (typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}

// True when the user is on the platform_admins roster (0022): the platform
// super-admin scope that passes every permission check and sees every
// facility. Fail-closed: any lookup problem reads as "not a platform admin".
export async function loadPlatformAdmin(client, userId) {
  try {
    const rows = await pgSelect(client, "platform_admins", {
      filters: { user_id: userId },
      select: "id",
      limit: 1
    });
    return (rows ?? []).length > 0;
  } catch {
    return false;
  }
}

export async function loadMemberships(client, userId) {
  const rows = await pgSelect(client, "memberships", {
    filters: { user_id: userId },
    select: "id,facility_id,department_id,status,role_id,roles(role_permissions(permission_code))"
  });
  return (rows ?? []).map((row) => ({
    id: row.id,
    facilityId: row.facility_id,
    departmentId: row.department_id ?? null,
    status: row.status,
    roleId: row.role_id,
    permissions: (row.roles?.role_permissions ?? []).map((entry) => entry.permission_code)
  }));
}
