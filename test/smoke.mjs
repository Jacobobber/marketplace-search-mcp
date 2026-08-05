#!/usr/bin/env node
// Smoke tests for marketplace-search-mcp. Run: node test/smoke.mjs
//
// Section 1 is offline and deterministic: pure helpers and HTML parsing against
// a canned fixture. Any failure here is a real regression.
//
// Section 2 hits the live sites. Listings come and go, so zero results is a
// PASS — these checks fail only when something throws, which is what catches
// markup drift, dead selectors, and a missing browser.

import assert from "node:assert/strict";
import { parsePrice, matchesKeywords } from "../src/normalize.js";
import {
  categoryCode,
  fetchCraigslistPost,
  isCraigslistUrl,
  parseListings,
  searchCraigslist,
} from "../src/sources/craigslist.js";
import {
  searchMarketplace,
  getListing,
  closeBrowser,
} from "../src/sources/facebook.js";

// Trimmed from a real https://www.craigslist.org/search/area/sfbay?cat=fua
// response. Four result blocks covering: price + location, a thousands
// separator, HTML entities, a post with no price div, and a malformed block
// with no anchor that must be skipped.
const CRAIGSLIST_HTML = `
<ul class="cl-static-search-results">
  <li class="cl-static-search-result" title="Dresser with mirror and nightstand">
    <a href="https://sfbay.craigslist.org/eby/fuo/d/san-pablo-dresser/0001.html">
      <div class="title">Dresser with mirror and nightstand</div>
      <div class="details">
        <div class="price">$40</div>
        <div class="location">
            richmond / point / annex
        </div>
      </div>
    </a>
  </li>
  <li class="cl-static-search-result" title="Herman Miller Aeron chair">
    <a href="https://sfbay.craigslist.org/sfc/fuo/d/san-francisco-aeron/0002.html">
      <div class="title">Herman Miller Aeron chair &amp; ottoman</div>
      <div class="details">
        <div class="price">$1,250</div>
        <div class="location">
            inner sunset
        </div>
      </div>
    </a>
  </li>
  <li class="cl-static-search-result" title="Solid oak dresser">
    <a href="https://sfbay.craigslist.org/nby/zip/d/novato-oak-dresser/0003.html">
      <div class="title">Solid oak &quot;mid-century&quot; dresser &#39;70s</div>
      <div class="details">
        <div class="location">
            novato
        </div>
      </div>
    </a>
  </li>
  <li class="cl-static-search-result" title="Broken block">
    <div class="title">No anchor here, must be skipped</div>
  </li>
</ul>
`;

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${String(err.message).split("\n")[0]}`);
    failed++;
  }
}

async function asyncCheck(name, fn) {
  try {
    const note = await fn();
    console.log(`PASS  ${name}${note ? ` — ${note}` : ""}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${String(err.message).split("\n")[0]}`);
    failed++;
  }
}

function skip(name, reason) {
  console.log(`SKIP  ${name} — ${reason}`);
  skipped++;
}

console.log("--- unit checks (no network) ---");

check('parsePrice("$24,500") strips punctuation to whole dollars', () => {
  assert.equal(parsePrice("$24,500"), 24500);
});

check('parsePrice("Free") is null, not 0', () => {
  assert.equal(parsePrice("Free"), null);
});

check('parsePrice("$1,234") handles a single thousands separator', () => {
  assert.equal(parsePrice("$1,234"), 1234);
});

check("matchesKeywords passes when require hits and exclude misses", () => {
  assert.equal(
    matchesKeywords("Herman Miller Aeron size B", {
      require: ["aeron"],
      exclude: ["headrest only"],
    }),
    true
  );
});

check("matchesKeywords fails when an exclude term appears (case-insensitive)", () => {
  assert.equal(
    matchesKeywords("Herman Miller Aeron size B", {
      require: ["aeron"],
      exclude: ["size b"],
    }),
    false
  );
});

check("matchesKeywords fails when a require term is absent", () => {
  assert.equal(
    matchesKeywords("Herman Miller Aeron size B", { require: ["steelcase"] }),
    false
  );
});

const parsed = parseListings(CRAIGSLIST_HTML, "sfbay");

check("parseListings returns 3 listings from 4 blocks, skipping the anchorless one", () => {
  assert.equal(parsed.length, 3);
});

check("parseListings reads title, price, location, url and tags the site", () => {
  assert.deepEqual(parsed[0], {
    title: "Dresser with mirror and nightstand",
    price: 40,
    location: "richmond / point / annex",
    url: "https://sfbay.craigslist.org/eby/fuo/d/san-pablo-dresser/0001.html",
    searched_site: "sfbay",
  });
});

check('parseListings turns "$1,250" into the number 1250', () => {
  assert.equal(parsed[1].price, 1250);
});

check("parseListings yields null price when the post has no price div", () => {
  assert.equal(parsed[2].price, null);
});

check("parseListings decodes HTML entities in titles", () => {
  assert.equal(parsed[1].title, "Herman Miller Aeron chair & ottoman");
  assert.equal(parsed[2].title, `Solid oak "mid-century" dresser '70s`);
});

