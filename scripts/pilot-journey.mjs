#!/usr/bin/env node
// Wave 2 exit-gate check (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md
// §Verification, "Wave 2"): a Playwright-driven pilot journey against the
// BUILT user-facing app (`node scripts/build.mjs` then
// `node scripts/server.mjs <dist>`, same placeholder Supabase credentials
// as CI's smoke-test job) with a MOCKED, STATEFUL backend, run on demand
// (`node scripts/pilot-journey.mjs`) -- not wired into `npm test` or CI, per
// the task's own instruction.
//
// Unlike scripts/a11y-check.mjs's mockApiRoutes (every GET answers a canned
// response, independent of any earlier write -- fine for an accessibility
// sweep that never reads a response body back), this script's backend is
// scripts/lib/pilot-mock.mjs's in-memory store: a POST changes what a later
// GET returns, in the SAME session and across a page reload (Playwright's
// page.route() intercepts every /api/v1/* request and answers from that one
// store for the page's whole lifetime, reload included -- see
// installMockRoutes below). That statefulness is what lets this script
// prove things scripts/a11y-check.mjs structurally cannot: that submitting a
// report shows up in the reports list, that acknowledging a message is
// still acknowledged after a reload, that a schedule assignment seeded
// before the browser ever opened (never created by anything this script
// does) survives one too.
//
// Shared build/serve/port plumbing lives in scripts/lib/browser-harness.mjs
// (extracted out of scripts/a11y-check.mjs so the two scripts' handling of
// that can never drift apart); this file is the pilot-journey-specific part
// on top: the mock-route wiring, the eight journey steps, and the
// PASS/FAIL reporting the task asks for.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadPlaywright,
  freePort,
  buildToTempDir,
  removeTempDir,
  waitForServer,
  startBuiltAppServer
} from "./lib/browser-harness.mjs";
import { createPilotStore, routeMock, PILOT_EMAIL, PILOT_PASSWORD } from "./lib/pilot-mock.mjs";

// Where a failing step's screenshot is saved. Not hardcoded to any one
// environment's scratch directory (this script is committed to the repo and
// run from many contexts) -- PILOT_SCREENSHOT_DIR lets a caller (this task's
// own gate run included) point it at whatever directory makes sense there;
// left unset it falls back to a directory next to the repo root.
const screenshotDir = process.env.PILOT_SCREENSHOT_DIR || join(process.cwd(), "pilot-journey-failures");

// A tiny (1x1, transparent) PNG -- enough bytes to exercise the real
// upload path (raw-body POST, x-file-name/x-field-key headers, a storage
// path recorded on the mock's attachment row) without needing a real image
// asset checked into the repo.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function slug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

// Registers the one page.route() handler this whole journey runs through:
// every /api/v1/* request is answered from `store` via pilot-mock.mjs's
// routeMock (a POST/PATCH mutates `store` in place, so the very next GET --
// in this page or, after a reload, a freshly-initialized one -- sees it).
// /api/v1/public-config is passed through to the real server (it needs no
// backend and is what a real sign-in page calls first), matching
// a11y-check.mjs's own mockApiRoutes.
async function installMockRoutes(page, store) {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/public-config") {
      await route.continue();
      return;
    }
    const method = request.method();
    const pathname = url.pathname.slice("/api/v1".length) || "/";

    let body;
    if (method === "POST" && pathname.endsWith("/attachments")) {
      // Attachment uploads (app.js's uploadAttachmentFile) send raw file
      // bytes as the body, never JSON -- the metadata the mock needs
      // (field key, filename, content type) travels in headers instead.
      const headers = request.headers();
      body = {
        fieldKey: headers["x-field-key"],
        fileName: headers["x-file-name"] ? decodeURIComponent(headers["x-file-name"]) : undefined,
        contentType: headers["content-type"]
      };
    } else if (method !== "GET" && method !== "DELETE") {
      try {
        body = request.postDataJSON();
      } catch {
        body = undefined;
      }
    }

    const result = routeMock(store, { method, pathname, searchParams: url.searchParams, body });
    await route.fulfill({ status: result.status, contentType: "application/json", body: JSON.stringify(result.json) });
  });
}

