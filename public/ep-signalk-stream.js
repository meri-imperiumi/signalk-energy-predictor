/**
 * Signal K stream subscription for the Energy Predictor webapp.
 *
 * Connects to `/signalk/v1/stream` and subscribes to the plugin's live
 * prediction paths. When a new prediction cycle is published
 * (`forecast.hourly` delta), fires a debounced refresh so the chart
 * updates without a manual reload.
 *
 * Reconnects automatically on connection loss.
 */

const STREAM_PATH = "electrical.energy.prediction.forecast.hourly";

class SignalKStream {
  /**
   * @param {() => void} onCycle - Called (debounced) when a new prediction
   *   cycle arrives
   */
  constructor(onCycle) {
    /** @type {(() => void)|null} */
    this.onCycle = onCycle;
    /** @type {WebSocket|null} */
    this.socket = null;
    /** @type {number|null} */
    this.reconnectTimer = null;
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
      socket.send(
        JSON.stringify({
          context: "vessels.self",
          subscribe: [{ path: STREAM_PATH }],
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
          }
        }
      }
    });

    socket.addEventListener("close", () => {
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
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
    }
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
    }
    this.socket?.close();
  }
}

export { SignalKStream, STREAM_PATH };
