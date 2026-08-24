/**
 * Events list: deploy/stow events plus surplus/deficit notifications
 * below the chart, for the selected window (day/week/month).
 *
 * Three kinds of entries, interleaved by time:
 *  - Detected ("At 08:00 FLINsail was deployed") — the device's detected
 *    state transitions, inferred from power output + conditions and carried
 *    forward across unknown gaps (so a wind generator stowed for repair
 *    stays "stowed" through calm periods). Sourced from /api/deploy-states.
 *  - Recommended ("At 16:00 Recommendation: stow FLINsail") — what the
 *    predictor advised, from recorded cycles' per-hour idealAction events
 *    (state changes only, shifted to sun boundaries at night), with
 *    consecutive same-action advisories collapsed.
 *  - Advisory ("At 14:00 1.2 kWh surplus available 14:00-18:00") —
 *    surplus-energy and engine-run (deficit) notifications recorded per
 *    cycle, surfaced so the crew can see when the predictor flagged a
 *    surplus window or a needed engine run.
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

/**
 * Short badge label for an advisory type. Matches the
 * `AdvisoryType` values emitted by the plugin ("surplus" / "engine_run" /
 * "stow_soon").
 * @param {string} type
 * @returns {string}
 */
function advisoryBadge(type) {
  if (type === "surplus") return "surplus";
  if (type === "engine_run") return "deficit";
  if (type === "stow_soon") return "drag";
  return "advisory";
}

class EpActionsList extends HTMLElement {
  constructor() {
    super();
    /** @type {{detected: object[], recommendations: object[], advisories: object[]}|null} */
    this._data = null;
  }

  /**
   * Assigning data re-renders the list.
   * @param {{detected: object[], recommendations: object[], advisories: object[]}|null} value
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
   * @returns {Array<{time: number, kind: "detected"|"recommended"|"advisory", id: string, state: string, reason: string, type: string, message: string}>}
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
    for (const a of this._data.advisories || []) {
      events.push({
        time: new Date(a.time).getTime(),
        kind: "advisory",
        type: a.type,
        message: a.message || "",
        loads: a.loads || [],
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
    header.textContent = "Events";
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
      const text = document.createElement("span");
      text.className = "ep-action-text";
      if (ev.kind === "detected") {
        badge.textContent = "detected";
        const verb = ev.state === "deployed" ? "was deployed" : "was stowed";
        text.textContent = `At ${timeStr} ${deviceLabel(ev.id)} ${verb}`;
      } else if (ev.kind === "recommended") {
        badge.textContent = "recommend";
        const verb = ev.state === "deployed" ? "deploy" : "stow";
        text.textContent = `At ${timeStr} Recommendation: ${verb} ${deviceLabel(ev.id)}`;
      } else {
        // Advisory: surplus ("surplus") or engine-run deficit ("engine_run").
        // The message already carries the full human-readable text, so we
        // render it verbatim with a short kind badge.
        badge.textContent = advisoryBadge(ev.type);
        text.textContent = `At ${timeStr} ${ev.message}`;
        li.dataset.advisory = ev.type;
      }
      li.append(badge, text);
      if (ev.reason) {
        const reason = document.createElement("span");
        reason.className = "ep-action-reason";
        reason.textContent = ev.reason;
        li.append(reason);
      }
      // Surplus advisories carry structured elective-load suggestions the
      // UI can render in more detail than the terse notification message.
      if (ev.kind === "advisory" && ev.type === "surplus" && ev.loads?.length) {
        const loads = document.createElement("span");
        loads.className = "ep-action-reason";
        loads.textContent = `Could run: ${ev.loads
          .map((l) => `${l.name} (${l.watts}W) for ~${l.runHours}h`)
          .join(", ")}`;
        li.append(loads);
      }
      list.appendChild(li);
    }
    this.appendChild(list);
  }
}

customElements.define("ep-actions-list", EpActionsList);

export { API_BASE, EpActionsList };
