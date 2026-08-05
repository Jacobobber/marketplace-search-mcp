import { parsePrice } from "../normalize.js";

// Craigslist serves a static, JS-free search page (`cl-static-search-result`
// list items) to plain fetches, so no browser is needed here. Post pages are
// static too. Regex parsing is deliberate: the markup is stable and this keeps
// the dependency list empty.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Major-metro Craigslist sites for nationwide coverage. Craigslist folds
// "nearby results" into each search, so ~35 metros covers most of the US.
export const CL_SITES = [
  "newyork", "losangeles", "chicago", "houston", "phoenix", "philadelphia",
  "sanantonio", "sandiego", "dallas", "austin", "sfbay", "seattle", "denver",
  "boston", "miami", "atlanta", "tampa", "orlando", "portland", "minneapolis",
  "detroit", "stlouis", "charlotte", "raleigh", "nashville", "kansascity",
  "lasvegas", "sacramento", "columbus", "indianapolis", "cleveland",
  "pittsburgh", "saltlakecity", "washingtondc", "neworleans", "oklahomacity",
];

// Convenience names for common Craigslist category codes. Any code Craigslist
// accepts works — pass the raw three-letter code (see the `cat=` parameter on
// any craigslist.org search URL) for categories not listed here.
export const CL_CATEGORIES = {
  all_for_sale: "sss",
  furniture: "fua",
  electronics: "ela",
  tools: "tla",
  appliances: "ppa",
  bikes: "bia",
  boats: "boo",
  cars_trucks: "cta",
  motorcycles: "mca",
  free: "zip",
};

export const DEFAULT_CATEGORY = "sss";

function decodeChars(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function decodeEntities(s) {
  return decodeChars(s).replace(/\s+/g, " ").trim();
}

// Post bodies are prose, so line breaks carry meaning — unlike the one-line
// fields above, don't collapse them away.
function htmlToText(html) {
  return decodeChars(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|section)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
  )
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, i, all) => line || all[i - 1])
    .join("\n")
    .trim();
}

/**
 * Parse listings out of a Craigslist static search-results page.
 *
 * @param {string} html raw HTML of a `/search/area/<site>` response
 * @param {string} site Craigslist site slug the HTML came from
 * @returns {Array<{title: string, price: number|null, location: string|null,
 *   url: string, searched_site: string}>}
 */
export function parseListings(html, site) {
  const listings = [];
  const liRe = /<li class="cl-static-search-result"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const block = m[1];
    const href = block.match(/<a href="([^"]+)"/)?.[1];
    const title = block.match(/<div class="title">([\s\S]*?)<\/div>/)?.[1];
    const price = block.match(/<div class="price">([\s\S]*?)<\/div>/)?.[1];
    const location = block.match(/<div class="location">([\s\S]*?)<\/div>/)?.[1];
    if (!href || !title) continue;
    listings.push({
      title: decodeEntities(title),
      price: price ? parsePrice(decodeEntities(price)) : null,
      location: location ? decodeEntities(location) : null,
      url: href,
      searched_site: site,
    });
  }
  return listings;
}

/**
 * Search one Craigslist site.
 *
 * @param {string} site site slug, e.g. "denver"
 * @param {object} opts
 * @param {string} [opts.category] category code ("sss") or a CL_CATEGORIES key
 * @param {string} [opts.query] search terms
 * @param {number} [opts.minPrice] server-side price floor
 * @param {number} [opts.maxPrice] server-side price ceiling
 * @param {boolean} [opts.titleOnly] match the query against titles only
 * @returns {Promise<Array<object>>} listings from that site
 */
export async function searchSite(site, { category, query, minPrice, maxPrice, titleOnly }) {
  const url = new URL(`https://www.craigslist.org/search/area/${site}`);
  url.searchParams.set("cat", CL_CATEGORIES[category] ?? category ?? DEFAULT_CATEGORY);
  if (query) url.searchParams.set("query", query);
  if (titleOnly) url.searchParams.set("srchType", "T");
  if (minPrice != null) url.searchParams.set("min_price", String(minPrice));
  if (maxPrice != null) url.searchParams.set("max_price", String(maxPrice));
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${site}: HTTP ${res.status}`);
  return parseListings(await res.text(), site);
}

/**
 * Fan out across Craigslist sites with bounded concurrency and dedupe
 * cross-posted listings by URL (Craigslist mixes "nearby" results into every
 * metro, so the same post surfaces in several searches).
 *
 * @param {object} opts
 * @param {string[]} [opts.sites] site slugs; defaults to CL_SITES
 * @param {string} [opts.category] category code or CL_CATEGORIES key
 * @param {string} [opts.query] search terms
 * @param {number} [opts.minPrice]
 * @param {number} [opts.maxPrice]
 * @param {boolean} [opts.titleOnly]
 * @param {number} [opts.maxResults] cap on returned listings, default 100
 * @returns {Promise<{total_found: number, returned: number, sites_searched: number,
 *   sites_failed: string[], listings: Array<object>}>}
 */
export async function searchCraigslist(opts) {
  const sites = opts.sites?.length ? opts.sites : CL_SITES;
  const concurrency = 8;
  const seen = new Set();
  const listings = [];
  const errors = [];

  for (let i = 0; i < sites.length; i += concurrency) {
    const chunk = sites.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map((site) => searchSite(site, opts))
    );
    results.forEach((r) => {
      if (r.status === "rejected") {
        errors.push(String(r.reason?.message ?? r.reason));
        return;
      }
      for (const l of r.value) {
        if (seen.has(l.url)) continue;
        seen.add(l.url);
        // minPrice/maxPrice are enforced by Craigslist, but $0 "contact me"
        // posts slip past the floor — keep them, callers can filter.
        listings.push(l);
      }
    });
  }

  listings.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  const maxResults = opts.maxResults ?? 100;
  return {
    total_found: listings.length,
    returned: Math.min(listings.length, maxResults),
    sites_searched: sites.length,
    sites_failed: errors,
    listings: listings.slice(0, maxResults),
  };
}

/**
 * Fetch a single Craigslist post page.
 *
 * @param {string} url full craigslist.org post URL
 * @returns {Promise<{title: string|null, price: number|null, body: string}>}
 */
export async function fetchCraigslistPost(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const html = await res.text();
  const title = html.match(/<span id="titletextonly">([\s\S]*?)<\/span>/)?.[1];
  const price = html.match(/<span class="price">([\s\S]*?)<\/span>/)?.[1];
  const section = html.match(/<section id="postingbody">([\s\S]*?)<\/section>/)?.[1] ?? "";
  // A print-only QR-code block is injected at the top of every post body.
  const body = htmlToText(
    section.replace(/<div class="print-information[\s\S]*?<\/div>\s*<\/div>/, "")
  );
  return {
    title: title ? decodeEntities(title) : null,
    price: price ? parsePrice(decodeEntities(price)) : null,
    body,
  };
}
