import { describe, it, expect } from "vitest";
import {
  evaluateAssignment,
  evaluateShift,
  buildScheduleEvaluation,
  DEFAULT_POLICY,
  type AssignmentEvaluation,
  type Conflict,
  type ConflictCode,
} from "@/lib/workforce/conflict-engine";

// A Tuesday 09:00–17:00 shift (2026-06-16 is a Tuesday, weekday 2).
const SHIFT = {
  id: "s1",
  facilityId: "f1",
  jobAreaId: "ja1",
  startsAt: "2026-06-16T09:00:00.000Z",
  endsAt: "2026-06-16T17:00:00.000Z",
  requiredCount: 1,
  assignedUserIds: ["u1"],
};

function ctx(overrides: Partial<AssignmentEvaluation> = {}): AssignmentEvaluation {
  return {
    shift: SHIFT,
    userId: "u1",
    existingAssignments: [],
    availability: { doublesAllowed: true, byWeekday: {} },
    requiredCerts: [],
    userCerts: [],
    policy: DEFAULT_POLICY,
    ...overrides,
  };
}

const codes = (cs: Conflict[]) => cs.map((c) => c.code);
const find = (cs: Conflict[], code: ConflictCode) => cs.find((c) => c.code === code);

describe("evaluateAssignment — clean case", () => {
  it("returns no conflicts when everything is fine", () => {
    expect(evaluateAssignment(ctx())).toEqual([]);
  });
});

describe("double_booking", () => {
  it("blocks on an overlapping existing assignment", () => {
    const c = evaluateAssignment(
      ctx({
        existingAssignments: [
          { shiftId: "s2", facilityId: "f1", startsAt: "2026-06-16T16:00:00.000Z", endsAt: "2026-06-16T20:00:00.000Z" },
        ],
      }),
    );
    expect(find(c, "double_booking")?.resolution).toBe("block");
  });

  it("does not flag non-overlapping shifts", () => {
    const c = evaluateAssignment(
      ctx({
        existingAssignments: [
          { shiftId: "s2", facilityId: "f1", startsAt: "2026-06-16T17:00:00.000Z", endsAt: "2026-06-16T21:00:00.000Z" },
        ],
      }),
    );
    expect(codes(c)).not.toContain("double_booking");
  });
});

describe("back_to_back_cross_facility", () => {
  it("warns when an adjacent shift is at a different facility", () => {
    const c = evaluateAssignment(
      ctx({
        availability: { doublesAllowed: true, byWeekday: {} },
        existingAssignments: [
          { shiftId: "s2", facilityId: "f2", startsAt: "2026-06-16T17:30:00.000Z", endsAt: "2026-06-16T21:00:00.000Z" },
        ],
      }),
    );
    expect(find(c, "back_to_back_cross_facility")?.resolution).toBe("warn");
  });

  it("does not warn for adjacency within the same facility", () => {
    const c = evaluateAssignment(
      ctx({
        existingAssignments: [
          { shiftId: "s2", facilityId: "f1", startsAt: "2026-06-16T17:15:00.000Z", endsAt: "2026-06-16T20:00:00.000Z" },
        ],
      }),
    );
    expect(codes(c)).not.toContain("back_to_back_cross_facility");
  });
});

describe("availability_closed / outside_availability", () => {
  it("blocks when the weekday is marked unavailable", () => {
    const c = evaluateAssignment(
      ctx({ availability: { doublesAllowed: true, byWeekday: { 2: { weekday: 2, unavailable: true } } } }),
    );
    expect(find(c, "availability_closed")?.resolution).toBe("block");
  });

  it("warns when outside the availability window", () => {
    const c = evaluateAssignment(
      ctx({
        availability: {
          doublesAllowed: true,
          byWeekday: { 2: { weekday: 2, unavailable: false, availableStart: "10:00", availableEnd: "14:00" } },
        },
      }),
    );
    expect(find(c, "outside_availability")?.resolution).toBe("warn");
  });
});

describe("doubles_not_allowed", () => {
  it("blocks a same-day second shift when doubles are not allowed", () => {
    const c = evaluateAssignment(
      ctx({
        availability: { doublesAllowed: false, byWeekday: {} },
        existingAssignments: [
          { shiftId: "s2", facilityId: "f1", startsAt: "2026-06-16T19:00:00.000Z", endsAt: "2026-06-16T22:00:00.000Z" },
        ],
      }),
    );
    expect(find(c, "doubles_not_allowed")?.resolution).toBe("block");
  });
});

