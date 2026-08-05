#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CL_CATEGORIES,
  CL_SITES,
  DEFAULT_CATEGORY,
  fetchCraigslistPost,
  isCraigslistUrl,
  searchCraigslist,
} from "./sources/craigslist.js";
import {
  closeBrowser,
  FB_METROS,
  getListing,
  searchMarketplace,
} from "./sources/facebook.js";
import {
  collapseDuplicates,
  matchesKeywords,
  normalizeListing,
  parsePrice,
} from "./normalize.js";

const DEEP_CHECK_CONCURRENCY = 4;
// Detail pages cost a page render (FB) or a round trip (CL); the cap keeps a
// broad query from turning into a multi-minute tool call.
const DEEP_CHECK_CAP = 40;
const DETAIL_EXCERPT_CHARS = 600;
// Bounds how many raw listings each source hands back before filtering.
const SOURCE_FETCH_CAP = 400;

const slug = z
  .string()
  .regex(/^[a-z0-9]+$/, 'must be a lowercase alphanumeric slug, e.g. "saltlakecity"');

/** Price ascending, unknown prices last. */
const byPrice = (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity);

/**
 * Fetch the detail text for one normalized listing.
 *
 * @param {{source: string, id: string|null, url: string|null}} listing
 * @returns {Promise<string>} full detail text, empty when the page had none
 */
async function fetchDetail(listing) {
  if (listing.source === "facebook") {
    const { detail } = await getListing(listing.id ?? listing.url);
    return detail ?? "";
  }
  const { body } = await fetchCraigslistPost(listing.url);
  return body ?? "";
}

/**
 * Attach detail text to the cheapest candidates, bounded by DEEP_CHECK_CAP.
 * Fetching stops early once `needed` candidates satisfy `matches` — the
 * candidates arrive price-sorted, so the survivors found first are also the
 * cheapest, and later pages would be paid for only to be truncated away.
 *
 * @param {Array<object>} candidates normalized listings, already sorted
 * @param {string[]} failures collects per-listing fetch errors
 * @param {{needed: number, matches: (l: object) => boolean}} stop early-stop rule
 * @returns {Promise<{checked: Array<object>, skipped: Array<object>}>}
 */
async function deepCheck(candidates, failures, { needed, matches }) {
  const targets = candidates.slice(0, DEEP_CHECK_CAP);
  const checked = [];
  let survivors = 0;
  let i = 0;

  for (; i < targets.length && survivors < needed; i += DEEP_CHECK_CONCURRENCY) {
    const chunk = targets.slice(i, i + DEEP_CHECK_CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(fetchDetail));
    results.forEach((r, j) => {
      if (r.status === "rejected") {
        failures.push(`${chunk[j].url}: ${r.reason?.message ?? r.reason}`);
        // A failed fetch still leaves a usable title-level result.
        checked.push({ ...chunk[j], detail: "" });
        return;
      }
      const withDetail = { ...chunk[j], detail: r.value };
      checked.push(withDetail);
      if (matches(withDetail)) survivors += 1;
    });
  }
  const skipped = [...targets.slice(i), ...candidates.slice(DEEP_CHECK_CAP)];
  return { checked, skipped };
}

const server = new McpServer({ name: "marketplace-search", version: "1.0.0" });

