# Signal K Energy Predictor

This plugin predicts your boat’s energy production and helps you manage it. It combines weather forecasts with models learned from your vessel’s actual generation history to predict output from solar panels, wind generators, and hydrogenerators. The models account for factors such as sun position, vessel heading, rig and sail shading, and wind protection at anchor.

Weather forecasts can come from online insolation services, local GRIB files, or other Signal K Weather API providers. The plugin is designed to work offline-first, degrading gracefully from high-resolution online forecasts to low-bandwidth GRIBs or even manual cloud-cover observations. It also accounts for energy from alternators and gensets when predicting battery state.

In addition to forecasting, the plugin tries to identify and notify user of significant events. It can detect an approaching energy surplus or deficit, predict when the battery will reach float, and alert you when conditions require deployable equipment to be stowed, such as taking down a FLINsail before a gale.

![Analysis for a sailing day](https://github.com/meri-imperiumi/signalk-energy-predictor/raw/main/doc/webapp-day.png)
![Predictions for the next day](https://github.com/meri-imperiumi/signalk-energy-predictor/raw/main/doc/webapp-future.png)

## Features

* Learning model for solar panel output that takes rig shading, sails, etc into account
* Learning model for wind protection in anchorages (for stowing deployables or predicting wind generator output)
* Backfilling support to import historical data for learning and backtesting purposes
* Support for deployable renewables (for example FLINsail or a rigging-suspended wind generator)
* Notifications for actionable items ("take down FLINsail, gusts over 20kn overnight")
* Energy surplus detection for estimating when battery will be full and panels going to float
* Energy deficit detection with tiered run recommendations — a genset (if configured) is suggested before the propulsion engine, with sustained-violation thresholds, minimum-run batching, cooldowns, and an overnight hold for the engine so sunrise can recover the bank
* Data sanitization: pauses the learning model when the engine is running or solar chargers are in float/absorption, preventing skewed efficiency data
* Automatic forecast download when Starlink goes online

## Status

At an early stage, but has been backtested against several months of real-world data on [Lille Ø](https://lille-oe.de/) cruising the Southern Pacific.

## Configuration

Configure via Signal K Admin UI under the "Energy Predictor" plugin section:

### Signal K Weather Sources

The plugin always talks to the Signal K server it runs inside: tier 2 calls
the server's Weather API (`app.weatherApi`) **in-process** — answering any
registered weather provider such as a local GRIB download — and tier 3 reads
`signalk-logbook` entries directly from the server's plugin data directory.
No HTTP, ports, or access tokens are involved; there is nothing to
configure for these tiers.

### Battery Configuration

- **Capacity (Ah)**: House battery capacity
- **System Voltage (V)**: 12, 24, or 48V
- **Min Safe SoC**: Minimum safe state of charge (0-1)
- **SoC Path**: Signal K path for battery SoC reading
- **Chemistry**: Battery chemistry (`lifepo4` or `lead-acid`) — sets the critical-SoC threshold for the energy-outlook status (30% LiFePO4, 45% lead-acid)

> The engine alternator is no longer configured here. See **Engines** below — each propulsion engine's alternator output is configured per engine.

### Solar Arrays

Add each solar array:

- **ID**: Unique identifier (e.g., "cabin-roof", "flinsail")
- **Name**: Display name for advisories
- **Type**: Fixed or deployable
- **Power Path**: Signal K path for power output (watts)
- **Controller Mode Path** (optional): For charge controller sanitization
- **Gust Limit** (deployable): Wind gust threshold for stowage (knots)
- **Capacity (Wp)**: Peak wattage
- **Hardware Epochs**: Historical capacity changes (optional)

### Mechanical Generators

Add wind or hydro generators:

- **ID**: Unique identifier
- **Name**: Display name for advisories
- **Type**: Wind or hydro
- **Deployable**: Can be deployed/retracted (hydrogenerators typically deployable, wind generators deployable at anchor)
- **Max Wind Speed**: Stow above this (wind generators only)
- **Min/Max Speed**: Operating speed range (hydro generators only)
- **Power Path**: Signal K path for power output (watts)
- **Manufacturer Curve**: Power curve as "speed,watts" pairs
- **Reluctance**: How willing the crew is to deploy/stow this source — Low (even an hour of output), Medium (a couple hours), High (most of a day). Leave blank for the type default (hydro Low, wind High)
- **Flip cooldown (hours)**: How long after a deploy/stow recommendation the opposite recommendation is held (published as a delta but not re-notified) — the hysteresis band that stops a marginal wind generator cycling on every lull. Leave blank for the reluctance default (Low 1h, Medium 2h, High 8h)

#### Power Curve Format

The `manufacturerCurve` is comma-separated **pairs of speed (knots) and power (watts)**. Below is the power curve for a **Superwind 350** (350W rated marine wind generator):

```jsonc
"manufacturerCurve": "5,5,10,15,15,55,20,140,25,250,28,350,30,300"
```

Breaking down the Superwind 350 curve above:
- `5,5` = 5 knots → 5 watts (cut-in)
- `10,15` = 10 knots → 15 watts
- `15,55` = 15 knots → 55 watts
- `20,140` = 20 knots → 140 watts
- `25,250` = 25 knots → 250 watts
- `28,350` = 28 knots → 350 watts (rated power)
- `30,300` = 30 knots → 300 watts (electronic brake derates above rated wind)

The parser automatically sorts these by speed, so you can list them in any order.

### Engines

Add propulsion engines that charge the house bank via an alternator. The engine is treated as a high-reluctance deployable generator: recommended only when a sustained deficit leaves no renewable recovery path, and held overnight when the breach can wait for sunrise.

- **ID**: Signal K propulsion instance name — use whatever your vessel has (`main`, `port`, `starboard`, …)
- **Name**: Display name for advisories (optional)
- **Alternator (W)**: Expected alternator output. Set to **0** for an electric drive (it consumes energy and must never generate a run recommendation)

Monohulls usually have one engine; catamarans often have `port` + `starboard`. The engine tier recommends at most one engine per cycle (the largest alternator).

> **Legacy configs**: an existing `battery.engineAlternatorWatts` value is normalized into a default `{ id: "main" }` engine when no `engines` array is configured, so old installs keep working.

### Gensets

Add dedicated generators (diesel/petrol gensets, fuel cells). Gensets are a lower-reluctance tier than the engine: a genset, if configured, is recommended *before* the propulsion engine, and the engine escalates only when no genset is configured or the genset is already running.

- **ID**: Unique identifier
- **Name**: Display name for advisories (optional)
- **Output (W)**: Rated electrical output
- **State Path** (optional): Signal K path for run-state detection (e.g. `electrical.generators.genset1.state`)
- **Power Path** (optional): Signal K path for power output (watts) — used to confirm the genset is actually producing

The genset tier recommends at most one genset per cycle (the largest output).

### Combustion Run Discipline

Engines and gensets share a set of run-discipline settings that prevent short, hard cycles and respect crew rest:

- **Sustained hours**: How long the SoC must be projected below the floor before a run is recommended (genset 2h, engine 3h) — a 20-minute dip doesn't justify firing the engine
- **Minimum run (minutes)**: Shortest run worth doing (genset 45min, engine 60min) — shorter batches are held until there's enough deficit to run productively
- **Cooldown (hours)**: Minimum gap between recommended runs (genset 2h, engine 6h)
- **SoC margin**: Charge target above the floor (genset 5%, engine 10%) — a run batch tops the bank up past the floor, not to 100%
- **Night hold** (engine only): when the SoC-floor breach is projected to happen after sunrise, hold the engine recommendation for daylight so solar can recover the bank instead. Gensets run at night.

Combustion run recommendations publish through the same deployment channel as renewables (`electrical.energy.prediction.deployment.<id>.*`) with a `runHours`/`windowStart`/`windowEnd` run window, plus `engine_run` and `genset_run` notifications ("Run engine for 2.5h between 14:00–16:30 to avoid low battery") and concurrent **"load it well"** elective-load suggestions (watermaker, water heater, …) sized to the source's output — engines and gensets dislike running unloaded.

## Backfilling

If you're using a Signal K History API provider like InfluxDB, you can backfill the learning model with your past data. Once you have configured this plugin, run a command like:

```bash
node bin/backtest.js --populate --fresh \
     --from=2026-06-01 --to=2026-08-22 \
     --base-url=http://localhost:3000 \
     --config=~/.signalk/plugin-config-data/signalk-energy-predictor.json \
     --data-dir=~/.signalk/plugin-config-data/signalk-energy-predictor
```

This will populate the data window into the learning models. You can then explore the backfilled data using the plugin's web app.

## License

EUPL-1.2

## Support the development

- Ethereum: `0xFC872bA86812B2bbe90c38cfD2553F7865d04094`
- Liberapay: https://liberapay.com/bergie/
- ko-fi: https://ko-fi.com/bergius
