import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

// FB Marketplace works logged-out: search pages render listings behind a
// dismissable login modal, and item pages are fully public. No cookies,
// no account, no credentials needed. Both page types are client-rendered,
// so a real browser is required — a plain fetch returns an empty shell.

const CHROME_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // Windows
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA &&
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
].filter(Boolean);

export const FB_METROS = [
  "nyc", "la", "chicago", "dallas", "phoenix", "sanfrancisco",
  "seattle", "denver", "saltlakecity", "miami", "atlanta", "boston",
];

function chromePath() {
  const p = CHROME_PATHS.find((c) => existsSync(c));
  if (!p) {
    throw new Error(
      "Chrome or Chromium not found. Install Chrome, or set PUPPETEER_EXECUTABLE_PATH to the browser binary."
    );
  }
  return p;
}

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });
  }
  return browserPromise;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function newPage() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 900 });
  return page;
}

async function searchMetro(metro, query) {
  const page = await newPage();
  try {
    const url = `https://www.facebook.com/marketplace/${metro}/search/?query=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page
      .waitForSelector('a[href*="/marketplace/item/"]', { timeout: 12000 })
      .catch(() => {}); // zero results is a valid outcome
    await new Promise((r) => setTimeout(r, 1500));
    return await page.evaluate((m) => {
      return Array.from(
        document.querySelectorAll('a[href*="/marketplace/item/"]')
      ).map((a) => {
        const lines = a.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
        // Card lines: [price, (old price)?, (badge)?, title, location]. Badges
        // shift the title down a slot, so drop them before positional picking.
        const badge = /^(just listed|new listing|sponsored|free shipping.*)$/i;
        const prices = lines.filter((l) => /^(\$[\d,.]+|free)/i.test(l));
        const rest = lines.filter((l) => !prices.includes(l) && !badge.test(l));
        return {
          id: a.href.match(/item\/(\d+)/)?.[1] ?? null,
          price: prices[0] ?? null,
          title: rest[0] ?? null,
          location: rest[1] ?? null,
          url: `https://www.facebook.com/marketplace/item/${a.href.match(/item\/(\d+)/)?.[1]}/`,
          metro: m,
        };
      });
    }, metro);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Search Facebook Marketplace across several metros.
 * Each metro search covers roughly a 40-mile radius and FB repeats listings
 * across overlapping radii, so results are deduped by item id.
 *
 * @param {object} opts
 * @param {string} opts.query search terms
 * @param {string[]} [opts.metros] metro slugs; defaults to FB_METROS
 * @param {number} [opts.maxResults] cap on returned listings, default 100
 * @returns {Promise<{total_found: number, returned: number, metros_searched: number,
 *   metros_failed: string[], listings: Array<object>}>}
 */
export async function searchMarketplace({ query, metros, maxResults = 100 }) {
  const sites = metros?.length ? metros : FB_METROS;
  const concurrency = 3;
  const seen = new Set();
  const listings = [];
  const errors = [];

  for (let i = 0; i < sites.length; i += concurrency) {
    const chunk = sites.slice(i, i + concurrency);
    const results = await Promise.allSettled(chunk.map((m) => searchMetro(m, query)));
    results.forEach((r, j) => {
      if (r.status === "rejected") {
        errors.push(`${chunk[j]}: ${r.reason?.message ?? r.reason}`);
        return;
      }
      for (const l of r.value) {
        if (!l.id || seen.has(l.id)) continue; // FB cross-lists across metro radii
        seen.add(l.id);
        listings.push(l);
      }
    });
  }

  return {
    total_found: listings.length,
    returned: Math.min(listings.length, maxResults),
    metros_searched: sites.length,
    metros_failed: errors,
    listings: listings.slice(0, maxResults),
  };
}

// Item pages label the structured block differently per category ("Details"
// for most goods, "About this vehicle"/"About this home" for listing types
// with a spec table). Whichever heading appears first marks the start of the
// content worth keeping.
const DETAIL_ANCHORS = [
  /^Details$/m,
  /^About this[^\n]*$/m,
  /^Seller's description$/m,
  /^Description$/m,
];

/**
 * Fetch one Marketplace item page and extract its title, price, and detail text.
 *
 * @param {string|number} itemId item id, or any URL containing one
 * @returns {Promise<{title: string, price: string|null, detail: string}>}
 */
export async function getListing(itemId) {
  const id = String(itemId).match(/(\d{8,})/)?.[1];
  if (!id) {
    throw new Error(
      "Pass a Marketplace item id or item URL, e.g. 1234567890123456 or https://www.facebook.com/marketplace/item/1234567890123456/"
    );
  }
  const page = await newPage();
  try {
    await page.goto(`https://www.facebook.com/marketplace/item/${id}/`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page
      .waitForFunction(
        () =>
          /^(Details|About this[^\n]*|Seller's description|Description)$/m.test(
            document.body.innerText
          ),
        { timeout: 12000 }
      )
      .catch(() => {}); // some listings have no detail block at all
    await new Promise((r) => setTimeout(r, 1000));
    return await page.evaluate((anchorSources) => {
      const text = document.body.innerText;
      const title = document.title.replace(/ \| Facebook.*$/, "");
      // Price renders above the detail block; grab the first standalone $ line
      const price = text.match(/^\$[\d,]+(?:\n|$)/m)?.[0]?.trim() ?? null;
      const starts = anchorSources
        .map(([source, flags]) => text.search(new RegExp(source, flags)))
        .filter((i) => i >= 0);
      const start = starts.length ? Math.min(...starts) : -1;
      // Everything after the map caption / recommendations rail is boilerplate.
      const endMatch = text.match(/·\s*Location is approximate|\nToday's picks/);
      const end = endMatch ? text.indexOf(endMatch[0]) : -1;
      const detail =
        start >= 0
          ? text.slice(start, end > start ? end : start + 2500)
          : text.slice(0, 1500);
      return { title, price, detail: detail.trim() };
    }, DETAIL_ANCHORS.map((re) => [re.source, re.flags]));
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Close the shared browser. Call before exit or the process will hang.
 *
 * @returns {Promise<void>}
 */
export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    await b?.close().catch(() => {});
    browserPromise = null;
  }
}
