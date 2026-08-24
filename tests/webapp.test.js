/**
 * Webapp smoke tests: modules parse, index references them, package is a
 * webapp. Full DOM behavior is exercised manually in the browser.
 * @file webapp.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync, existsSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

test("every public module passes a syntax check", () => {
  const files = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 4, "expected the webapp modules to exist");
  for (const file of files) {
    const result = spawnSync(
      process.execPath,
      ["--check", path.join(PUBLIC_DIR, file)],
      { encoding: "utf8" },
    );
    assert.strictEqual(
      result.status,
      0,
      `${file} must parse: ${result.stderr}`,
    );
  }
});

test("index.html loads all modules and the stylesheet", () => {
  const html = readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  // Library modules imported by other webapp modules via ES imports,
  // not loaded directly by index.html as a top-level script. These have
  // no side effects (no custom element, no bootstrap) and are pulled in
  // by the components that use them, so they must not be required as
  // top-level <script> sources.
  const libraries = new Set(["ep-solar-time.js"]);
  for (const file of readdirSync(PUBLIC_DIR)) {
    // icon.png is for the server's webapp list, not the page itself
    if (file === "index.html" || file === "icon.png") continue;
    if (libraries.has(file)) continue;
    assert.ok(html.includes(`./${file}`), `index.html must reference ${file}`);
  }
  assert.ok(html.includes("<ep-app>"), "index.html must mount ep-app");
});

test("package is classified as a Signal K webapp", () => {
  const pkg = JSON.parse(
    readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  assert.ok(
    pkg.keywords?.includes("signalk-webapp"),
    "package.json needs the signalk-webapp keyword",
  );
  assert.strictEqual(
    typeof pkg.signalk?.displayName,
    "string",
    "webapp list display name comes from signalk.displayName",
  );
  assert.ok(
    existsSync(path.join(PUBLIC_DIR, pkg.signalk.appIcon)),
    "signalk.appIcon must point at an existing file under public/",
  );
});

test("components register custom elements", () => {
  // Browser-only APIs make real imports impossible under node; verify the
  // registration calls textually instead
  const expected = [
    ["ep-window-selector.js", "ep-window-selector"],
    ["ep-headline-figures.js", "ep-headline-figures"],
    ["ep-timeline-chart.js", "ep-timeline-chart"],
    ["ep-app.js", "ep-app"],
  ];
  for (const [file, element] of expected) {
    const source = readFileSync(path.join(PUBLIC_DIR, file), "utf8");
    assert.match(
      source,
      new RegExp(`customElements\\.define\\("${element}"`),
      `${file} must define <${element}>`,
    );
  }
});

test("chart fetches against the plugin API base used by ep-app", () => {
  const source = readFileSync(path.join(PUBLIC_DIR, "ep-app.js"), "utf8");
  assert.match(source, /\/plugins\/signalk-energy-predictor/);
  assert.match(source, /\/api\/summary/);
  assert.match(source, /\/api\/actuals/);
  assert.match(source, /\/api\/predictions/);
  assert.match(source, /\/api\/retro-predicted/);
});

test("app clears the chart and events list together on window change", () => {
  // Normalize CRLF so the test is robust on Windows checkouts where the
  // working tree may carry \r\n line endings despite .gitattributes.
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-app.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  // refresh() nulls both the chart and the actions (events) list up front so
  // the previous window's data doesn't linger while the new fetch is in flight
  assert.match(
    source,
    /this\.chartEl\.data = null;\n\s*this\.actionsEl\.data = null;/,
  );
});

test('events list header reads "Events" and interleaves advisories', () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-actions-list.js"),
    "utf8",
  );
  // The section is a general Events list now, not just deploy/stow
  assert.match(source, /header\.textContent = "Events"/);
  // Surplus ("surplus") and engine-run deficit ("engine_run") advisories are
  // rendered as a third event kind alongside detected/recommended
  assert.match(source, /kind: "advisory"/);
  assert.match(source, /advisoryBadge/);
  assert.match(source, /"surplus"/);
  assert.match(source, /"engine_run"/);
  // Surplus advisories render the elective-load suggestions the plugin
  // records alongside the terse notification message
  assert.match(source, /ev\.loads\?\.length/);
  assert.match(source, /Could run:/);
  // A surplus a newer forecast overtook is kept as history but marked
  // stale and shows when the forecast was made (forecastAt), so it
  // doesn't read as a live current opportunity.
  assert.match(source, /ep-action-stale/);
  assert.match(source, /ev\.forecastAt/);
  assert.match(source, /overtaken by a newer forecast/);
  // Event times render in the vessel's solar-local frame (shared formatter
  // from ep-solar-time.js), not the browser's civil timezone, so the
  // Events list agrees with the window selector and the chart.
  assert.match(source, /ep-solar-time\.js/);
  assert.match(source, /formatShortDateTime/);
  assert.match(source, /setSolarOffsetMinutes/);
});

test("chart overlays retro-predicted when no recorded cycle covers the window", () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-timeline-chart.js"),
    "utf8",
  );
  // Day model: falls back to retroPredicted points when no cycle exists
  assert.match(source, /retroPredicted\?\.points/);
  // Period model: aggregates retro-predicted hourly points to daily totals
  assert.match(source, /retroPredicted\.points/);
  // Per-day fallback (not all-or-nothing): the current month has recorded
  // cycles only from today forward, so its past days must still pull
  // predicted Wh from retro-predicted. Recorded days stay authoritative.
  assert.match(source, /if \(!predByDay\.has\(date\)\) \{/);
});

test("chart draws predicted lines dashed in week/month view", () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-timeline-chart.js"),
    "utf8",
  );
  // renderLines (used for the period view's soc/socPred/windKn lines) must
  // honor the predicted flag with a dashed stroke, matching renderDaySeries
  assert.match(
    source,
    /"stroke-dasharray": def\.predicted \? "5 4" : undefined/,
  );
});

test("chart stitches retro-predicted into the current day's past and anchors predicted SoC", () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-timeline-chart.js"),
    "utf8",
  );
  // Hours before the freshest cycle's first forecast are filled from
  // retro-predicted so the current day shows predicted yield across its
  // whole span, matching past days that rely on the backfill.
  assert.match(source, />= cycleStart/);
  assert.match(source, /cycle\.forecast\[0\]\.time/);
  // Predicted SoC line is anchored to the last actual SoC sample so the
  // predicted and actual lines connect at the now boundary (no gap).
  assert.match(source, /_predSoCPoints/);
  assert.match(source, /lastActual/);
});

test("window selector exposes Today and hash-based navigation", () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-window-selector.js"),
    "utf8",
  );
  // Today button
  assert.match(source, /today\(\)/);
  assert.match(source, /"Today"/);
  // Hash routing: reads and writes the URL hash, reacts to hashchange
  assert.match(source, /loadHash/);
  assert.match(source, /saveHash/);
  assert.match(source, /hashchange/);
});

test("window selector anchors the day on the vessel's solar-local midnight", () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-window-selector.js"),
    "utf8",
  );
  // solarMidnightToday builds a solar-local-midnight instant from the
  // vessel's longitude-derived offset (east positive), so the day window
  // is the sun-day the crew experiences — the same day the advisory dedup
  // keys on — not the browser's civil timezone.
  assert.match(source, /solarMidnightToday/);
  assert.match(source, /solarOffsetMinutes/);
  // setSolarOffsetMinutes lets the app feed /api/vessel's offset in after
  // load and re-emit so the window re-anchors.
  assert.match(source, /setSolarOffsetMinutes/);
  // Browser-timezone fallback when the vessel position is unknown
  assert.match(source, /offsetMinutes == null/);
});

test("window selector spans calendar weeks (Mon–Sun) and months (1st–last) in the solar-local frame", () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-window-selector.js"),
    "utf8",
  );
  // Week window starts on Monday; month window starts on the 1st and ends
  // on the 1st of the next month (handles variable month length and the
  // Dec→Jan roll). The fixed-span modeDays helper is gone (it produced
  // 30-day "months").
  assert.match(source, /MONDAY = 1/);
  assert.doesNotMatch(source, /modeDays/);
  assert.doesNotMatch(source, /30;/);
});

test("window selector solar-local midnight is the true solar midnight instant, not UTC midnight", async () => {
  // Exercises the actual helper logic via a controlled Date — the bug
  // this guards against: returning Date.UTC(y,m,d) (UTC midnight) instead
  // of Date.UTC(y,m,d) − offset·60·1000, which at UTC−10 makes the sun-day
  // start at 14:00 the previous civil day ("sometime in the afternoon").
  const src = readFileSync(
    path.join(PUBLIC_DIR, "ep-window-selector.js"),
    "utf8",
  );
  // The offset must be subtracted to reach true solar midnight.
  assert.match(
    src,
    /Date\.UTC\(y, m, d\)\s*-\s*offsetMinutes\s*\*\s*60\s*\*\s*1000/,
  );
  // Verify by constructing solar midnight for a known case. We can't call
  // the class (needs a browser), but we replicate the exact arithmetic the
  // module uses so a regression in the formula is caught.
  // At UTC−10 (offset −600), solar midnight of 2026-08-23 is 10:00 UTC.
  const off = -600;
  const got = new Date(Date.UTC(2026, 7, 23) - off * 60 * 1000);
  assert.strictEqual(got.toISOString(), "2026-08-23T10:00:00.000Z");
  // And the wrong (pre-fix) value is 00:00Z — which would be 14:00 local:
  const wrong = new Date(Date.UTC(2026, 7, 23));
  assert.notStrictEqual(got.getTime(), wrong.getTime());
  // Cross-check against the shared formatter's solarDayStart, which must
  // agree with the selector's midnight arithmetic (both use the same sign).
  const { solarDayStart } = await import(
    `file://${path.join(PUBLIC_DIR, "ep-solar-time.js")}`
  );
  assert.strictEqual(solarDayStart("2026-08-23", off), got.getTime());
});

test("chart renders axis labels, tooltips and day buckets in solar-local time", () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-timeline-chart.js"),
    "utf8",
  );
  // Uses the shared solar-local formatter so the chart agrees with the
  // window selector and the Events list (one offset, one formatter).
  assert.match(source, /ep-solar-time\.js/);
  assert.match(source, /formatHHMM/);
  assert.match(source, /formatDayMonth/);
  assert.match(source, /formatShortDateTime/);
  assert.match(source, /solarDayKey/);
  assert.match(source, /solarDayStart/);
  // The app pushes /api/vessel's offset in; the chart re-renders with it.
  assert.match(source, /setSolarOffsetMinutes/);
});

test("chart shows hydro actual and hydro predicted series", () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-timeline-chart.js"),
    "utf8",
  );
  // Day view predicted hydro line
  assert.match(source, /predHydro/);
  // Week/month view hydro actual + predicted bars
  assert.match(source, /hydroActual/);
  assert.match(source, /hydroPred/);
});

test("chart shows predicted house load from the forecast cycle", () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-timeline-chart.js"),
    "utf8",
  );
  // Day view: a Pred. house load series is declared next to the yield preds
  assert.match(source, /id: "predLoad"/);
  assert.match(source, /Pred\. house load/);
  // Mapped from the recorded cycle's hourly houseLoadWh forecast
  assert.match(source, /predLoad: hour\.houseLoadWh \?\? null/);
});

test("chart clips predicted SoC to now so the line is not drawn in the past", () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-timeline-chart.js"),
    "utf8",
  );
  // Day view: hourly predSoC points are dropped once they fall before now
  assert.match(source, /p\.predSoC != null && p\.t >= Date\.now\(\)/);
  // Week/month view: a day's predicted SoC is suppressed when the whole day
  // is in the past, so the line never retroactively fills recorded history
  assert.match(source, /localDayStart\(day\) \+ 24 \* 3600000 > Date\.now\(\)/);
  // Regression guard: the allDays.map((day) => ...) callback must not
  // reference the bare `b` variable (it was the cause of "Can't find
  // variable: b" when opening week/month, since the parameter is `day`).
  const periodBlock = source.match(
    /allDays\.map\(\(day\) => \{[\s\S]*?\n {6}\};\n {4}\}\);/,
  );
  assert.ok(periodBlock, "expected the allDays.map((day) => ...) block");
  assert.doesNotMatch(
    periodBlock[0],
    /\bb\.day\b/,
    "period builder must use the `day` parameter, not the undefined `b`",
  );
});

test("headline figures show hydro yield", () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-headline-figures.js"),
    "utf8",
  );
  assert.match(source, /Hydro yield/);
  assert.match(source, /yield\?\.hydro\?\.totalWh/);
});
