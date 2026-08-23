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
  for (const file of readdirSync(PUBLIC_DIR)) {
    // icon.png is for the server's webapp list, not the page itself
    if (file === "index.html" || file === "icon.png") continue;
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

test("chart overlays retro-predicted when no recorded cycle covers the window", () => {
  const source = readFileSync(
    path.join(PUBLIC_DIR, "ep-timeline-chart.js"),
    "utf8",
  );
  // Day model: falls back to retroPredicted points when no cycle exists
  assert.match(source, /retroPredicted\?\.points/);
  // Period model: aggregates retro-predicted hourly points to daily totals
  assert.match(source, /retroPredicted\.points/);
});
