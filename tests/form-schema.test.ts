import { describe, it, expect } from "vitest";
import { parseFormSchema, validateAnswers, type FormField } from "@/lib/facility/form-schema";

describe("parseFormSchema", () => {
  it("accepts a valid schema", () => {
    const r = parseFormSchema([
      { key: "temp", label: "Pool temp", type: "number", min: 0, max: 120, required: true },
      { key: "ok", label: "All clear?", type: "yes_no" },
    ]);
    expect(r.error).toBeUndefined();
    expect(r.fields).toHaveLength(2);
  });

  it("rejects duplicate keys", () => {
    const r = parseFormSchema([
      { key: "a", label: "A", type: "text" },
      { key: "a", label: "A2", type: "text" },
    ]);
    expect(r.error).toMatch(/duplicate/i);
  });

  it("requires options on select fields", () => {
    const r = parseFormSchema([{ key: "s", label: "Pick", type: "single_select" }]);
    expect(r.error).toMatch(/option/i);
  });
});

describe("validateAnswers", () => {
  const fields: FormField[] = [
    { key: "name", label: "Inspector", type: "text", required: true },
    { key: "temp", label: "Temp", type: "number", min: 0, max: 100 },
    { key: "clean", label: "Clean?", type: "yes_no", required: true },
    { key: "zone", label: "Zone", type: "single_select", options: ["A", "B"] },
    { key: "issues", label: "Issues", type: "multi_select", options: ["leak", "trip"] },
    { key: "score", label: "Score", type: "rating" },
    { key: "header", label: "Section", type: "section_header" },
  ];

  it("passes a complete, valid response", () => {
    const r = validateAnswers(fields, {
      name: "Sam", temp: 80, clean: true, zone: "A", issues: ["leak"], score: 4,
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
    expect(r.value.clean).toBe(true);
  });

  it("flags missing required fields", () => {
    const r = validateAnswers(fields, { temp: 50 });
    expect(r.ok).toBe(false);
    expect(r.errors.name).toBeDefined();
    expect(r.errors.clean).toBeDefined();
  });

  it("enforces number bounds", () => {
    const r = validateAnswers(fields, { name: "Sam", clean: false, temp: 200 });
    expect(r.errors.temp).toMatch(/≤ 100/);
  });

  it("rejects out-of-set select values", () => {
    const r = validateAnswers(fields, { name: "Sam", clean: true, zone: "Z" });
    expect(r.errors.zone).toBeDefined();
  });

  it("rejects invalid multi-select members and bad rating", () => {
    const r = validateAnswers(fields, { name: "Sam", clean: true, issues: ["leak", "nope"], score: 9 });
    expect(r.errors.issues).toBeDefined();
    expect(r.errors.score).toMatch(/1–5/);
  });

  it("coerces stringified yes_no and number", () => {
    const r = validateAnswers(fields, { name: "Sam", clean: "true", temp: "42" });
    expect(r.ok).toBe(true);
    expect(r.value.clean).toBe(true);
    expect(r.value.temp).toBe(42);
  });

  it("ignores display-only fields", () => {
    const r = validateAnswers(fields, { name: "Sam", clean: true });
    expect(r.value.header).toBeUndefined();
  });
});
