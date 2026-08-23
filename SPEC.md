# Technical Specification: Signal K Predictive Energy Management Plugin

**License:** EUPL-1.2
**Target Platform:** Node.js (Signal K Server Plugin)
**Primary Architecture:** Offline-first, incremental learning, multi-source weather fallback.

## 1. System Architecture Overview

The plugin operates as an offline-first daemon within the Signal K Node.js server. It consumes live vessel telemetry and weather forecasts to predict future energy generation and consumption.

The architecture is divided into four autonomous sub-systems:

1. **Ingestion FSM:** Fetches and normalizes weather data through a 4-tier hierarchy.
2. **Learning Engine:** A continuous Exponential Moving Average (EMA) matrix that profiles the vessel's actual solar/wind yield against theoretical maximums.
3. **Prediction Engine:** Computes a rolling 24-hour energy balance, integrating capacity deficits with forecasted yields.
4. **Advisory Publisher:** Broadcasts actionable deltas and notifications (e.g., FLINsail risk, mechanical stowage) to the Signal K tree.

---

## 2. Configuration Schema (`config.json`)

The plugin utilizes Signal K's native JSON Schema to generate the Admin UI.

```json
{
  "type": "object",
  "properties": {
    "battery": {
      "type": "object",
      "properties": {
        "capacityAh": { "type": "number", "default": 400 },
        "systemVoltage": { "type": "number", "default": 12 },
        "minSafeSoC": { "type": "number", "default": 0.20 },
        "socPath": { "type": "string", "default": "electrical.batteries.house.capacity.stateOfCharge" }
      }
    },
    "solarArrays": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "type": { "type": "string", "enum": ["fixed", "deployable"] },
          "powerPath": { "type": "string" },
          "controllerModePath": { "type": "string" },
          "gustLimitKnots": { "type": "number", "default": 20 },
          "hardwareEpochs": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "startDate": { "type": "string", "format": "date-time" },
                "endDate": { "type": "string", "format": "date-time" },
                "capacityWp": { "type": "number" }
              }
            }
          }
        }
      }
    },
    "mechanicalGenerators": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "type": { "type": "string", "enum": ["wind", "hydro"] },
          "powerPath": { "type": "string" },
          "manufacturerCurve": { "type": "string", "description": "JSON array of [speed, watts]" }
        }
      }
    }
  }
}

```

---

## 3. Data Ingestion & Fallback FSM

The plugin recalculates the forecast pipeline on a debounced schedule (e.g., every 15 minutes) or whenever a new weather file is detected. It uses a finite-state machine (FSM) to gracefully degrade during offline passages.

| Tier | Source | Trigger Condition | Parameter Used | Math |
| --- | --- | --- | --- | --- |
| **1. Direct NWP** | Open-Meteo REST API | `network.wan.status == 'online'` | `shortwave_radiation` | 1:1 pass-through ($W/m^2$) |
| **2. Signal K REST** | Signal K Weather API | Tier 1 fails / WAN offline | `cloudCover` (0.0 - 1.0) | Kasten-Czeplak attenuation |
| **3. Logbook Persistence** | `signalk-logbook` DB | No future data in SK API | Oktas (0 - 8) | Kasten-Czeplak attenuation |
| **4. Clear Sky Baseline** | `suncalc` geometry | No recent logbook entries | Solar Altitude | Theoretical Max Irradiance |

### The Synthetic Irradiance Function (Tier 2 & 3)

When forced to use cloud cover ($C \in [0, 1]$), the theoretical Global Horizontal Irradiance ($GHI$) is synthesized as:

$$GHI_{\text{clear}} = 1367 \cdot 0.75 \cdot \sin(\text{Altitude})$$

$$GHI_{\text{forecast}} = GHI_{\text{clear}} \cdot \left(1 - 0.75 \cdot C^{3.4}\right)$$

---

## 4. The Learning Engine (EMA & Matrices)

### 4.1 Data Sanitization Gate

Before updating the model, the telemetry tick must pass these booleans. If any are `true`, the tick is dropped:

