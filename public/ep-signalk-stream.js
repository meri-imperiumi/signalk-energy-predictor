/**
 * Signal K stream subscription for the Energy Predictor webapp.
 *
 * Connects to `/signalk/v1/stream` and subscribes to:
 *  - the plugin's live prediction path (`forecast.hourly`) — a new cycle
 *    fires a debounced refresh so the chart updates without a manual
 *    reload
 *  - `environment.mode` — day/night reactivity: the app applies
 *    `data-mode` to the document root so the whole UI shifts intensity
 *
 * Both subscriptions are throttled with `minPeriod` to avoid flooding
 * the client (the forecast only publishes on the 15-minute cycle and
 * the mode changes at most twice a day).
 *
 * Reconnects automatically on connection loss with exponential backoff
 * (1s → 2s → 4s → … capped at 30s, reset after a successful connect)
 * and reports connection state so the UI can show an offline indicator.
 */

/** Plugin path that publishes hourly forecast cycles */
const STREAM_PATH = "electrical.energy.prediction.forecast.hourly";

/** Day/night mode path for theme reactivity */
const MODE_PATH = "environment.mode";

/** Backoff bounds in ms */
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30000;

class SignalKStream {
  /**
   * @param {object} [callbacks]
   * @param {() => void} [callbacks.onCycle] - Called (debounced) when a
   *   new prediction cycle arrives
   * @param {(mode: string) => void} [callbacks.onMode] - Called when the
   *   Signal K environment.mode delta changes ("day" / "night")
   * @param {(online: boolean) => void} [callbacks.onStatus] - Called on
   *   connection state changes (true = open, false = lost)
   */
  constructor({ onCycle, onMode, onStatus } = {}) {
    /** @type {(() => void)|null} */
    this.onCycle = onCycle || null;
    /** @type {((mode: string) => void)|null} */
    this.onMode = onMode || null;
    /** @type {((online: boolean) => void)|null} */
    this.onStatus = onStatus || null;
    /** @type {WebSocket|null} */
    this.socket = null;
    /** @type {number|null} */
    this.reconnectTimer = null;
    /** @type {number} current backoff delay */
    this.reconnectDelay = RECONNECT_MIN;
    /** @type {number|null} */
    this.debounceTimer = null;
    /** @type {boolean} */
    this.closed = false;
  }

  connect() {
    if (this.closed) {
      return;
    }
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${proto}://${window.location.host}/signalk/v1/stream?subscribe=none`,
    );
    this.socket = socket;

    socket.addEventListener("open", () => {
      // Connection proven: reset the backoff and clear the offline state
      this.reconnectDelay = RECONNECT_MIN;
      this.onStatus?.(true);
      socket.send(
        JSON.stringify({
          context: "vessels.self",
          subscribe: [
            // Throttled: cycles land on the 15-minute prediction cadence,
            // but a burst of deltas per cycle is fine at 1s granularity
            { path: STREAM_PATH, minPeriod: 1000 },
            // The mode flips at most twice a day; 5s is plenty and keeps
            // the client quiet
            { path: MODE_PATH, minPeriod: 5000 },
          ],
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      for (const update of data.updates || []) {
        for (const value of update.values || []) {
          if (value.path === STREAM_PATH && Array.isArray(value.value)) {
            this.scheduleRefresh();
          } else if (
            value.path === MODE_PATH &&
            typeof value.value === "string" &&
            this.onMode
          ) {
            this.onMode(value.value);
          }
        }
      }
    });

    socket.addEventListener("close", () => {
      if (this.closed) {
        return;
      }
      this.onStatus?.(false);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  /**
   * A cycle publishes a burst of deltas; refresh once it settles.
   */
  scheduleRefresh() {
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onCycle?.();
    }, 2000);
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.socket?.close();
  }
}

export { SignalKStream, STREAM_PATH };
