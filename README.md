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
* Energy deficit detection for when the boat might need to run the engine or a genset
* Data sanitization: pauses the learning model when the engine is running or solar chargers are in float/absorption, preventing skewed efficiency data
* Automatic forecast download when Starlink goes online

## Status

At an early stage, but has been backtested against several months of real-world data on [Lille Ø](https://lille-oe.de/) cruising the Southern Pacific.

## Configuration

Configure via Signal K Admin UI under the "Energy Predictor" plugin section:

### Battery Configuration

- **Capacity (Ah)**: House battery capacity
- **System Voltage (V)**: 12, 24, or 48V
- **Min Safe SoC**: Minimum safe state of charge (0-1)
- **SoC Path**: Signal K path for battery SoC reading
- **Engine Alternator (W)**: Expected alternator output for run time calculations

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
