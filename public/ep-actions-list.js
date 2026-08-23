/**
 * Actions list: deploy/stow events below the chart, for the selected
 * window (day/week/month).
 *
 * Two kinds of entries, interleaved by time:
 *  - Detected ("At 08:00 FLINsail was deployed") — the device's detected
 *    state transitions, inferred from power output + conditions and carried
 *    forward across unknown gaps (so a wind generator stowed for repair
 *    stays "stowed" through calm periods). Sourced from /api/deploy-states.
 *  - Recommended ("At 16:00 Recommendation: stow FLINsail") — what the
 *    predictor advised, from recorded cycles' per-hour idealAction events
 *    (state changes only, shifted to sun boundaries at night), with
 *    consecutive same-action advisories collapsed.
 */

const API_BASE = "/plugins/signalk-energy-predictor";

/**
 * Friendly device name. The API doesn't carry display names per action, so
 * we use the id directly (configurable later if needed).
 * @param {string} id
 * @returns {string}
 */
function deviceLabel(id) {
  return id;
}

class EpActionsList extends HTMLElement {
  constructor() {
    super();
    /** @type {{detected: object[], recommendations: object[]}|null} */
    this._data = null;
  }

  /**
   * Assigning data re-renders the list.
   * @param {{detected: object[], recommendations: object[]}|null} value
   */
  set data(value) {
    this._data = value;
    if (this.isConnected) this.render();
  }

  get data() {
    return this._data;
  }

  connectedCallback() {
    this.render();
  }

  /**
   * Builds the interleaved event list from the API response.
   * @returns {Array<{time: number, kind: "detected"|"recommended", id: string, state: string, reason: string}>}
   */
  buildEvents() {
    if (!this._data) return [];
    const events = [];
    for (const d of this._data.detected || []) {
      events.push({
        time: new Date(d.time).getTime(),
        kind: "detected",
        id: d.id,
        state: d.state,
        reason: "",
      });
    }
    for (const r of this._data.recommendations || []) {
      events.push({
        time: r.time,
        kind: "recommended",
        id: r.id,
        state: r.action === "deploy" ? "deployed" : "stowed",
        reason: r.reason || "",
      });
    }
    return events.sort((a, b) => a.time - b.time);
  }

  render() {
    this.innerHTML = "";
    const events = this.buildEvents();
    if (events.length === 0) return;

    const header = document.createElement("h2");
    header.className = "ep-actions-header";
    header.textContent = "Deploy / stow events";
    this.appendChild(header);

    const list = document.createElement("ul");
    list.className = "ep-actions-list";
    for (const ev of events) {
      const li = document.createElement("li");
      li.className = `ep-action ep-action-${ev.kind}`;
      const time = new Date(ev.time);
      const timeStr = time.toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      });
      const badge = document.createElement("span");
      badge.className = "ep-action-badge";
      badge.textContent = ev.kind === "detected" ? "detected" : "recommend";
      const text = document.createElement("span");
      text.className = "ep-action-text";
      if (ev.kind === "detected") {
        const verb = ev.state === "deployed" ? "was deployed" : "was stowed";
        text.textContent = `At ${timeStr} ${deviceLabel(ev.id)} ${verb}`;
      } else {
        const verb = ev.state === "deployed" ? "deploy" : "stow";
        text.textContent = `At ${timeStr} Recommendation: ${verb} ${deviceLabel(ev.id)}`;
      }
      li.append(badge, text);
      if (ev.reason) {
        const reason = document.createElement("span");
        reason.className = "ep-action-reason";
        reason.textContent = ev.reason;
        li.append(reason);
      }
      list.appendChild(li);
    }
    this.appendChild(list);
  }
}

customElements.define("ep-actions-list", EpActionsList);

export { API_BASE, EpActionsList };
