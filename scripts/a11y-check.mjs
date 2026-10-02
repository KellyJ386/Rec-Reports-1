#!/usr/bin/env node
// P-7 (plans/WAVES_1_4_IMPLEMENTATION_PLAN.md, Slice 2D): a Playwright-driven
// mobile/accessibility check for the user-facing app shell, run on demand
// (`node scripts/a11y-check.mjs`) -- not wired into `npm test` or CI (see the
// task's own instruction: no existing Playwright usage exists in this repo
// to extend, so this is a standalone script). Pure logic it asserts on
// (contrast, accessible-name computation, tap-target sizing) lives in
// src/public/js/a11y.mjs and is unit-tested in test/a11y.test.mjs; this
// script injects that exact module into the page (see loadA11yHelpers)
// rather than re-implementing the same computation a second time, so the
// browser check and the unit tests can never quietly disagree.
//
// What it drives: the built app (`node scripts/build.mjs` then
// `node scripts/server.mjs <dist>`, mirroring test/build-user-app.test.mjs
// and .github/workflows/ci.yml's smoke-test job -- placeholder
// SUPABASE_URL=https://example.invalid / SUPABASE_ANON_KEY=x, same as CI) at
// a 390x844 viewport (iPhone 12/13 mini-ish -- the plan's own target size).
//
// Authenticated rendering needs a real backend (POST /api/v1/auth/sign-in
// talks to actual Supabase Auth) that isn't available here, but the app CAN
// be driven fully without one: every src/public/js/app.js fetch goes through
// apiFetch(), so Playwright's page.route() intercepts every /api/v1/*
// request before it reaches this script's own server and answers with a
// canned JSON response (mockApiRoutes below) -- exactly the "mocked
// authenticated state" the task calls for. /api/v1/public-config is the one
// route left unmocked (passed through to the real server), since it needs
// no backend either and IS what a real sign-in page would call.
//
// Playwright itself is expected pre-installed in the runtime environment
// (never `playwright install`-ed by this script -- see loadPlaywright's own
// comment) but is NOT a project dependency (zero-dependency, per repo
// convention) and so is not resolvable via a plain `import("playwright")`
// from inside this repo; loadPlaywright below finds it the same way `npm
// root -g` would.

import { readFileSync } from "node:fs";
import { loadPlaywright, freePort, buildToTempDir, removeTempDir, waitForServer, startBuiltAppServer } from "./lib/browser-harness.mjs";

// Reads src/public/js/a11y.mjs and strips its `export` keywords so it can be
// injected into the page as a plain classic script (page.addScriptTag can
// run a module-typed script, but keeping this a plain script avoids any
// same-origin/module-CORS fuss for an inline script tag). Exposes every
// export as a property of window.__a11y so the in-page assertions below use
// the EXACT SAME functions test/a11y.test.mjs already unit-tests -- no
// second implementation to drift out of sync.
function a11yHelpersScriptSource() {
  const source = readFileSync(new URL("../src/public/js/a11y.mjs", import.meta.url), "utf8");
  const names = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]);
  const stripped = source.replace(/^export (function|const)/gm, "$1");
  return `${stripped}\nwindow.__a11y = { ${names.join(", ")} };`;
}

// A canned JSON body for every /api/v1/* GET this app's initial render can
// issue. `platformAdmin: true` on /me is what unlocks every quick action and
// panel create-form (app.js's hasPerm() bypasses the per-facility
// `permissions` array entirely for a platform admin -- see its own doc
// comment) without this script having to enumerate every individual
// permission code the UI checks.
const MOCK_ME = {
  user: { id: "mock-user-1", email: "mock.reviewer@example.invalid" },
  platformAdmin: true,
  facilities: [{ id: "mock-facility-1", name: "Mock Facility", permissions: [], employeeId: "mock-employee-1" }]
};

