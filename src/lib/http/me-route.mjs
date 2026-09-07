import { pgSelect } from "../supabase-rest.mjs";

// Registers GET /me: the authenticated user plus the facilities they can act in
// (all facilities for a platform admin) and the permission codes they hold in
// each. The end-user app calls this to populate its facility switcher and to
// decide which actions to surface. Injected primitives match the other modules:
//   authenticate(request, env) -> { claims, client, memberships, platformAdmin, error }
//   sendJson(response, status, payload)
export function registerMeRoute(router, { authenticate, sendJson }) {
  router.register("GET", "/me", (request, response, { env }) =>
    (async () => {
      const auth = await authenticate(request, env);
      if (auth.error) return sendJson(response, auth.error.status, auth.error.body);

      const permsByFacility = {};
      for (const membership of auth.memberships ?? []) {
        const existing = permsByFacility[membership.facilityId] ?? [];
        permsByFacility[membership.facilityId] = [
          ...new Set([...existing, ...membership.permissions])
        ];
      }

      let facilities;
      if (auth.platformAdmin === true) {
        facilities = await pgSelect(auth.client, "facilities", {
          select: "id,name,organization_id,organizations(name)",
          order: "name.asc"
        });
      } else {
        const ids = [...new Set((auth.memberships ?? []).map((m) => m.facilityId))];
        facilities = ids.length
          ? await pgSelect(auth.client, "facilities", {
              select: "id,name,organization_id,organizations(name)",
              order: "name.asc",
              extra: { id: `in.(${ids.join(",")})` }
            })
          : [];
      }

      // P-3 (home dashboard): expose the caller's own employees.id per
      // facility so the client can build "my open work orders"/"my shifts"
      // queries without a separate GET .../employees round trip per facility.
      // One extra select on employees by user_id, scoped to exactly the
      // facilities /me is already returning (a platform admin's facility
      // list, or a real member's) -- null for a facility where the caller
      // has no employee row (an admin with no membership row there, or a
      // member who was never onboarded as staff).
      const facilityIds = (facilities ?? []).map((f) => f.id);
      const employeeIdByFacility = {};
      if (facilityIds.length) {
        const employeeRows = await pgSelect(auth.client, "employees", {
          filters: { user_id: auth.claims.sub, facility_id: { in: facilityIds } },
          select: "id,facility_id"
        });
        for (const row of employeeRows ?? []) {
          employeeIdByFacility[row.facility_id] = row.id;
        }
      }

      return sendJson(response, 200, {
        user: { id: auth.claims.sub, email: auth.claims.email ?? null },
        platformAdmin: auth.platformAdmin === true,
        facilities: (facilities ?? []).map((f) => ({
          id: f.id,
          name: f.name,
          organizationId: f.organization_id,
          // Embedded from organizations so the admin top bar can label the
          // organization picker without a second round trip (and without the
          // user pasting an organization UUID by hand).
          organizationName: f.organizations?.name ?? null,
          permissions: permsByFacility[f.id] ?? [],
          employeeId: employeeIdByFacility[f.id] ?? null
        }))
      });
    })()
  );

  return router;
}
