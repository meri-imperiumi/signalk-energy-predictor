/**
 * Formatting helpers for human-readable values in advisories and status.
 *
 * @file format.js
 */

/**
 * Formats an energy value in watt-hours for display.
 * Whole watt-hours below 1 kWh, one-decimal kWh at and above.
 *
 * @param {number} wh - Energy in watt-hours
 * @returns {string} e.g. "850Wh", "3.5kWh"
 */
function formatWh(wh) {
  if (wh >= 1000) {
    return `${(wh / 1000).toFixed(1)}kWh`;
  }
  return `${Math.round(wh)}Wh`;
}

module.exports = {
  formatWh,
};
