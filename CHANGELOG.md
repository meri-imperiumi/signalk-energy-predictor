# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Configurable AC (inverter) power paths** (`acPowerPaths`):
  the AC consumption feeding the load profile's AC bins was read
  from a hardcoded `electrical.venus.acPower` path specific to one
  boat. The new top-level `acPowerPaths` setting takes any number
  of Signal K paths (summed per sample — multi-inverter boats can
  list them all), wired through the live subscription, the
  prediction engine's load-profile learning, and the history
  backfill replay. The default is the Venus plugin's standard
  `electrical.venus.vebusDcPower` (VE.Bus inverter DC draw);
  boats whose primary inverter is not on VE.Bus set their own
  path. Migration: configurations that relied on the old hardcoded
  path must add it to `acPowerPaths` explicitly.

### Fixed
- **Webapp now follows sun-day jumps at the date line** (`public/`):
  crossing the International Date Line (e.g. at ~173°W where the line
  bulges east) flips the longitude-derived solar-local offset by ~24h
  and the crew's calendar date jumps a day. The webapp used to miss
  that jump and render one day behind: `/api/vessel`'s offset was
  fetched only at load (a long-lived session kept the pre-crossing
  frame forever), and an offset change preserved the previously picked
  calendar date instead of re-anchoring the live window on the sun-day
  containing *now*. The offset is now re-fetched on every prediction
  cycle, and the window selector tracks the live sun-day (advancing at
  solar midnight, following date-line jumps) until the user navigates
  to a specific window, which stays pinned. The solar-midnight anchor
  arithmetic moved into `public/ep-solar-time.js` next to the formatters
  (one source of truth, testable under node).

## [0.10.0] - 2026-09-17

### Added
- **SQLite is now the recording store** (`plugin/storage.js`):
  cycle metadata plus one row per forecast hour (windowed reads never
  parse out-of-window forecast JSON), samples and wind-protection
  observations as JSON rows, keyset-paginated windowed reads that yield
  to the event loop, write-time normalization of deploy actions and
  spans, and SQL winner resolution (freshest prediction per hour) for
  the aggregated endpoints. Measured on production-scale data (30 days
  of 168h forecasts, the case that used to time out): week view 36 s →
  ~0.4 s with worst event-loop stall ~0.1 s (was multi-second).
- **Automatic NDJSON conversion** (`plugin/storage-migrate.js`): on
  first start with an existing `recordings/` directory, day files are
  imported in per-file transactions (tolerant of torn/unknown lines)
  and the directory is renamed to `recordings-ndjson/` as a
  manual-delete backup. Files are never imported twice: each filename
  is committed to a done-list in the same transaction as its rows, and
  re-runs are a no-op.

### Changed
- `plugin/recorder.js` (NDJSON day files) is removed; all consumers
  (API endpoints, restart-seed queries, history backfill, the
  backfill-advisories CLI) read and write the SQLite store. Sticky-field
  and deploy-state backfill rewrites are streamed row UPDATEs instead
  of whole-file rewrites. `bin/backfill-advisories.js` imports legacy
  NDJSON first when present and recomputes against the store.
- `/api/summary` and aggregated `/api/predictions` no longer load cycle
  records at all — they aggregate SQL winner rows (response shapes
  unchanged).
- `engines.node` is now `>=22.5.0`: the storage layer uses the
  built-in `node:sqlite` (unflagged from Node 23.4; on Node 22.5–22.x
  the server must run with `--experimental-sqlite`, which is the
  installer's business — the plugin fails fast with both remedies in
  the message when the builtin is unavailable).

## [0.9.0] - 2026-09-09

### Added
- **Hydrogenerator predictions can use the vessel's active polar.**
  When a polar tool publishes the Signal K `polars` resource and
  `polars.activePolar` (e.g. signalk-polar-management), the plugin
  fetches the table in-process each cycle and estimates future boat
  speed per forecast hour from the forecast wind (speed + direction
  against the current heading, with COG fallback) while sailing. This
  feeds the hourly hydro yield (no more constant current-speed snapshot
  for the whole window), the hourly deploy/stow actions, the
  good-output window, and a new `recommendedStateTime` for hydro
  verdicts ("wind builds to deploy-worthy speed at 15:00"). The
  published `polars.performanceFactor` is applied as a derating.
  Strictly optional and configuration-free: with no polar selected,
  no provider installed, or no wind direction in the forecast, every
  consumer falls back to the previous observed-speed behavior.
