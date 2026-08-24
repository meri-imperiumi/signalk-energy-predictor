# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
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