// Reads one home-dashboard tile's value text by its title (buildTiles'
// `${tile.title}: ${tile.value}...` aria-label, plus the plain
// .home-tile-value node this reads instead so partial-hint text never
// leaks into an exact-match assertion).
async function tileValue(page, title) {
  const tile = page.locator("#home-tiles .home-tile", { hasText: title });
  await tile.waitFor({ state: "visible", timeout: 5000 });
  return (await tile.locator(".home-tile-value").innerText()).trim();
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

// Every module panel is a <details> that collapsePanelsOnMobile() (app.js)
// closes on load under the 640px breakpoint -- true at this journey's
// 390x844 viewport, per the task's own instruction. A closed <details>'s
// content is not "visible" to Playwright (nor to a real user without an
// extra tap), so every panel is force-opened right after each page load
// (initial sign-in AND the step-6 reload, since collapsePanelsOnMobile runs
// again on every DOMContentLoaded) rather than leaving later steps to
// stumble on a hidden-by-default panel one at a time.
async function expandAllPanels(page) {
  await page.evaluate(() => {
    document.querySelectorAll("main > details.panel").forEach((panel) => {
      panel.open = true;
    });
  });
}

async function run() {
  mkdirSync(screenshotDir, { recursive: true });

  const { module: playwright, resolvedFrom } = loadPlaywright();
  const { chromium } = playwright;
  console.log(`Using Playwright resolved from: ${resolvedFrom}`);

  const buildDir = buildToTempDir("rr-pilot-journey-");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { server, getOutput } = startBuiltAppServer({ buildDir, port });

  const store = createPilotStore();
  // Filled in as the journey creates real rows, so later steps (search,
  // detail re-open) can assert against the actual ids the mock minted
  // rather than guessing them.
  const created = { incidentId: null, incidentNo: null, reportId: null };

  let browser;
  let page;
  const failures = [];

  async function step(name, fn) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.log(`FAIL: ${name} -- ${error.message}`);
      if (page) {
        try {
          await page.screenshot({ path: join(screenshotDir, `pilot-${slug(name)}.png`), fullPage: true });
        } catch (screenshotError) {
          console.log(`  (could not save failure screenshot: ${screenshotError.message})`);
        }
      }
    }
  }

  try {
    await waitForServer(baseUrl);

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await context.newPage();
    await installMockRoutes(page, store);

    // --- Step 1: sign in -----------------------------------------------
    await step("1. sign in", async () => {
      await page.goto(`${baseUrl}/signin/`, { waitUntil: "networkidle" });
      await page.locator("#email-input").fill(PILOT_EMAIL);
      await page.locator("#password-input").fill(PILOT_PASSWORD);
      await page.locator("#signin-button").click();
      await page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 10000 });
      await page.waitForSelector("#home-quick-actions button", { timeout: 10000 });
      await expandAllPanels(page);
      const email = (await page.locator("#user-email").innerText()).trim();
      assertEqual(email, PILOT_EMAIL, "header does not show the signed-in user's email");
    });

    // --- Step 2: home renders first, quick actions + tiles from the mock -
    await step("2. home dashboard renders with manager quick actions and mock-derived tiles", async () => {
      await page.waitForSelector("#home-quick-actions button", { timeout: 10000 });
      const actionLabels = await page.locator("#home-quick-actions button").allInnerTexts();
      assertOk(
        ["Submit report", "Log incident", "New work order"].every((label) => actionLabels.includes(label)),
        `expected all three manager quick actions, got ${JSON.stringify(actionLabels)}`
      );

      // Wait for the reports panel's own load (part of the same
      // loadAllModules Promise.all as the tiles) so publishedReportTemplates
      // is populated before step 3 relies on it.
      await page.waitForSelector("#reports-list", { timeout: 10000 });
      await page.locator("#reports-list", { hasText: "Pool Chemical Log" }).waitFor({ timeout: 10000 });

      assertEqual(await tileValue(page, "Reports due today"), "0/1 filed", "reports-due tile does not match the seeded mock state");
      assertEqual(await tileValue(page, "My open work orders"), "1", "my-open-work-orders tile does not match the seeded mock state");
      assertEqual(await tileValue(page, "Open incidents"), "0", "open-incidents tile does not match the seeded mock state");
      assertEqual(
        await tileValue(page, "Unacknowledged messages"),
        "1",
        "unacknowledged-messages tile does not match the seeded mock state"
      );
      assertEqual(
        await tileValue(page, "Expiring certifications"),
        "1",
        "expiring-certifications tile does not match the seeded mock state"
      );
      assertEqual(await tileValue(page, "Today's shifts"), "1", "today's-shifts tile does not match the seeded mock state");
    });

    // --- Step 3: submit a report from a template, with a field and a photo
    await step("3. submit report quick action fills, attaches a photo, and submits", async () => {
      await page.locator("#home-quick-actions button", { hasText: "Submit report" }).click();
      const reportArea = page.locator("#report-form-area");
      await reportArea.waitFor({ state: "visible", timeout: 10000 });
      await reportArea.locator("h3", { hasText: "Pool Chemical Log" }).waitFor({ timeout: 10000 });

      await reportArea.getByLabel("Notes").fill("Chlorine at 3.2 ppm, pH 7.4. Added stabilizer per SOP.");

      const photoInput = reportArea.getByLabel("Evidence photo");
      await photoInput.setInputFiles({ name: "pool-evidence.png", mimeType: "image/png", buffer: ONE_PIXEL_PNG });
      await reportArea.locator(".report-field-file .item-subtitle", { hasText: "Uploaded" }).waitFor({ timeout: 10000 });

      await reportArea.getByRole("button", { name: "Submit", exact: true }).click();
      // Not `.report-form-status`'s own "Submitted" text: submitReport()
      // sets that, then immediately calls render() (createReportFormController
      // in app.js), which rebuilds the whole form -- including a fresh, empty
      // .report-form-status span -- so that transient text never actually
      // stays on screen. The read-only action bar's permanent
      // "Status: submitted" label (the else-branch of that same render()) is
      // the real, stable signal that the submit landed.
      await reportArea.locator(".report-form-actions", { hasText: "Status: submitted" }).waitFor({ timeout: 10000 });

      const submissions = [...store.reportSubmissions.values()];
      assertEqual(submissions.length, 1, "expected exactly one report submission to have been created");
      created.reportId = submissions[0].id;
      assertEqual(submissions[0].status, "submitted", "the created report submission is not marked submitted in the mock");
      assertOk(
        submissions[0].payload_json.evidence_photo && submissions[0].payload_json.evidence_photo.length > 0,
        "the submitted report's payload has no evidence_photo storage path -- the attachment upload did not reach the field"
      );

      // The Daily reports panel's "Recent submissions" list refreshes right
      // after submit (reportFormController.submitReport awaits loadReports())
      // -- confirms the write is reflected without waiting for a reload.
      await page.locator("#reports-list", { hasText: "submitted" }).waitFor({ timeout: 10000 });
    });

    // --- Step 4: log an incident, add a person, add a statement ----------
    await step("4. log incident quick action, add a person, add a statement", async () => {
      await page.locator("#home-quick-actions button", { hasText: "Log incident" }).click();
      const captureForm = page.locator(".incident-capture-form");
      await captureForm.waitFor({ state: "visible", timeout: 10000 });

      await captureForm.getByLabel("Incident type").selectOption("incident");
      await captureForm.getByLabel("Severity").selectOption("medium");
      await captureForm.getByLabel("Occurred at").fill("2026-09-07T10:00");
      await captureForm.getByLabel("Location").fill("Pool Deck");
      await captureForm
        .getByLabel("Summary")
        .fill("Chemical fumes triggered a pool evacuation near the diving board.");
      await captureForm.getByRole("button", { name: "Save draft incident" }).click();

      const detailPanel = page.locator("#incident-detail-panel");
      await detailPanel.waitFor({ state: "visible", timeout: 10000 });
      await page.waitForFunction(() => document.querySelector("#incident-detail-panel h3")?.textContent?.startsWith("INC-"), {
        timeout: 10000
      });

      const incidents = [...store.incidents.values()];
      assertEqual(incidents.length, 1, "expected exactly one incident to have been created");
      created.incidentId = incidents[0].id;
      created.incidentNo = incidents[0].incident_no;

      await detailPanel.getByRole("button", { name: "Add person" }).click();
      const personForm = detailPanel.locator(".add-person-form");
      await personForm.waitFor({ state: "visible", timeout: 10000 });
      await personForm.getByLabel("Role").selectOption("witness");
      await personForm.getByLabel("Full name").fill("Alex Morgan");
      await personForm.getByRole("button", { name: "Add person" }).click();

      await detailPanel.locator(".module-item", { hasText: "Alex Morgan" }).waitFor({ timeout: 10000 });
      const peopleText = await detailPanel.locator(".module-item", { hasText: "Alex Morgan" }).innerText();
      assertOk(peopleText.includes("witness"), `expected the new person's row to show their role, got: ${peopleText}`);

      await detailPanel.getByRole("button", { name: "Statements" }).click();
      const statementForm = detailPanel.locator(".inline-form", { hasText: "Statement text" });
      await statementForm.waitFor({ state: "visible", timeout: 10000 });
      await statementForm.getByLabel("Statement text").fill("Witnessed chemical fumes near the diving board around 10am.");
      await statementForm.getByRole("button", { name: "Add statement" }).click();

      // Scoped to .module-section (buildStatementHistory's own wrapper),
      // not the broader .module-item: the person's own row is ALSO a
      // .module-item and, once its statement history is open, textually
      // contains "Version 1" too via that nested section -- matching on
      // .module-item alone would resolve to both and violate strict mode.
      await detailPanel.locator(".module-section .module-item", { hasText: "Version 1" }).waitFor({ timeout: 10000 });
      assertEqual(
        (await listIncidentPeople(store, created.incidentId)).length,
        1,
        "mock store has the wrong number of people recorded for the incident"
      );
      assertEqual(
        (await listIncidentStatements(store)).length,
        1,
        "mock store has the wrong number of statements recorded for the person"
      );

      // Move the incident on to submitted, so the "Open incidents" tile and
      // the search step below both have something realistic to reflect --
      // exercises the submit action this same detail panel exposes.
      await detailPanel.getByRole("button", { name: "Submit incident" }).click();
      await page.waitForFunction(
        () => document.querySelector("#incident-detail-panel")?.textContent?.includes("Status: submitted"),
        { timeout: 10000 }
      );
    });

    // --- Step 5: acknowledge a required-ack message -----------------------
    await step("5. required-ack message starts unacknowledged, then acknowledges", async () => {
      const messageId = [...store.messages.keys()][0];
      const card = page.locator(`#message-card-${messageId}`);
      await card.waitFor({ state: "visible", timeout: 10000 });
      const beforeText = await card.innerText();
      assertOk(/pending/i.test(beforeText), `expected the required-ack message to start pending, got: ${beforeText}`);

      await card.getByRole("button", { name: "Acknowledge" }).click();
      await page.waitForFunction(
        (id) => {
          const el = document.getElementById(`message-card-${id}`);
          return !!el && /complete/i.test(el.textContent || "") && !el.textContent.includes("Acknowledge");
        },
        messageId,
        { timeout: 10000 }
      );

      const acks = store.acknowledgements.get(messageId) || [];
      assertEqual(acks.length, 1, "mock store did not record an acknowledgement for the message");
      assertEqual(acks[0].employee_id, store.employeeId, "the recorded acknowledgement is not for the signed-in employee");
    });

    // --- Reload: prove step 5's ack, step 3/4's tile counts, and step 6's
    // pre-seeded schedule assignment all come from the MOCK, not from
    // in-memory session state that a reload would otherwise wipe. ----------
    await step("6. after a reload: ack persists, tiles reflect mock state, schedule board shows the pre-seeded assignment", async () => {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("#home-quick-actions button", { timeout: 10000 });
      await expandAllPanels(page);

      const messageId = [...store.messages.keys()][0];
      const card = page.locator(`#message-card-${messageId}`);
      await card.waitFor({ state: "visible", timeout: 10000 });
      // seedAckStateForVisibleMessages seeds this from
      // GET .../acknowledgements?employeeId=me -- server state, not
      // anything carried over from before the reload.
      await page.waitForFunction(
        (id) => /complete/i.test(document.getElementById(`message-card-${id}`)?.textContent || ""),
        messageId,
        { timeout: 10000 }
      );

      assertEqual(await tileValue(page, "Unacknowledged messages"), "0", "unacknowledged-messages tile did not decrement after reload");
      assertEqual(await tileValue(page, "Reports due today"), "1/1 filed", "reports-due tile did not reflect the submitted report after reload");
      assertEqual(await tileValue(page, "Open incidents"), "1", "open-incidents tile did not reflect the submitted incident after reload");

      const scheduleBoard = page.locator("#schedule-workspace");
      await scheduleBoard.waitFor({ state: "visible", timeout: 10000 });
      await scheduleBoard.locator(".shift-card", { hasText: "lifeguard" }).waitFor({ timeout: 10000 });
      const shiftCardText = await scheduleBoard.locator(".shift-card", { hasText: "lifeguard" }).first().innerText();
      assertOk(
        shiftCardText.includes("Jordan Rivera"),
        `expected today's pre-seeded shift to show its assignment, got: ${shiftCardText}`
      );
    });

    // --- Step 7: global search finds the incident, opens its detail -------
    await step("7. global search finds the incident by summary word and opens its detail", async () => {
      const searchInput = page.locator("#global-search-input");
      await searchInput.fill("evacuation");
      await page.waitForSelector("#global-search-results .global-search-result", { timeout: 10000 });

      const resultsPanel = page.locator("#global-search-results");
      // .global-search-group-label is styled text-transform: uppercase
      // (styles.css) -- innerText reflects that CSS rendering, so this
      // compares case-insensitively rather than against the raw DOM text
      // ("Incidents") the label element actually holds.
      const groupLabels = await resultsPanel.locator(".global-search-group-label").allInnerTexts();
      assertOk(
        groupLabels.some((label) => label.toLowerCase() === "incidents"),
        `expected an "Incidents" result group, got: ${JSON.stringify(groupLabels)}`
      );

      const incidentResult = resultsPanel.locator(".global-search-result", { hasText: created.incidentNo });
      await incidentResult.waitFor({ timeout: 10000 });
      await incidentResult.click();

      await page.waitForFunction(
        (incidentNo) => document.querySelector("#incident-detail-panel h3")?.textContent === incidentNo,
        created.incidentNo,
        { timeout: 10000 }
      );
    });

    // --- Step 8: sign out, then a protected route redirects ---------------
    await step("8. sign out returns to /signin/, and a protected route then redirects there", async () => {
      await page.locator("#sign-out-btn").click();
      await page.waitForURL((url) => url.pathname.startsWith("/signin"), { timeout: 10000 });

      await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
      await page.waitForURL((url) => url.pathname.startsWith("/signin"), { timeout: 10000 });
    });
  } finally {
    if (browser) await browser.close();
    server.kill();
    removeTempDir(buildDir);
  }

  if (failures.length > 0) {
    console.log(`\nFAIL: ${failures.length}/8 step(s) failed.`);
    const serverOutput = getOutput().trim();
    if (serverOutput) {
      console.log("\n--- server output ---");
      console.log(serverOutput);
    }
    return 1;
  }
  console.log("\nPASS: pilot journey completed all 8 steps.");
  return 0;
}

// Small store-reading helpers kept local to this script (rather than added
// to pilot-mock.mjs's own exports) since they exist only to phrase step 4's
// own assertions readably -- store.incidentPeople/incidentStatements are
// already plain Maps a caller can read directly.
async function listIncidentPeople(store, incidentId) {
  return store.incidentPeople.get(incidentId) || [];
}
async function listIncidentStatements(store) {
  return [...store.incidentStatements.values()].flat();
}

run()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("pilot-journey crashed:", error);
    process.exit(1);
  });