async function mockApiRoutes(page) {
  // Playwright matches multiple registered routes last-registered-first (a
  // later page.route() call takes priority over an earlier, broader one) --
  // so the broad catch-all is registered FIRST here, with the two specific
  // overrides registered AFTER it, or the catch-all would swallow /me and
  // /public-config before they ever got a chance to run.
  //
  // Every other /api/v1/* GET (report templates, reports, incidents, work
  // orders, messages, training assignments, certifications, schedule
  // periods/shifts/assignments, employees, channels, ...): an empty array
  // is a valid response shape for every one of them (each is a list route),
  // and every app.js caller already handles an empty list -- rendering the
  // panel's own "No X yet" empty state -- exactly the baseline UI surface
  // (buttons, toggles, filters) this check needs to see.
  await page.route("**/api/v1/**", (route) => {
    if (route.request().method() !== "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_ME) })
  );
  await page.route("**/api/v1/public-config", (route) => route.continue());
}

// --- Assertions --------------------------------------------------------------

async function assertSkipLink(page, failures) {
  const skipLink = page.locator("a.skip-link");
  if ((await skipLink.count()) === 0) {
    failures.push("No a.skip-link element found.");
    return;
  }
  const href = await skipLink.getAttribute("href");
  if (href !== "#main-content") {
    failures.push(`Skip link's href is "${href}", expected "#main-content".`);
  }

  // Tab from the very top of the document -- the skip link is the first
  // focusable element in the DOM (see index.html), so this is the first tab
  // stop for a keyboard user landing on any fresh page load.
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press("Tab");
  const activeIsSkipLink = await page.evaluate(() => document.activeElement?.classList.contains("skip-link"));
  if (!activeIsSkipLink) {
    failures.push("Tabbing from the top of the page does not focus the skip link first.");
    return;
  }
  // Now that it's focused (and therefore on-screen -- .skip-link:focus sets
  // left:0), it's also an actual tap target and should meet the same 44x44
  // minimum as everything else.
  const MIN_TAP_TARGET_PX = await page.evaluate(() => window.__a11y.MIN_TAP_TARGET_PX);
  const focusedBox = await skipLink.boundingBox();
  if (!focusedBox || focusedBox.width < MIN_TAP_TARGET_PX || focusedBox.height < MIN_TAP_TARGET_PX) {
    failures.push(
      `Focused skip link is ${focusedBox ? `${Math.round(focusedBox.width)}x${Math.round(focusedBox.height)}` : "not visible"}, ` +
        `under ${MIN_TAP_TARGET_PX}x${MIN_TAP_TARGET_PX}px.`
    );
  }
  await page.keyboard.press("Enter");
  const activeId = await page.evaluate(() => document.activeElement?.id);
  if (activeId !== "main-content") {
    failures.push(`Activating the skip link did not move focus to #main-content (landed on "${activeId}").`);
  }
}

async function assertNoHorizontalOverflow(page, failures) {
  const overflow = await page.evaluate(() => {
    const docWidth = document.documentElement.scrollWidth;
    const viewportWidth = document.documentElement.clientWidth;
    return { docWidth, viewportWidth, overflowPx: docWidth - viewportWidth };
  });
  // A 1px tolerance for subpixel rounding across browsers/zoom levels.
  if (overflow.overflowPx > 1) {
    failures.push(
      `Page has horizontal overflow at 390px viewport: scrollWidth ${overflow.docWidth}px > ` +
        `clientWidth ${overflow.viewportWidth}px (${overflow.overflowPx}px over).`
    );
  }
}

// Runs the tap-target and accessible-name checks over every currently
// visible interactive element in the page (or inside `scopeSelector`, if
// given -- used to re-scope onto a freshly-opened create form). Returns
// {tapTargetFailures, nameFailures, checkedControls, checkedNames} so the
// caller can log a summary per scope.
async function checkInteractiveElements(page, { scopeSelector = "body", scopeLabel } = {}) {
  return page.evaluate(
    ({ scopeSelector, scopeLabel }) => {
      const { accessibleName, meetsMinTapTarget, MIN_TAP_TARGET_PX } = window.__a11y;

      const scope = document.querySelector(scopeSelector);
      if (!scope) return { tapTargetFailures: [], nameFailures: [], checkedControls: 0, checkedNames: 0 };

      const idToText = {};
      for (const el of document.querySelectorAll("[id]")) idToText[el.id] = el.textContent || "";

      function isVisible(el) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function describe(el) {
        const rect = el.getBoundingClientRect();
        const idAttr = el.id ? `#${el.id}` : "";
        const cls = el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/).join(".")}` : "";
        const text = (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 40);
        return `${scopeLabel ? `[${scopeLabel}] ` : ""}<${el.tagName.toLowerCase()}${idAttr}${cls}> "${text}" ` +
          `(${Math.round(rect.width)}x${Math.round(rect.height)} at ${Math.round(rect.x)},${Math.round(rect.y)})`;
      }

      const tapTargetFailures = [];
      const nameFailures = [];
      let checkedControls = 0;
      let checkedNames = 0;

      // Tap targets: every button/link-as-button/summary/select/input
      // (checkboxes/radios excepted -- see styles.css's own doc comment:
      // their wrapping <label> row is the real 44px target, not the native
      // control itself) plus <textarea>. .skip-link is excluded: it is
      // deliberately off-screen (position:absolute; left:-9999px) until it
      // receives keyboard focus, so measuring its resting bounding box here
      // would always fail for the wrong reason -- assertSkipLink checks its
      // real, focused size separately.
      const tapTargetSelector = [
        "button",
        "a.primary",
        "a[href]:not(.skip-link)",
        "summary",
        "select",
        "textarea",
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'
      ].join(", ");
      for (const el of scope.querySelectorAll(tapTargetSelector)) {
        if (!isVisible(el) || el.disabled) continue;
        checkedControls++;
        const rect = el.getBoundingClientRect();
        if (!meetsMinTapTarget(rect, MIN_TAP_TARGET_PX)) {
          tapTargetFailures.push(`${describe(el)} is under ${MIN_TAP_TARGET_PX}x${MIN_TAP_TARGET_PX}px.`);
        }
      }

      // Accessible names: every form control (input/select/textarea).
      const nameSelector = 'input:not([type="hidden"]), select, textarea';
      for (const el of scope.querySelectorAll(nameSelector)) {
        if (!isVisible(el) || el.disabled) continue;
        checkedNames++;
        const labels = el.labels ? [...el.labels].map((l) => l.textContent).join(" ").trim() : "";
        const control = {
          ariaLabelledby: el.getAttribute("aria-labelledby"),
          ariaLabel: el.getAttribute("aria-label"),
          labelText: labels || null,
          placeholder: el.getAttribute("placeholder"),
          title: el.getAttribute("title")
        };
        const result = accessibleName(control, { idToText });
        if (!result.name) {
          nameFailures.push(`${describe(el)} has no accessible name.`);
        }
      }

      return { tapTargetFailures, nameFailures, checkedControls, checkedNames };
    },
    { scopeSelector, scopeLabel }
  );
}

async function run() {
  const { module: playwright, resolvedFrom } = loadPlaywright();
  const { chromium } = playwright;
  console.log(`Using Playwright resolved from: ${resolvedFrom}`);
  const buildDir = buildToTempDir("rr-a11y-check-");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const { server, getOutput } = startBuiltAppServer({ buildDir, port });

  const failures = [];
  let totalControls = 0;
  let totalNames = 0;
  let browser;

  try {
    await waitForServer(baseUrl);

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    // Mocked authenticated state (see mockApiRoutes's own comment) -- set
    // BEFORE the page's own scripts run, since app.js reads this
    // synchronously off localStorage on DOMContentLoaded.
    await context.addInitScript(() => {
      try {
        localStorage.setItem("rr_admin_token", "mock-a11y-check-token");
      } catch {
        // Storage unavailable -- the page will bounce to /signin/ and the
        // assertions below will report that as a failure, which is correct.
      }
    });
    const page = await context.newPage();
    await mockApiRoutes(page);
    await page.addInitScript({ content: a11yHelpersScriptSource() });

    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });

    if (page.url().includes("/signin/")) {
      failures.push(
        "Navigating to / with a mocked auth token still redirected to /signin/ -- authenticated rendering could " +
          "not be driven without a real backend. Falling back to checking the sign-in page's own shell instead."
      );
      const skip = await page.locator("a.skip-link").count();
      if (skip === 0) {
        console.log("(sign-in page has no skip link -- expected, it has no repeated navigation to skip past)");
      }
      const signinChecks = await checkInteractiveElements(page, { scopeLabel: "signin" });
      failures.push(...signinChecks.tapTargetFailures, ...signinChecks.nameFailures);
      totalControls += signinChecks.checkedControls;
      totalNames += signinChecks.checkedNames;
    } else {
      // Home dashboard rendered -- wait for the quick actions (the first
      // thing loadAllModules() renders, see app.js's own comment) so every
      // check below runs against the fully-hydrated page, not a half-loaded
      // one.
      await page.waitForSelector("#home-quick-actions button", { timeout: 10000 });
      // Panels collapse under 640px on load (collapsePanelsOnMobile) -- give
      // that a moment to settle before measuring layout.
      await page.waitForTimeout(200);

      await assertSkipLink(page, failures);
      await assertNoHorizontalOverflow(page, failures);

      const baseline = await checkInteractiveElements(page, { scopeLabel: "baseline" });
      failures.push(...baseline.tapTargetFailures, ...baseline.nameFailures);
      totalControls += baseline.checkedControls;
      totalNames += baseline.checkedNames;

      // P-7 priority forms: open the incident capture form and the work
      // order create form via their home-dashboard quick actions (the same
      // path a pilot user takes -- see the plan's P-3/P-7 pair), then
      // re-check just inside each newly-opened form.
      const quickActionScopes = [
        { buttonText: "Log incident", scopeSelector: ".incident-capture-form", label: "incident capture form" },
        { buttonText: "New work order", scopeSelector: ".work-order-create-form", label: "work order create form" }
      ];
      for (const { buttonText, scopeSelector, label } of quickActionScopes) {
        const button = page.locator("#home-quick-actions button", { hasText: buttonText });
        if ((await button.count()) === 0) {
          failures.push(`Quick action button "${buttonText}" not found -- cannot check the ${label}.`);
          continue;
        }
        await button.first().click();
        try {
          await page.waitForSelector(scopeSelector, { timeout: 5000 });
        } catch {
          failures.push(`Quick action "${buttonText}" did not open ${scopeSelector} (the ${label}).`);
          continue;
        }
        const formCheck = await checkInteractiveElements(page, { scopeSelector, scopeLabel: label });
        failures.push(...formCheck.tapTargetFailures, ...formCheck.nameFailures);
        totalControls += formCheck.checkedControls;
        totalNames += formCheck.checkedNames;
      }

      // Global search box: labeled via index.html's own <label for=...>
      // (P-8), checked here as part of the "search box" priority surface.
      const searchCheck = await checkInteractiveElements(page, { scopeSelector: "#global-search", scopeLabel: "search box" });
      failures.push(...searchCheck.tapTargetFailures, ...searchCheck.nameFailures);
      totalControls += searchCheck.checkedControls;
      totalNames += searchCheck.checkedNames;

      // Every module panel is a <details> collapsed on load under 640px
      // (collapsePanelsOnMobile, app.js) -- expand them all and re-check the
      // whole page, so the report-inbox filters, schedule board, comms
      // compose form, training, and certifications panels (none reachable
      // from a home-dashboard quick action) get the same tap-target/
      // accessible-name coverage as the baseline sweep above, instead of
      // being silently skipped as hidden.
      await page.evaluate(() => {
        document.querySelectorAll("main > details.panel").forEach((panel) => (panel.open = true));
      });
      // Comms compose form needs its own toggle click (not a quick action).
      const composeToggle = page.locator("#comms-workspace button", { hasText: "Compose message" });
      if ((await composeToggle.count()) > 0) await composeToggle.first().click();
      await page.waitForTimeout(200);
      const expanded = await checkInteractiveElements(page, { scopeLabel: "expanded panels" });
      failures.push(...expanded.tapTargetFailures, ...expanded.nameFailures);
      totalControls += expanded.checkedControls;
      totalNames += expanded.checkedNames;
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
    removeTempDir(buildDir);
  }

  console.log(`Checked ${totalControls} interactive elements for tap-target size, ${totalNames} form controls for accessible name.`);
  if (failures.length === 0) {
    console.log("PASS: no accessibility failures found.");
    return 0;
  }

  console.log(`FAIL: ${failures.length} issue(s) found:\n`);
  for (const failure of failures) console.log(`  - ${failure}`);
  const serverOutput = getOutput().trim();
  if (serverOutput) {
    console.log("\n--- server output ---");
    console.log(serverOutput);
  }
  return 1;
}

run()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("a11y-check crashed:", error);
    process.exit(1);
  });
