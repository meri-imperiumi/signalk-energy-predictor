# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