check("categoryCode maps names to codes and passes raw codes through", () => {
  assert.equal(categoryCode("furniture"), "fua");
  assert.equal(categoryCode("cta"), "cta");
  assert.equal(categoryCode(undefined), "sss");
  assert.equal(categoryCode(""), "sss");
});

check("categoryCode does not resolve inherited Object keys to members", () => {
  assert.equal(categoryCode("constructor"), "constructor");
  assert.equal(categoryCode("hasOwnProperty"), "hasOwnProperty");
});

check("isCraigslistUrl accepts craigslist.org and its subdomains", () => {
  assert.equal(
    isCraigslistUrl("https://sfbay.craigslist.org/sfc/fuo/d/san-francisco-desk/0001.html"),
    true
  );
  assert.equal(isCraigslistUrl("https://craigslist.org/about/help"), true);
});

check("isCraigslistUrl rejects lookalike hosts, other schemes, and non-URLs", () => {
  assert.equal(isCraigslistUrl("https://evil.test/?craigslist.org"), false);
  assert.equal(isCraigslistUrl("https://craigslist.org.evil.test/post.html"), false);
  assert.equal(isCraigslistUrl("http://169.254.169.254/latest/craigslist.org"), false);
  assert.equal(isCraigslistUrl("file:///C:/Windows/win.ini"), false);
  assert.equal(isCraigslistUrl("not a url"), false);
});

await asyncCheck("fetchCraigslistPost refuses a non-craigslist host", async () => {
  await assert.rejects(
    () => fetchCraigslistPost("https://evil.test/?craigslist.org"),
    /refusing to fetch/i
  );
  return "rejected before any request";
});

console.log("\n--- live checks (zero results OK, thrown errors fail) ---");

let fbListings = [];

await asyncCheck("craigslist searchCraigslist across 2 sites", async () => {
  const res = await searchCraigslist({
    query: "dresser",
    sites: ["saltlakecity", "denver"],
    titleOnly: true,
  });
  assert.ok(Array.isArray(res.listings), "listings must be an array");
  return `${res.total_found} found, ${res.sites_searched} sites, ${res.sites_failed.length} failed`;
});

await asyncCheck("facebook searchMarketplace across 2 metros", async () => {
  const res = await searchMarketplace({
    query: "herman miller",
    metros: ["saltlakecity", "portland"],
  });
  assert.ok(Array.isArray(res.listings), "listings must be an array");
  fbListings = res.listings;
  return `${res.total_found} found, ${res.metros_searched} metros, ${res.metros_failed.length} failed`;
});

if (fbListings.length > 0) {
  await asyncCheck("facebook getListing returns a non-empty detail block", async () => {
    const { id } = fbListings[0];
    const item = await getListing(id);
    assert.ok(item.detail && item.detail.trim().length > 0, "detail was empty");
    return `item ${id}, ${item.detail.length} chars of detail`;
  });
} else {
  skip("facebook getListing", "search returned zero listings, no id to fetch");
}

await closeBrowser();

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exitCode = failed > 0 ? 1 : 0;
