// Pure helpers shared by the source modules and the MCP tools. No network,
// no side effects — every source produces its own listing shape, and these
// flatten them into one comparable record.

/**
 * Parse a marketplace price into whole dollars.
 * Accepts pre-parsed numbers, "$24,500", "$1,200 (obo)". Non-numeric strings
 * such as "Free" yield null so callers can distinguish "no price" from "$0".
 *
 * @param {string|number|null|undefined} str
 * @returns {number|null} whole-dollar amount, or null when no digits are present
 */
export function parsePrice(str) {
  if (str == null) return null;
  if (typeof str === "number") return Number.isFinite(str) ? Math.trunc(str) : null;
  const digits = String(str).replace(/[^0-9]/g, "");
  if (!digits) return null;
  const n = Number.parseInt(digits, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Flatten a raw source listing into the unified shape returned by the tools.
 * Craigslist supplies `searched_site` and an already-numeric price; Facebook
 * supplies `metro` and a price string like "$1,200" — both land in the same
 * fields here.
 *
 * @param {object} raw raw listing from a source module, including `source`
 * @param {"craigslist"|"facebook"} raw.source
 * @returns {{source: string, id: string|null, url: string|null, title: string|null,
 *   price: number|null, location: string|null, searched_in: string|null}}
 */
export function normalizeListing({ source, ...raw }) {
  return {
    source,
    // Craigslist has no numeric post id in static results; the trailing URL
    // slug segment is stable and unique, so it doubles as the id.
    id: raw.id ?? raw.url?.split("/").filter(Boolean).pop() ?? null,
    url: raw.url ?? null,
    title: raw.title ?? null,
    price: parsePrice(raw.price),
    location: raw.location ?? null,
    searched_in: raw.metro ?? raw.searched_site ?? raw.searched_in ?? null,
  };
}

/**
 * Case-insensitive keyword gate. Every `require` term must appear in the text
 * and no `exclude` term may appear. Empty lists always pass.
 *
 * @param {string} text text to test (title, or title + detail after a deep check)
 * @param {{require?: string[], exclude?: string[]}} [terms]
 * @returns {boolean}
 */
export function matchesKeywords(text, { require = [], exclude = [] } = {}) {
  const haystack = String(text ?? "").toLowerCase();
  const has = (kw) => haystack.includes(String(kw).toLowerCase());
  return require.every(has) && !exclude.some(has);
}
