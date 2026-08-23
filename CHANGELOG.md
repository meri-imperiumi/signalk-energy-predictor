# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