* Any engine running: `propulsion.*.state == 'started'` or `propulsion.*.revolutions > 0` (per-instance, mirroring signalk-autostate's detection — state is preferred, revolutions covers engines without state instrumentation; multi-engine vessels scan all instances)
* `battery.soc >= 0.80`
* `ac.shorePower.connected == true`
* `controller.mode != 'bulk'` (If mode data is available)

The `controller.mode` gate is the ground-truth signal for bulk charging: the SoC threshold above is unreliable because a shunt SoC drifts, so absorption/float can begin at a reported SoC well below 0.80. Each solar array's mode is read from its configured `controllerModePath` (string enum: `bulk` / `absorption` / `float`) and recorded on every sample, so the same gate can be applied during offline backfill and evaluation. Ticks without a mode reading fall back to the other gates.

Apparent Wind Angle (`environment.wind.angleApparent`) is likewise recorded on every sample (radians) so the sailing bins — keyed on `Azimuth_Elevation_AWA` — can be validated against actuals offline.

### 4.2 Matrix Structure

The data is binned into two flat key-value maps (stored as JSON) to accommodate standard single-board computer memory constraints.

* **Anchored Matrix Key:** `Azimuth_Elevation` (e.g., `"-45_30"`)
* Azimuth: $15^\circ$ bins. Elevation: $10^\circ$ bins.


* **Sailing Matrix Key:** `Azimuth_Elevation_AWA` (e.g., `"-45_30_120"`)
* AWA (Apparent Wind Angle): $30^\circ$ bins.



### 4.3 Instantaneous Efficiency ($\eta$)

For each array configuration, the current tick efficiency is calculated. The theoretical power is the array's STC nameplate output under the measured Global Horizontal Irradiance (rated at the standard 1000 W/m²); GHI already encodes the sun elevation for a horizontal panel, so no separate `sin(Elevation)` factor is applied (a night gate drops ticks where the sun is below the horizon):

$$P_{\text{theoretical}} = \text{Capacity}_{Wp} \cdot \left( \frac{GHI_{\text{current}}}{1000} \right)$$

$$\eta_{\text{observed}} = \min\left(1.0, \max\left(0.0, \frac{P_{\text{actual}}}{P_{\text{theoretical}}}\right)\right)$$

The learned $\eta$ therefore absorbs all real-world derating relative to nameplate — panel temperature, non-optimal tilt, partial shading, soiling, and DC-conversion losses — which is the intended design.

### 4.4 Exponential Moving Average Update

The active bin is updated using a low-inertia smoothing factor ($\alpha = 0.05$):

$$\eta_{\text{new}} = \alpha \cdot \eta_{\text{observed}} + (1 - \alpha) \cdot \eta_{\text{existing}}$$

---

## 5. Prediction & Advisory Logic

The prediction engine runs a forward-looking loop ($t = 0$ to $t = +24\text{h}$) combining the forecasted GHI, the matching bin $\eta$, and a rolling average of house loads.

### 5.1 The FLINsail Risk Gate

When forecasting yield, the engine checks `environment.forecast.wind.speedGust`.

* If `max_gusts >= config.solarArrays[flinsail].gustLimitKnots`:
* `deployable` arrays are excluded from the 24h Watt-hour sum.
* A `notification` delta is queued advising stowage.



### 5.2 Time-to-Dump / Drag Reduction

1. Calculate Capacity Deficit ($E_{\text{deficit}} = (1.0 - \text{SoC}) \cdot \text{Capacity}_{Wh}$).
2. Sum predicted net energy hour-by-hour.
3. If the sum crosses $E_{\text{deficit}}$ while mechanical generators (wind/hydro) are active, and remaining solar forecast $\ge E_{\text{deficit\_remaining}}$, publish a stowage recommendation to reduce drag/wear.

### 5.3 Auxiliary Generator Advisory

If the rolling energy balance projects the SoC will drop below `config.battery.minSafeSoC` within 24 hours:

* Calculate necessary engine run time: `RunTime = Deficit / EngineExpectedWatts`.
* Publish advisory delta with optimal run window (targeting periods of lowest forecasted solar yield).

---

## 6. State Persistence & Recovery

The plugin maintains two types of learned state that **must persist across server restarts**:

### 6.1 Learned State Components

| Component | Description | Storage Format | Save Frequency |
| --- | --- | --- | --- |
| **Solar Efficiency Matrices** | Per-array EMA efficiency binned by sun position and sailing state | `solar-matrix-{id}.json` + `.matrices-manifest` | Every `learning.saveIntervalMinutes` (default: 15 min) + on plugin stop() |
| **Load Profile** | House load EMA binned by navigation state and sun phase | `load-profile.json` | Every `learning.saveIntervalMinutes` (default: 15 min) + on plugin stop() |

### 6.2 Persistence Guarantees

- Learned state is loaded from disk on plugin startup, restoring all previously learned efficiencies and load profiles
- State is saved to disk periodically (every `learning.saveIntervalMinutes`)
- On graceful plugin shutdown (via Signal K admin UI or server stop), state is saved before termination via the `stop()` method
- State files are written atomically using write-then-rename to prevent corruption
- The `.matrices-manifest` file tracks which matrix files exist, enabling recovery even if individual files are missing

### 6.3 Transient State (Not Persisted)

The following state is intentionally NOT persisted, as it repopulates from live Signal K deltas:

- `deltaState` - Current Signal K values from active subscriptions
- `solarPowerHistory` - 5-minute rolling average window for learning smoothing
- `windHistory` - 5-minute rolling window for wind generator detection
- Runtime flags (`hasPosition`, `learningRunning`, etc.)

**Note:** Abrupt process termination (e.g., SIGKILL, power loss, server crash) may lose learned data from the previous `saveIntervalMinutes` period. This is acceptable—the periodic saves limit data loss to a small window.

### 6.4 Recovery Behavior

On plugin restart:

1. Existing matrices are loaded from disk; missing arrays start with new matrices using `learning.defaultEfficiency`
2. Load profile bins are restored; missing bins fall back to rolling average until sufficient samples are collected
3. Transient state buffers start empty and accumulate from incoming deltas
4. No learned efficiency data is lost across restarts (within the `saveIntervalMinutes` window for unexpected shutdowns, zero loss for graceful shutdown)

---

## 7. Signal K API Contracts

### 6.1 Required Subscriptions (Inputs)

* `navigation.state` (`sailing`, `motoring`, `anchored`, `moored`)
* `navigation.headingTrue`, `navigation.speedThroughWater`
* `environment.wind.angleApparent`, `environment.wind.speedApparent`
* `environment.forecast.time.*.cloudCover` & `*.wind.speedGust`
* `electrical.solar.*.panelPower`, `electrical.batteries.*.capacity.stateOfCharge`
* `propulsion.*.state`, `propulsion.*.revolutions` (engine running detection for the learning gate)

### 6.2 Published Deltas (Outputs)

The plugin will emit the following standard Signal K updates:

* `electrical.energy.prediction.forecast.hourly`: JSON array of predicted Wh for the next 24 hours.
* `electrical.energy.prediction.timeToFull`: ISO-8601 timestamp or `null`.
* `electrical.energy.prediction.timeToEmpty`: ISO-8601 timestamp or `null`.
* `notifications.electrical.energy.deployAdvice`: Signal K Notification object (State: `normal`, `alert`, `warn`).

---

## 7. Backtesting CLI Facility

A separate Node.js executable (`bin/backtest.js`) is included to validate the learning model without polluting live matrices.

**Execution Flow:**

1. Queries the Signal K History API (InfluxDB wrapper) for a specified date range.
2. Fetches historical `cloudCover` or `shortwave_radiation` for those coordinates.
3. Replays the data sequentially through a sandboxed EMA matrix.
4. Outputs statistical validation:
* **Mean Absolute Error (MAE):** Total predicted Wh vs Actual Wh.
* **Array-Specific Drift:** Identifies if a specific matrix binning resolution (e.g., $15^\circ$ vs $30^\circ$ AWA) requires tuning.