- **Engines can be detected and modeled via their alternator / DC-DC
  charger paths.** New optional per-engine config `alternatorPowerPath`
  and `alternatorModePath` (e.g.
  `electrical.chargers.alternator.power` /
  `.chargingMode`): an active charging mode — bulk, absorption, float —
  or positive output marks the engine as running regardless of
  propulsion instrumentation. The mode is checked first and is the
  truthful signal: a DC-DC charger tapers to a trickle in
  absorption/float while the engine still runs, so watts alone go blind
  late in the charge. When `alternatorWatts` is unset, the measured
  output also models the ideal track's alternator contribution. Both
  paths are subscribed when configured.

### Fixed
- **The 24h outlook no longer fabricates critical/deficit from a
  broken forecast.** 2026-08-31 incident: a degraded tier-1 fetch served
  24 h of ghi-less points that slipped past the ingestion degenerate
  guard, and with solar arrays configured the ideal track showed zero
  production — the outlook reported "critical" on a bank at 98% in
  absorption (projected drain to 11%), then "deficit" once the engine
  was running (its configured alternator didn't out-pace the load).
  The outlook now applies the same transient guard the combustion
  advisory already uses: when solar arrays are configured and the
  window's total solar is exactly zero with daylight in the window
  (i.e. not polar night), the forecast is data-degraded — no outlook is
  published rather than a fabricated trajectory. Solar-less boats
  (wind/hydro only) are exempt and keep full deficit reporting.
- **Motoring is no longer invisible on boats without propulsion
  instrumentation.** Engine-running detection relied solely on
  `propulsion.*` paths; a Victron-only setup has none, so `engineRunning`
  read null forever — with the engine charging hard, the 24h outlook
  kept showing "deficit" (2026-09 incident: critical while sailing in
  light air with the hydrogenerator stowed, then deficit after starting
  the engine, while the alternator bulk-charged the bank). The battery
  shunt now provides a fallback signature: Venus `dcPower` is
  `shunt + solar`, so `dcPower + measured wind/hydro = load − alternator`;
  a balance more than 150 W below zero means a combustion source is
  charging (a genset charger reads the same — deliberate, see below).
  Shore power defeats the signature. When the aggregate detector fires,
  engines whose per-instance detection is unknown (null) contribute
  their configured `alternatorWatts` to the ideal track. The same signal
  gates solar learning and the load profile (below).
- **Load learning no longer absorbs engine-running and shore-power
  samples into the rolling average.** `addSample` pushed every sample
  into the 3-hour rolling window before the engine/shore gates applied
  (only the binned EMAs were gated). While motoring, the shunt goes
  negative and the reconstruction clamps each sample to 0 W, dragging
  the fallback average toward zero — an optimistic load estimate. The
  rolling average now skips engine-running and shore-power samples
  exactly like the bins (and like surplus mode already did).
- **Deployable-generator detected states no longer flap on flickering
  output.** The live inference read the *instantaneous* power path, so a
  hydrogenerator producing 0↔20 W at its cut-in speed flipped its
  detected state between deployed and stowed on every 5-minute sample
  (78 flips over the 2026-08-30 – 09-05 passage, 49 on the worst day) —
  each mismatch against the recommendation nagging "deploy/stow
  hydrogenerator". The inference now reads the same 5-minute
  window-averaged power the solar learning uses (generator power paths
  are tracked in the history map), and the hydro 0 W-while-sailing
  stow test uses the sustained STW average.
- **Hydrogenerator deploy/stow verdicts no longer flap or fabricate.**
  The verdict compared the *instantaneous* speed through water against
  hard thresholds, so surfing over the stow limit or a lull below
  cut-in flipped the recommendation every cycle (the flip cooldown only
  holds notifications, not the published delta). Verdicts now use a
  10-minute window average (with a 1 kn hysteresis band on each
  threshold: a stow-for-fast holds until the sustained speed is 1 kn
  under the limit, a deploy holds through lulls 1 kn below cut-in).
  A missing paddlewheel no longer fabricates "sailing too slow (0.0kn)":
  speed falls back to SOG (labelled "SOG (no STW)" in the reason), and
  with no speed source at all the last verdict — or the detected state —
  is held with an honest "no boat speed data" reason.
- **Wind-generator verdicts no longer fabricate calm on windless
  forecast tiers.** `getMaxForecastWind` collapses an all-null forecast
  (tier 3/4 carry no wind) to 0 kn, so a down weather API stowed the
  wind generator with "forecast wind too low (0kn < 5kn)" while real
  wind blew. When the forecast tier carries no wind at all, the verdict
  basis is the measured nowcast (true → over-ground → apparent wind,
  observed gust), with reasons labelled "measured"; with neither
  forecast nor measurement the detected state is held ("no wind data")
  instead of inventing calm. A forecast that carries wind still governs.

## [0.8.2] - 2026-09-05

### Fixed
- **Week/month timeline views no longer time out on production-scale
  recordings.** Opening the week view on the boat served
  `Failed to load data: /api/predictions timed out after 30s`: the webapp
  fires all five window endpoints at once, and each independently
  re-read and re-parsed the same multi-megabyte day files — every line of
  every file was JSON-parsed even when the record type was discarded,
  and every cycle-serving endpoint read its window twice (default 24h
  lookback, then a full re-read with the real forecast horizon). Three
  changes: `readRecords` now skips lines of foreign record types before
  parsing them (day files are dominated by cycle records carrying the
  complete forecast array, so sample reads were parsing megabytes of
  cycle JSON just to discard it); the cycle lookback starts from the
  configured forecast horizon (`weather.forecastHours`, clamped to
  24–168h) so the adaptive re-read only happens when recorded cycles
  carry a longer horizon than configured; and concurrent identical
  window reads are shared in-flight between endpoints (once a read
  settles it is forgotten, so freshly appended records always show).
  `/api/summary` also loads its samples and cycles in parallel so it
  joins the shared reads instead of re-reading after they settle. On a
  benchmark with 30 days of realistic recordings (96 cycles/day,
  168h forecasts — 7.4 MiB/day files) the full week-view fan-out went
  from 36s (timeout) to ~6–10s; at the default 48h horizon from ~9s to
  ~4s. `hourlyPredictions` additionally parses dates once per cycle and
  per forecast point instead of per comparison (week windows run it over
  hundreds of thousands of points).

## [0.8.1] - 2026-09-05

### Fixed
- **Webapp API fetches now carry a client-side timeout, so a response
  that never lands can no longer stick the app on "Loading…" forever.**
  The previous fix made `/api/retro-predicted` cache-only (the response
  can no longer stall behind WAN round-trips), but the client still
  awaited all endpoints with no deadline: any request whose response
  never arrives (wedged connection, server event loop starved by a heavy
  cycle) left `refresh()`'s `Promise.all` pending indefinitely with the
  chart on "Loading…" and no error shown. Every fetch (window endpoints
  and `/api/vessel`) now uses `AbortSignal.timeout` (30 s / 10 s), and a
  timeout surfaces as a readable banner naming the endpoint that hung —
  which doubles as a diagnostic for the next occurrence. The stream-
  driven refresh keeps retrying on the next prediction cycle, so a
  transient hang recovers on its own.

## [0.8.0] - 2026-09-05

### Fixed
- **WPF no longer learns from measured wind posing as forecast, and strong
  protection claims now require proof.** At an anchorage visited without a
  real forecast (metered uplink: tier 1 skipped by design, no tier-2
  provider, on-disk restore past its staleness window) the ingestion FSM
  serves the stale-boundary hybrid, whose wind is the latest-known
  *measured* wind. The WPF learning tick compared that against the live
  measured wind — a self-comparison whose ratio is ~1 by construction —
  and cemented factor ≈ 1.0 ("WPF 100%", no protection) at exactly the
  places where shelter learning matters most. Learning now waits for a
  real forecast tier (live fetch or on-disk restore), and the history
  replay likewise refuses weather hours tagged tier 3/4 (their wind, if
  any, is a measured nowcast cached by the live fallback). On top of that,
  strong claims are evidence-gated: a single observation can never claim
  more than 90% shelter (the learnable ratio is floored at 0.1, so 100%
  protection is unreachable by construction — a near-zero measured wind
  is at least as likely a stuck anemometer as a wind-free anchorage), and
  a resolved factor below 0.5 (protection above 50%) is only applied once
  its bin has accumulated ten accepted samples — including via fallback
  donors, whose borrowed values are gated at the same threshold. Learned
  factors from stores persisted before the gate start unproven and
  re-prove themselves as fresh samples arrive.
- **The weather cache no longer silently drops wind.** Archive fetches
  return wind in knots while the cache persists only the m/s fields, so
  every cached archive day was written with null wind — starving the WPF
  history replay (and the retro overlay's wind-based numbers) of forecast
  wind for any day served from cache. The writer now normalizes both
  shapes; cached days surface on the track in knots with their tier, and
  a cached real-tier day whose hours carry no wind at all (corrupted by
  the old writer) is treated as a cache miss and re-fetched instead of
  permanently blocking the archive wind for that day.
- **The webapp no longer hangs on "Loading…" when the weather cache is
  cold.** `/api/retro-predicted` fetched Open-Meteo archive weather on the
  request path: with an unreachable uplink each uncached day burned the
  full retry backoff (~30 s/day), and with a blackholed uplink the fetch
  never settled at all — the endpoint never responded and the webapp (which
  awaits all endpoints together) sat on "Loading…" indefinitely. The
  response now serves cache-only weather and never touches the network;
  when the uplink is online and unmetered a background warm fills the cache
  for later loads (same "never buy bytes the user did not opt into" rule as
  the forecast tiers, work doc #19). Archive fetches also gained a 10 s
  per-attempt timeout, so a stalled (accepting connections but never
  answering) uplink can no longer hold a backfill or the warm on the
  transport's multi-minute timeout.

### Changed
- **`windProtection.correctedSpeed`/`correctedGust` now publish a measured
  nowcast when the active forecast tier carries no wind.** Tiers 3/4
  (logbook oktas, clear sky) have no wind data, which left the corrected
  wind paths null on forecast-degraded days (e.g. a whole offshore passage
  on a metered uplink) — the instrument panel lost wind entirely. The
  corrected paths now use the current forecast hour's wind when the tier
  has one, otherwise the current measured wind (true → over-ground →
  apparent; gust from the recent-max estimate), in both cases adjusted by
  the wind protection factor like a forecast would be (identity under way
  or with nothing learned). `forecastSpeed`/`forecastGust` stay
  forecast-only — null when the tier has no wind — so a real forecast
  remains distinguishable from a measured nowcast.
- **Weather and logbook tiers now talk to the Signal K server the plugin
  runs inside, in-process — no more localhost HTTP reads** (work doc #17
  follow-up). Tier 2 calls `app.weatherApi.getForecasts()` directly — the
  same object the server's `/signalk/v2/api/weather` REST routes wrap — so
  a GRIB weather provider registered by another plugin answers without
  HTTP, and tier 3 reads signalk-logbook's on-disk YAML day files from the
  server's plugin data directory (parsed with the new `yaml` dependency,
  the same parser the logbook writes with). The `weather.apiBaseUrl` and
  `weather.apiToken` options and the HTTP loopback machinery (base-URL
  resolution, auth headers, 401/403 surfacing) are removed: no ports to
  guess, no admin-level device tokens, no self-signed-TLS rejections.

### Fixed
- Same-server weather and logbook reads no longer fail against whatever
  else listens on `localhost:3000`. The removed HTTP reader took the
  listen port from `app.config.port`, which does not exist — the real port
  is `app.config.settings.port` — so on a server listening on port 80 every
  weather (GRIB) and logbook request 404'd against an unrelated service.
  Combined with the metered-uplink Open-Meteo skip (0.7.0), this left a
  6-day offshore passage with no working weather tier below the WAN
  download, and the FSM degraded to the Clear Sky fallback for the whole
  trip.

## [0.7.0] - 2026-08-28

### Changed
- **Metered uplinks no longer download their own forecast** (work doc #19).
  When `network.internet.state` is `metered` (volume-billed link: satellite,
  roaming LTE), the ingestion FSM skips the tier-1 Open-Meteo fetch and reads
  tier 2 — the same-server Signal K Weather provider — instead, reusing
  forecasts a weather provider plugin has already downloaded under its own
  data budget. If no provider answers on a metered link, the FSM uses the
  offline ladder (on-disk restore, stale hybrid, Clear Sky) rather than
  buying a WAN download. Unmetered `online` behavior is unchanged.

## [0.6.0] - 2026-08-27

### Changed
- **Webapp restyled to the Lille Ø tactical console theme.** The
  custom rounded-panel styling is replaced by the Signal K UI spec:
  flat geometry (zero border-radius), 2px corner brackets and faint
  themed borders on cards, uppercase tracked labels over massive
  monospace `tabular-nums` data values, hardware-style buttons and
  inputs (48px touch targets), and the events list rebuilt as a
  three-column pseudo-console (timestamp | message | bracketed status).
  The chart's series palette is extended beyond the spec's semantic
  colors (hydro blue, gust violet) with matching day/night variants so
  every series stays readable in both modes.

### Added
- **Day/night theme reactivity in the webapp.** The Signal K stream now
  also subscribes to `environment.mode` (throttled with `minPeriod`) and
  applies `data-mode` to the document root, shifting the whole UI
  between day (high visibility) and night (dimmed, rhodopsin-friendly)
  intensity without a reload.
- **Connection resilience and offline indicator.** The stream reconnects
  with exponential backoff (1s doubling to a 30s cap, reset after a
  successful connect) and the header shows a `[ LIVE ]` / `[ OFFLINE ]`
  status chip.
- Headline figures gained SI-prefix formatting for watts (kW) and
  megawatt-hours, and now surface the SoC range and mean prediction
  error as primary values.

## [0.5.0] - 2026-08-25

### Added
- **Surplus-mode gate for consumption learning (work doc #18).** Load
  profile samples taken while a surplus opportunity is active — inside the
  forecast surplus window, or with an instrumented elective load
  (`surplus.opportunisticLoads[].statePath`) running — are no longer
  learned as baseline consumption, and are also kept out of the
  rolling-average fallback. Elective-load draw (watermaker, ice maker)
  previously inflated the day bins, producing spurious deficit alerts and
  suppressing the very surplus advisories that suggested running the loads.
  Historical replay is unaffected (surplus state isn't reconstructed from
  history yet).
- **Authenticated reads of this server's own API (work doc #17).** The
  Signal K Weather API and signalk-logbook reads now authenticate when
  server security is enabled: new `weather.apiToken` option (device
  token from the Signal K Access Request flow, approved with **Admin**
  permission — readonly approval still gets 401 on plugin routes) is sent
  as both `Authorization: Bearer` and `JAUTHENTICATION` cookie, and a 401/403
  is surfaced via `app.error` with a fix hint instead of silently degrading
  to Clear Sky.

### Changed
- Same-server API base URL now defaults to
  `http://localhost:<app.config.port>` (same instance as the plugin) instead
  of the non-existent `system.host` Signal K path; overridable via the new
  `weather.apiBaseUrl` for reverse-proxy or remote-server setups.

### Fixed
- The ideal-track solar yield no longer counts deployable arrays
  (FLINsail) while the vessel is under way. `runPrediction`'s yield loop
  previously applied only the gust gate, ignoring the per-hour ideal states
  from `computeDeployableSolarStates` (which stow deployable solar under
  way), so sailing in sub-limit gusts inflated `idealSoC` — skewing the
  energy-outlook status optimistic and delaying or suppressing genset/engine
  run recommendations (#11, #15 update #4). Fixed arrays are unaffected;
  the detected track still models an actually-deployed array via its
  skip-stow-gate path.
- Forecast cache-hit logging no longer spams. `getForecast()` is called
  on the 15-minute prediction cycle *and* on every wind-protection
  learning run (throttled to 5 min), and each call logged when it served
  the cached forecast ("Using cached forecast…", "…serving stale
  in-memory forecast"). These are the expected, normal-case returns, so
  they now log once per fetch and stay quiet on repeat cache hits until
  the next actual fetch resets the flags.

## [0.4.0] - 2026-08-24

### Added
- **Combustion sources as deployable generators (#11).** Gensets and
  engine alternators are now first-class deployable energy sources alongside
  solar/wind/hydro, modeled as two reluctance tiers (genset below engine):
  - New `engines[]` config (each with a Signal K propulsion `id`, optional
    display `name`, and `alternatorWatts`; `alternatorWatts: 0` marks an
    electric drive that must never generate a run recommendation) replaces
    the old single `battery.engineAlternatorWatts`. Existing configs are
    normalized into a default `{ id: "main" }` engine at load time.
  - New `gensets[]` config (each with `id`, `outputWatts`, and optional
    `statePath`/`powerPath` for run detection).
  - New `combustion` tier settings: per-tier `sustainedHours`,
    `minRunMinutes`, `cooldownHours`, `socMargin`, and engine-only
    `nightHold` (engine recommendations are held for sunrise when the
    breach happens overnight; gensets run at night).
  - The engine tier escalates only when no genset is configured or the
    genset is already running; each tier recommends at most one source
    (largest output wins).
  - Combustion run recommendations publish through the existing deployment
    channel (`electrical.energy.prediction.deployment.<id>.*`) with a
    `runHours`/`windowStart`/`windowEnd` window, plus `engine_run` and
    `genset_run` notifications with "Run engine for 2.5h between …" phrasing
    and concurrent "load it well" elective-load suggestions sized to the
    source's output.
- **Renewables flip-cooldown hysteresis (#11).** Deploy/stow recommendations
  for renewables no longer re-nag on transient condition flips: each
  deployable's reluctance sets a cooldown band (low 1 h, medium 2 h, high 8
  h, per-device overridable via `flipCooldownHours`) during which an
  *opposite* recommendation is published as a delta but not notified. An
  actual over-limit condition (gusts already at the limit) always breaks
  through.
- A single glanceable energy-outlook delta for instrument panels:
  `electrical.energy.prediction.status` — one of
  `surplus` (bank fills to 100% and production is curtailed), `rising`
  (projected SoC ends >5 points above now), `stable` (within 5 points),
  `deficit` (ends >5 points below now), or `critical` (projected SoC
  dips below the chemistry threshold: 30% LiFePO4, 45% lead-acid — set via
  the new `battery.chemistry` config, default `lifepo4`). Critical is
  checked before surplus (a full-then-empty day still warns). Computed
  from the ideal track over the next 24 h by
  `PredictionEngine.getEnergyOutlook()`, published every cycle with
  metadata.
- `electrical.energy.prediction.net` (`Wh`) — estimated net energy
  balance over the next 24 h on the ideal track: positive when the
  battery is projected to rise (a surplus, even when it never reaches
  the 100% curtailment threshold), negative when projected to fall (a
  deficit). This is the bank trajectory; curtailment surplus is
  reported separately at `electrical.energy.prediction.surplus`. `0`
  when no prediction is available. Also exposed on
  `getEnergyOutlook()`'s return as `net24hWh`.
- `electrical.energy.prediction.weather.validTo` (`timestamp`) — when the
  current forecast coverage ends (end of the last covered hour), alongside
  the existing source/valid-hours paths.
- `electrical.energy.prediction.forecast.solar` (`Wh`) and
  `…forecast.consumption` (`Wh`) — estimated 24 h solar production
  (ideal track) and house consumption from the current prediction.
- `environment.wind.gust` (`m/s`) — derived gust (max of recent wind
  speed samples, the same recipe WPF learning uses; no dedicated gust
  sensor assumed) published every cycle at the standard Signal K path,
  null when there isn't enough wind data.

### Fixed
- Observed gusts now drive a stow recommendation. Previously only
  *forecast* gusts fed the deployable-solar (FLINsail) and wind-generator
  stow verdict, so a real gust already at the limit produced no
  notification when the forecast was calm. The live (observed) gust —
  max of recent `environment.wind.speed*` samples — now overrides the
  forecast for the current-hour stow verdict, and an over-limit
  observed gust is treated as an *actual* condition that breaks through
  the renewables flip-cooldown and always notifies ("Stow now, observed
  gusts 25kn ≥ limit 20kn").
- Bad-cycle protection: a degenerate weather forecast — hours with no
  weather signal at all (every hour GHI 0/null, wind 0/null, gust 0/null;
  observed in the wild as published 0 Wh solar / 0 kn wind / null
  corrected-wind cycles) — is now rejected at every layer instead of being
  published, recorded, and cached as a confident "success":
  - `parseOpenMeteoResponse` throws on payloads whose radiation, wind and
    gusts are all zero (complements the existing all-null check), so the
    FSM falls through to the next tier.
  - The tier-fetch loop treats a degenerate forecast as a failed tier
    (never caches it).
  - Cache restore ignores a poisoned (all-zero) on-disk cache and falls
    to the stale hybrid / Clear Sky.
  - The prediction cycle itself skips a degenerate forecast (defense in
    depth) and keeps the last good cycle's engine state, deltas and
    wind-protection values until a good forecast arrives.
  A real forecast always carries signal — daytime GHI, or wind in polar
  night — so the gate cannot reject legitimate weather.
- The wind-protection Signal K paths no longer double-apply the learned
  factor: `publishWindProtection` read its "forecast" from the engine's
  `lastForecast`, which already carries the wind-protection correction
  (factor + 10 m → device-height translation), and then corrected it a
  second time — so `correctedSpeed`/`correctedGust` published values like
  0.99 m/s where the correct once-corrected value was 3.3 m/s, and
  `forecastSpeed`/`forecastGust` published the corrected value instead of
  the raw forecast. The engine now also keeps the raw (pre-WPF) forecast
  (`lastRawForecast`) and the publisher reads that, so `forecastSpeed` is
  the raw forecast and `correctedSpeed` applies factor + height exactly
  once. The prediction engine's own gates were unaffected (they consume
  the corrected forecast once, by design).

### Changed
- Wind speeds are now carried in m/s (Signal K's standard unit) in the
  prediction engine's internals and in the wind-protection Signal K
  deltas. Knots survive only at the boundaries where humans or existing
  on-disk formats expect them: the plugin config schema (thresholds stay
  `*Knots` keys, converted at the config-read boundary; manufacturer
  power-curve speed axes are converted likewise), the recorder's on-disk
  sample/observation format, the HTTP API and webapp wind figures, and
  user-facing reason/notification strings. In detail:
  - Forecast ingestion (Open-Meteo, Signal K Weather API, logbook hybrid,
    weather cache) produces `windSpeedMs`/`gustSpeedMs`; the weather cache
    reads legacy `*Knots` entries with conversion.
  - `PredictionEngine` stores/reads m/s throughout (`windSpeedMs`,
    `gustSpeedMs`, `limitMs`, `currentGustMs`, …); deployment-recommendation
    objects carry `currentGustMs`/`currentSpeedMs`/`limitMs`.
  - The wind-protection delta paths dropped their unit suffix and now
    carry m/s with `units: "m/s"` metadata:
    `…windProtection.forecastSpeed`, `…forecastGust`, `…correctedSpeed`,
    `…correctedGust` (previously `…SpeedKnots`/`…GustKnots`).
  - `…windProtection.correctedSpeed`/`correctedGust` are now published
    even when no wind-protection factor applies (unlearned place, at sea):
    they carry the uncorrected forecast (identity passthrough) so consumers
    always see wind on these paths.
  - `getHourlyForecast()` (recorder/`forecast.hourly` blob/HTTP API)
    continues to render `windSpeedKnots`/`gustSpeedKnots` at its output
    boundary; the engine-internal fields feeding it are m/s.
  - The hourly prediction no longer rounds stored wind values to one
    decimal; rounding happens at display boundaries (knots rendering in
    `getHourlyForecast`) only.
- Signal K path names under `electrical.energy.prediction` no longer
  embed units; the unit lives in the path's metadata (`units: "Wh"`),
  matching the wind-protection paths above and Signal K convention.
  Published paths renamed (breaking for external consumers reading these
  by name):
  - `…surplusWh` → `…surplus` (the scalar; `…surplus.from` / `…surplus.to`
    are unchanged, so `surplus` is now a clean parent path).
  - `…deployment.<id>.missedYieldWh` → `…deployment.<id>.missedYield`.
  The new `…net` and `…forecast.solar` / `…forecast.consumption` paths
  (see Added below) are unitless by construction.

### Added
- Two new Signal K deltas expose the weather-forecast status the
  current prediction is built on, so the crew can see at a glance whether
  they're on a real forecast or a degraded fallback:
  - `electrical.energy.prediction.weather.source` — the forecast source
    name in use this cycle (e.g. "Open-Meteo", "Signal K Weather API",
    "Signal K Logbook", "Clear Sky Baseline"), or null when no forecast is
    available. Short text, not a tier number; the tier-2 string names the
    Signal K Weather API itself so the provider is identifiable.
  - `electrical.energy.prediction.weather.validHours` (`h`) — how many
    hours the current forecast actually covers (the prediction's
    effective horizon). Can be shorter than the configured horizon when
    a tier returns fewer hours (e.g. "valid 2h") or the full 48h on a
    fresh Open-Meteo fetch. 0 when no forecast is available.
  Published each prediction cycle via `publishAll` (data, not a
  notification), with `sendMeta` metadata for both paths.
- Signal K metadata for the surplus-energy paths
  `electrical.energy.prediction.surplus` (`Wh`), `surplus.from` and
  `surplus.to` (`timestamp`), emitted by `sendMeta` alongside the existing
  `timeToFull`/`timeToEmpty`/wind-protection/deployment meta. Consumers and
  instrument panels can now render the surplus value and window endpoints
  with correct units and labels.

### Changed
- The sunrise time in the solar-panel pointing recommendation
  ("Point starboard for morning, sun rises 16:54") now renders in the
  vessel's solar-local time, not the server's host timezone (which on a
  UTC-locked marine box showed UTC). The surplus and engine-run advisory
  windows were already solar-local; this closes the last server-side
  user-facing string that used the host clock. The solar-local offset is
  derived from the vessel's longitude, the same source used everywhere
  else. `solarOffsetMinutesFromLongitude`, `formatLocalHHMM` and
  `formatLocalMonthDay` moved from `advisory.js` to the shared `format.js`
  so the prediction engine (which builds the pointing reason) can use them
  without depending on the advisory layer; `advisory.js` re-exports them for
  existing callers.
- Surplus-energy estimates are now computed precisely from the ideal
  SoC track: surplus is the production that would not be stored into the
  battery because SoC is at 100% — i.e. `max(0, net − (1.0 − socStartOfHour)·
  capacityWh)` per hour, where `socStartOfHour` is read from the clamped
  prediction track. The previous headroom state machine over-counted by
  granting the absorption tail once at the full hour then treating the
  next hour as already full, and re-derived headroom with its own
  discharge/refill rules instead of reading the track's actual clamped
  SoC. The new figure matches the prediction's own SoC clamp loss exactly.
  The reported window now also starts at the first hour that actually
  curtails energy (when the bank reaches 100%), not at the `fullThreshold`
  (≥0.95) hour used only as the gating anchor.
- All user-facing times in the webapp now render in the vessel's
  solar-local frame, not the browser's civil timezone. A new shared
  formatter (`public/ep-solar-time.js`) shifts instants by the
  longitude-derived offset and formats with UTC getters, so the day/week/
  month window, the chart's axis labels and tooltip, and the Events list
  event times all agree — a surplus at solar 14:12 shows as 14:12
  everywhere. The offset is fetched once from `/api/vessel` and pushed to
  the selector, chart and Events list, so the pieces can't drift apart on
  a stale fetch. Falls back to the browser timezone when the vessel
  position is unknown.
- The webapp's day/week/month window now anchors on the vessel's true
  solar-local midnight (the UTC instant `Date.UTC(y,m,d) − offset·60·1000`),
  not UTC midnight of the solar-local date. At UTC−10 the sun-day now
  starts at 10:00 UTC (= 00:00 solar-local) rather than 00:00 UTC (= 14:00
  the previous civil day, which read as "the day starts in the
  afternoon"). Derived from the current longitude via the new `/api/vessel`
  endpoint, so "today" is the sun-day the crew experiences — the same day
  the surplus/deficit advisory dedup keys on.
- Surplus and deficit (engine-run) advisories in the Events list are now
  stamped with `forecastAt` (the cycle run time that produced them) and a
  `stale` flag. A historical advisory that a newer forecast overtook —
  the crew acted on the surplus and ran loads, the weather changed, … —
  is kept as a record but dimmed, struck through, and marked
  "overtaken by a newer forecast" rather than reading as a live current
  opportunity. Mirrors the recommendation-withdrawal logic: the newest
  cycle covering a sun-day wins; if it covers the day but has no advisory
  of that type, the prior advisory is marked stale rather than dropped.

### Added
- `GET /api/vessel` returns the vessel's solar-local UTC offset (minutes,
  east positive) from the current longitude, for the webapp to anchor its
  window and render event times in the crew's solar-local frame. Returns
  null when the position is unknown. Documented in the OpenAPI spec.

## [0.3.0] - 2026-08-23

### Changed
- The webapp's deploy/stow events section is now a general "Events" list
  that also shows surplus and deficit (engine-run) notifications recorded
  per prediction cycle, interleaved by time with detected and recommended
  deploy/stow transitions. Surplus events render the elective
  (opportunistic) loads the surplus could run — with run-time estimates
  and already-running loads skipped — going beyond the terse notification
  text. Recorded cycles now carry an `advisories` array, surfaced via
  `/api/deploy-states` as `advisories`.
- The engine-run (deficit) advisory now reports the run time needed to
  keep the battery bank above the minimum safe floor and recover — not
  the time to charge to 100% (the old `getDeficit`-based math produced a
  full-charge duration, e.g. 24h for a half-empty bank, which is neither
  what the crew needs nor actionable). A transient guard now rejects
  degenerate cycles with no solar at all (the signature of a shunt-
  synchronize / empty-weather glitch where the SoC reading falls back to
  0.5 and the weather track comes back empty), and the run time is
  capped to the forecast horizon, so a single bad cycle can no longer
  manufacture a multi-day "run the engine" nudge.

### Added
- `bin/backfill-advisories.js` CLI recomputes the surplus/engine-run/
  stowage advisories for recorded cycle records across a date range and
  writes them back into the JSONL day-files in place. This retroactively
  populates the `advisories` field on old cycles (so the webapp Events
  list shows surplus/deficit history for verification) and overwrites
  any transient advisory a glitchy cycle may have recorded — the
  corrected logic now yields no engine-run advisory for those cycles.

## [0.2.0] - 2026-08-23

### Changed
- The surplus-energy notification no longer lists per-load consumption
  suggestions (e.g. "Watermaker (150W) for ~8h"); it now just reports
  when the surplus window happens and how much energy is available
  (plus the sustained wattage). The opportunistic-loads configuration and
  the `AdvisoryPublisher.isLoadRunning` helper are retained for a richer
  suggestion surface in the webapp.
- Uplink status for forecast fetch cadence now reads the Signal K
  `network.internet.state` path (provided by the required
  `signalk-internet` plugin) instead of the Starlink-specific
  `network.providers.starlink.status` and LTE `networking.lte.connectionText`
  paths. `network.internet.state` values `online` and `metered` both count
  as internet available for fetching.
- Surplus and engine-run advisory notification messages now render their
  time windows in solar-local time derived from the vessel's longitude, so a
  server clocked in UTC still surfaces crew-local clock times. Emitted
  `surplus.from` / `surplus.to` deltas remain ISO 8601 UTC.

## [0.1.0] - 2026-08-23

### Added
- Initial version
