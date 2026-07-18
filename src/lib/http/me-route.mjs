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
          select: "id,name,organization_id",
          order: "name.asc"
        });
      } else {
        const ids = [...new Set((auth.memberships ?? []).map((m) => m.facilityId))];
        facilities = ids.length
          ? await pgSelect(auth.client, "facilities", {
              select: "id,name,organization_id",
              order: "name.asc",
              extra: { id: `in.(${ids.join(",")})` }
            })
          : [];
      }

      return sendJson(response, 200, {
        user: { id: auth.claims.sub, email: auth.claims.email ?? null },
        platformAdmin: auth.platformAdmin === true,
        facilities: (facilities ?? []).map((f) => ({
          id: f.id,
          name: f.name,
          organizationId: f.organization_id,
          permissions: permsByFacility[f.id] ?? []
        }))
      });
    })()
  );

  return router;
}
