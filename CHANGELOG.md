# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Surplus and engine-run advisory notification messages now render their
  time windows in solar-local time derived from the vessel's longitude, so a
  server clocked in UTC still surfaces crew-local clock times. Emitted
  `surplus.from` / `surplus.to` deltas remain ISO 8601 UTC.

## [0.1.0] - 2026-08-23

### Added
- Initial version