server.registerTool(
  "search_marketplace",
  {
    title: "Search Facebook Marketplace and Craigslist",
    description:
      "Search public classified listings across Facebook Marketplace and Craigslist for anything: " +
      "furniture, electronics, tools, bikes, boats, vehicles, whatever. Returns only public, " +
      "logged-out content — no account or API key is involved. " +
      "Facebook covers roughly a 40-mile radius per metro and repeats listings across overlapping " +
      "radii, so results are deduped by item id; Craigslist folds 'nearby' results into every metro " +
      "and is deduped by URL. " +
      "Titles are short and often omit details, so set deep_check=true when your keywords describe " +
      "something that lives in the description (condition, dimensions, model numbers) — it fetches " +
      `candidate pages cheapest-first at roughly 2-4 seconds each, capped at ${DEEP_CHECK_CAP} fetches, ` +
      "and stops as soon as max_results matches are found, so set max_results to what you actually " +
      "need. In the response: deep_checked = detail pages fetched, skipped_deep_checks = candidates " +
      "judged by title only, total_found = listings surviving all filters, duplicates_collapsed = " +
      "repost spam removed (same title+price+location posted repeatedly). " +
      "Typical flow: call list_sources to confirm slugs, run a narrow craigslist search with " +
      "title_only=true (fastest), widen metros or add facebook if results are thin, then deep_check " +
      "the shortlist. Start narrow: one or two metros beats a nationwide sweep.",
    inputSchema: {
      query: z
        .string()
        .describe("Search terms, e.g. 'standing desk', 'herman miller aeron', 'kayak'"),
      sources: z
        .enum(["facebook", "craigslist", "both"])
        .default("both")
        .describe("Which sites to search. 'craigslist' is much faster; 'facebook' needs a browser."),
      fb_metros: z
        .array(slug)
        .optional()
        .describe(`Facebook metro slugs (default: ${FB_METROS.join(", ")}).`),
      cl_sites: z
        .array(slug)
        .optional()
        .describe(`Craigslist site slugs (default: all ${CL_SITES.length} major metros).`),
      cl_category: z
        .string()
        .default(DEFAULT_CATEGORY)
        .describe(
          "Craigslist category code. Any code from a craigslist.org search URL's cat= parameter " +
            `works. Common: ${Object.entries(CL_CATEGORIES)
              .map(([name, code]) => `${code} (${name.replace(/_/g, " ")})`)
              .join(", ")}.`
        ),
      title_only: z
        .boolean()
        .default(false)
        .describe("Craigslist only: match the query against titles. Higher precision, fewer hits."),
      price_min: z
        .number()
        .int()
        .optional()
        .describe("Minimum price. Listings with no parsable price are dropped when a bound is set."),
      price_max: z.number().int().optional().describe("Maximum price."),
      require_keywords: z
        .array(z.string())
        .optional()
        .describe("Every term must appear (case-insensitive) in the listing text."),
      exclude_keywords: z
        .array(z.string())
        .optional()
        .describe("Drop listings containing any of these terms."),
      deep_check: z
        .boolean()
        .default(false)
        .describe(
          "Fetch each candidate's full detail page and match require_keywords against the " +
            "description instead of just the title. Slow — see the tool description."
        ),
      max_results: z.number().int().min(1).max(200).default(50),
    },
  },
  async ({
    query,
    sources,
    fb_metros,
    cl_sites,
    cl_category,
    title_only,
    price_min,
    price_max,
    require_keywords = [],
    exclude_keywords = [],
    deep_check,
    max_results,
  }) => {
    const failures = [];
    const jobs = [];

    if (sources === "craigslist" || sources === "both") {
      jobs.push(
        searchCraigslist({
          query,
          sites: cl_sites,
          category: cl_category,
          minPrice: price_min,
          maxPrice: price_max,
          titleOnly: title_only,
          maxResults: SOURCE_FETCH_CAP,
        }).then((r) => {
          failures.push(...r.sites_failed);
          return r.listings.map((l) => normalizeListing({ source: "craigslist", ...l }));
        })
      );
    }
    if (sources === "facebook" || sources === "both") {
      jobs.push(
        searchMarketplace({
          query,
          metros: fb_metros,
          maxResults: SOURCE_FETCH_CAP,
        }).then((r) => {
          failures.push(...r.metros_failed);
          return r.listings.map((l) => normalizeListing({ source: "facebook", ...l }));
        })
      );
    }

    const settled = await Promise.allSettled(jobs);
    const found = [];
    for (const r of settled) {
      if (r.status === "rejected") {
        failures.push(String(r.reason?.message ?? r.reason));
        continue;
      }
      found.push(...r.value);
    }

    // Craigslist enforces price bounds server-side but lets $0 "contact me"
    // posts through; Facebook has no price parameter at all.
    const hasPriceBound = price_min != null || price_max != null;
    const inPriceRange = (l) => {
      if (l.price == null) return !hasPriceBound;
      if (price_min != null && l.price < price_min) return false;
      if (price_max != null && l.price > price_max) return false;
      return true;
    };

    // With deep_check on, require_keywords are held back for the full text —
    // filtering them against titles first would make the fetch pointless.
    // Exclusions still run early: no reason to pay for a page we'll discard.
    const { listings: unique, collapsed } = collapseDuplicates(
      found
        .filter(inPriceRange)
        .filter((l) =>
          matchesKeywords(l.title ?? "", {
            require: deep_check ? [] : require_keywords,
            exclude: exclude_keywords,
          })
        )
    );
    const candidates = unique.sort(byPrice);

    let listings = candidates;
    let deepChecked = 0;
    let skippedDeepChecks = 0;

    if (deep_check && candidates.length) {
      const deepMatch = (l) =>
        matchesKeywords(`${l.title ?? ""}\n${l.detail}`, {
          require: require_keywords,
          exclude: exclude_keywords,
        });
      const { checked, skipped } = await deepCheck(candidates, failures, {
        needed: max_results,
        matches: deepMatch,
      });
      deepChecked = checked.length;
      skippedDeepChecks = skipped.length;
      listings = [
        ...checked.filter(deepMatch).map(({ detail, ...l }) => ({
          ...l,
          detail_excerpt: detail.slice(0, DETAIL_EXCERPT_CHARS),
        })),
        // Past the cap (or the early stop), the title is all we judge by.
        ...skipped.filter((l) =>
          matchesKeywords(l.title ?? "", {
            require: require_keywords,
            exclude: exclude_keywords,
          })
        ),
      ].sort(byPrice);
    }

    const result = {
      total_found: listings.length,
      returned: Math.min(listings.length, max_results),
      deep_checked: deepChecked,
      skipped_deep_checks: skippedDeepChecks,
      duplicates_collapsed: collapsed,
      sources_failed: failures,
      listings: listings.slice(0, max_results),
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "get_listing",
  {
    title: "Fetch one listing's full detail",
    description:
      "Fetch a single listing's title, price, and full description. Accepts a Craigslist post URL, " +
      "a Facebook Marketplace item URL, or a bare Facebook item id. Facebook detail pages take a " +
      "couple of seconds because they are client-rendered. Public content only.",
    inputSchema: {
      url_or_id: z
        .string()
        .describe(
          "craigslist.org post URL, facebook.com/marketplace/item/<id>/ URL, or a bare item id"
        ),
    },
  },
  async ({ url_or_id }) => {
    const ref = url_or_id.trim();
    let result;
    if (isCraigslistUrl(ref)) {
      const post = await fetchCraigslistPost(ref);
      result = {
        source: "craigslist",
        title: post.title,
        price: post.price,
        detail: post.body,
      };
    } else if (/marketplace\/item\/\d+/i.test(ref) || /^\d{8,}$/.test(ref)) {
      const item = await getListing(ref);
      result = {
        source: "facebook",
        title: item.title,
        price: parsePrice(item.price),
        detail: item.detail,
      };
    } else {
      throw new Error(
        `Unrecognized listing reference "${ref}". Pass a craigslist.org post URL, a ` +
          "facebook.com/marketplace/item/<id>/ URL, or a bare Facebook item id."
      );
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "list_sources",
  {
    title: "List searchable metros and categories",
    description:
      "List the default Facebook metro slugs, Craigslist site slugs, and common Craigslist " +
      "category codes accepted by search_marketplace. Use it to confirm a slug before searching.",
    inputSchema: {},
  },
  async () => {
    const result = {
      fb_metros: FB_METROS,
      cl_sites: CL_SITES,
      cl_categories: CL_CATEGORIES,
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await closeBrowser();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, shutdown);
}

const transport = new StdioServerTransport();
server.server.onclose = () => void shutdown();
// StdioServerTransport only subscribes to stdin 'data', so a client that
// disconnects by closing the pipe never triggers a transport close. An open
// Chrome keeps the event loop alive, so without watching for EOF here the
// process would sit there forever holding a browser nobody can reach.
process.stdin.on("end", () => void shutdown());
process.stdin.on("close", () => void shutdown());
await server.connect(transport);
