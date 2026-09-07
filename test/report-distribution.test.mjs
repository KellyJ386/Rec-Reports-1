import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveReportRecipients,
  buildDeliverySubject,
  buildImmediateEmailText,
  buildDigestSubject,
  buildDigestText
} from "../src/lib/report-distribution.mjs";

const FAC_A = "fac-a";
const FAC_B = "fac-b";

function binding(overrides = {}) {
  return {
    id: "binding-1",
    facility_id: FAC_A,
    template_id: "tmpl-1",
    distribution_list_id: "list-1",
    department_id: null,
    role_id: null,
    channel: "email",
    attach_pdf: false,
    digest: false,
    active: true,
    ...overrides
  };
}

test("resolveReportRecipients expands the bound list and dedupes by employee id", () => {
  const members = [
    { facility_id: FAC_A, distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1" },
    { facility_id: FAC_A, distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1" },
    { facility_id: FAC_A, distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-2" }
  ];
  const employees = [
    { id: "emp-1", facility_id: FAC_A, department_id: "dept-1", user_id: "user-1" },
    { id: "emp-2", facility_id: FAC_A, department_id: "dept-2", user_id: "user-2" }
  ];
  const result = resolveReportRecipients({ binding: binding(), members, employees, memberships: [] });
  assert.deepEqual(result, ["emp-1", "emp-2"]);
});

test("resolveReportRecipients expands role members via memberships", () => {
  const members = [{ facility_id: FAC_A, distribution_list_id: "list-1", member_type: "role", member_ref_id: "role-mgr" }];
  const employees = [
    { id: "emp-1", facility_id: FAC_A, department_id: "dept-1", user_id: "user-1" },
    { id: "emp-2", facility_id: FAC_A, department_id: "dept-2", user_id: "user-2" }
  ];
  const memberships = [
    { facility_id: FAC_A, user_id: "user-1", role_id: "role-mgr", status: "active" },
    { facility_id: FAC_A, user_id: "user-2", role_id: "role-other", status: "active" }
  ];
  const result = resolveReportRecipients({ binding: binding(), members, employees, memberships });
  assert.deepEqual(result, ["emp-1"]);
});

test("resolveReportRecipients filters by department_id when the binding carries one", () => {
  const members = [
    { facility_id: FAC_A, distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1" },
    { facility_id: FAC_A, distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-2" }
  ];
  const employees = [
    { id: "emp-1", facility_id: FAC_A, department_id: "dept-1" },
    { id: "emp-2", facility_id: FAC_A, department_id: "dept-2" }
  ];
  const result = resolveReportRecipients({
    binding: binding({ department_id: "dept-1" }),
    members,
    employees,
    memberships: []
  });
  assert.deepEqual(result, ["emp-1"]);
});

test("resolveReportRecipients filters by role_id when the binding carries one, even for employee members", () => {
  const members = [
    { facility_id: FAC_A, distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1" },
    { facility_id: FAC_A, distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-2" }
  ];
  const employees = [
    { id: "emp-1", facility_id: FAC_A, department_id: "dept-1", user_id: "user-1" },
    { id: "emp-2", facility_id: FAC_A, department_id: "dept-1", user_id: "user-2" }
  ];
  const memberships = [
    { facility_id: FAC_A, user_id: "user-1", role_id: "role-mgr", status: "active" },
    { facility_id: FAC_A, user_id: "user-2", role_id: "role-other", status: "active" }
  ];
  const result = resolveReportRecipients({
    binding: binding({ role_id: "role-mgr" }),
    members,
    employees,
    memberships
  });
  assert.deepEqual(result, ["emp-1"]);
});

test("resolveReportRecipients never resolves outside the binding's own facility", () => {
  const members = [
    { facility_id: FAC_A, distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-1" },
    // Same list id, but a row that (incorrectly) carries facility B -- must
    // never leak into facility A's resolution even though expandDistributionList
    // itself does not filter by facility.
    { facility_id: FAC_B, distribution_list_id: "list-1", member_type: "employee", member_ref_id: "emp-cross" }
  ];
  const employees = [
    { id: "emp-1", facility_id: FAC_A, department_id: null },
    { id: "emp-cross", facility_id: FAC_B, department_id: null }
  ];
  const result = resolveReportRecipients({ binding: binding(), members, employees, memberships: [] });
  assert.deepEqual(result, ["emp-1"]);
});

test("resolveReportRecipients returns [] for a binding with no facility_id or distribution_list_id", () => {
  assert.deepEqual(resolveReportRecipients({ binding: null }), []);
  assert.deepEqual(resolveReportRecipients({ binding: { facility_id: FAC_A } }), []);
});

test("buildDeliverySubject uses the template name and report date", () => {
  assert.equal(
    buildDeliverySubject({ name: "Shift Handoff" }, { report_date: "2026-09-07" }),
    "Shift Handoff – 2026-09-07"
  );
});

test("buildImmediateEmailText links the report and includes the PDF line only when attach_pdf is set", () => {
  const submission = { id: "sub-1", report_date: "2026-09-07", shift_ref: "AM", pdf_status: "not_requested" };
  const template = { name: "Shift Handoff" };
  const withoutPdf = buildImmediateEmailText({ submission, template, binding: binding({ attach_pdf: false }), appUrl: "https://app.test" });
  assert.match(withoutPdf, /https:\/\/app\.test\/reports\/sub-1/);
  assert.doesNotMatch(withoutPdf, /PDF/);

  const withPdf = buildImmediateEmailText({ submission, template, binding: binding({ attach_pdf: true }), appUrl: "https://app.test" });
  assert.match(withPdf, /PDF: will be attached once generated\./);

  const generated = buildImmediateEmailText({
    submission: { ...submission, pdf_status: "generated" },
    template,
    binding: binding({ attach_pdf: true }),
    appUrl: "https://app.test"
  });
  assert.match(generated, /PDF: https:\/\/app\.test\/reports\/sub-1\/pdf/);
});

test("buildDigestSubject/buildDigestText summarize every entry", () => {
  const entries = [
    { submission: { id: "s1", report_date: "2026-09-01", pdf_status: "generated" }, template: { name: "Shift Handoff" }, binding: binding({ attach_pdf: true }) },
    { submission: { id: "s2", report_date: "2026-09-02" }, template: { name: "Safety Walk" }, binding: binding({ attach_pdf: false }) }
  ];
  assert.equal(buildDigestSubject(entries), "Report digest – 2 submissions");
  const text = buildDigestText({ entries, appUrl: "https://app.test" });
  assert.match(text, /Shift Handoff \(2026-09-01\): https:\/\/app\.test\/reports\/s1/);
  assert.match(text, /PDF: https:\/\/app\.test\/reports\/s1\/pdf/);
  assert.match(text, /Safety Walk \(2026-09-02\): https:\/\/app\.test\/reports\/s2/);
});

test("buildDigestSubject singularizes for exactly one submission", () => {
  assert.equal(buildDigestSubject([{}]), "Report digest – 1 submission");
});