describe("max_hours_day / max_hours_week", () => {
  it("warns over daily hours and escalates to block per policy", () => {
    const warn = evaluateAssignment(ctx({ availability: { doublesAllowed: true, maxHoursPerDay: 6, byWeekday: {} } }));
    expect(find(warn, "max_hours_day")?.resolution).toBe("warn");

    const block = evaluateAssignment(
      ctx({
        availability: { doublesAllowed: true, maxHoursPerDay: 6, byWeekday: {} },
        policy: { ...DEFAULT_POLICY, maxHoursDayBlocks: true },
      }),
    );
    expect(find(block, "max_hours_day")?.resolution).toBe("block");
  });

  it("warns over weekly hours", () => {
    const c = evaluateAssignment(
      ctx({
        availability: { doublesAllowed: true, maxHoursPerWeek: 10, byWeekday: {} },
        existingAssignments: [
          { shiftId: "s2", facilityId: "f1", startsAt: "2026-06-17T09:00:00.000Z", endsAt: "2026-06-17T14:00:00.000Z" },
        ],
      }),
    );
    expect(find(c, "max_hours_week")?.resolution).toBe("warn");
  });
});

describe("cert rules (three-hop result)", () => {
  const required = [{ certTypeId: "cpr", name: "CPR/AED" }];

  it("warns when a required cert is missing", () => {
    const c = evaluateAssignment(ctx({ requiredCerts: required, userCerts: [] }));
    expect(find(c, "missing_cert")?.resolution).toBe("warn");
  });

  it("blocks when a required cert is expired", () => {
    const c = evaluateAssignment(
      ctx({ requiredCerts: required, userCerts: [{ certTypeId: "cpr", status: "expired" }] }),
    );
    expect(find(c, "expired_cert")?.resolution).toBe("block");
  });

  it("warns (or blocks per policy) when a cert expires before the shift", () => {
    const userCerts = [{ certTypeId: "cpr", status: "active" as const, expiresOn: "2026-06-15T00:00:00.000Z" }];
    const warn = evaluateAssignment(ctx({ requiredCerts: required, userCerts }));
    expect(find(warn, "cert_expiring_before_shift")?.resolution).toBe("warn");

    const block = evaluateAssignment(
      ctx({ requiredCerts: required, userCerts, policy: { ...DEFAULT_POLICY, certExpiringBeforeShiftBlocks: true } }),
    );
    expect(find(block, "cert_expiring_before_shift")?.resolution).toBe("block");
  });

  it("is clean when a valid cert is held", () => {
    const c = evaluateAssignment(
      ctx({ requiredCerts: required, userCerts: [{ certTypeId: "cpr", status: "active", expiresOn: "2027-01-01T00:00:00.000Z" }] }),
    );
    expect(codes(c)).toHaveLength(0);
  });
});

describe("evaluateShift — open / understaffed", () => {
  it("warns on an open (unassigned) shift", () => {
    const c = evaluateShift({ ...SHIFT, assignedUserIds: [] });
    expect(find(c, "open_shift")?.resolution).toBe("warn");
  });

  it("warns when assigned below required count", () => {
    const c = evaluateShift({ ...SHIFT, requiredCount: 3, assignedUserIds: ["u1"] });
    expect(find(c, "understaffed_template")?.resolution).toBe("warn");
  });
});

describe("publish gate", () => {
  it("allows publish when there are no blocking conflicts", () => {
    const r = buildScheduleEvaluation([
      { code: "open_shift", resolution: "warn", label: "x", message: "x" },
    ]);
    expect(r.canPublish).toBe(true);
  });

  it("blocks publish when any blocking conflict exists, returning all of them", () => {
    const r = buildScheduleEvaluation([
      { code: "open_shift", resolution: "warn", label: "x", message: "x" },
      { code: "expired_cert", resolution: "block", label: "y", message: "y" },
      { code: "double_booking", resolution: "block", label: "z", message: "z" },
    ]);
    expect(r.canPublish).toBe(false);
    expect(r.blocking).toHaveLength(2);
  });
});
