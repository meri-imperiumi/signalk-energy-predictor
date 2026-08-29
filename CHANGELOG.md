# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
