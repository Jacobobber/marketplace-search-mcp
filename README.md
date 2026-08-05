# marketplace-search-mcp

An [MCP](https://modelcontextprotocol.io) server that searches **Facebook Marketplace** and **Craigslist** for anything people sell — furniture, electronics, tools, bikes, boats, vehicles, whatever — and hands the results back as structured JSON.

It reads only public, logged-out content. There is no account, no cookie jar, no API key, and no scraping of anything behind a login. Craigslist serves a static search page to a plain HTTP request, so no browser is needed for it. Facebook Marketplace is client-rendered, so a real Chrome is driven headlessly to read the same pages a logged-out visitor sees.

The filtering is where it earns its keep: search both sites at once across as many metros as you like, dedupe, filter on price and keywords, and optionally fetch each candidate's full description so you can match on details that titles leave out.

## Requirements

- **Node 18+**
- **Chrome or Chromium** — only for Facebook searches. Craigslist-only searches (`sources: "craigslist"`) need no browser at all.
- **`PUPPETEER_EXECUTABLE_PATH`** — optional. Standard Chrome installs on Windows, macOS, and Linux are found automatically. Set it only if your browser lives somewhere unusual, or if you get `Chrome or Chromium not found`.

## Install

```bash
git clone https://github.com/Jacobobber/marketplace-search-mcp.git
cd marketplace-search-mcp
npm install
```

Register it with Claude Code:

```bash
claude mcp add marketplace-search --scope user -- node /path/to/marketplace-search-mcp/src/server.js
```

On Windows, and if your Chrome is not in a standard location, pass the browser path too:

```bash
claude mcp add marketplace-search --scope user ^
  -e PUPPETEER_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  -- node C:\path\to\marketplace-search-mcp\src\server.js
```

For any other MCP client, add a stdio server entry:

```json
{
  "mcpServers": {
    "marketplace-search": {
      "command": "node",
      "args": ["/path/to/marketplace-search-mcp/src/server.js"],
      "env": {
        "PUPPETEER_EXECUTABLE_PATH": "/path/to/chrome"
      }
    }
  }
}
```

Drop the `env` block entirely if Chrome is installed in the usual place.

Verify the install with `npm test`, which runs offline parser checks plus a small live query against both sites.

## Tools

### `search_marketplace`

Search both sites and return filtered, price-sorted listings. `query` is the only required parameter.

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `query` | string | — | Search terms, e.g. `"standing desk"`, `"kayak"`. |
| `sources` | `"facebook"` \| `"craigslist"` \| `"both"` | `"both"` | `"craigslist"` is much faster; `"facebook"` needs a browser. |
| `fb_metros` | string[] | the 12 metros below | Facebook metro slugs. |
| `cl_sites` | string[] | all 36 sites below | Craigslist site slugs. |
| `cl_category` | string | `"sss"` (all for sale) | Any code from a craigslist.org search URL's `cat=` parameter. |
| `title_only` | boolean | `false` | **Craigslist only.** Match the query against titles. Higher precision, fewer hits. |
| `price_min` | integer | — | See price handling below. |
| `price_max` | integer | — | |
| `require_keywords` | string[] | — | Every term must appear, case-insensitively. |
| `exclude_keywords` | string[] | — | Drop listings containing any of these terms. |
| `deep_check` | boolean | `false` | Fetch full descriptions and match `require_keywords` against them. Slow — see below. |
| `max_results` | integer | `50` | 1–200. |

Slugs must be lowercase alphanumeric with no punctuation: `saltlakecity`, not `salt-lake-city`.

**Response**

```json
{
  "total_found": 128,
  "returned": 50,
  "deep_checked": 0,
  "skipped_deep_checks": 0,
  "sources_failed": [],
  "listings": [
    {
      "source": "craigslist",
      "id": "7891234567.html",
      "url": "https://sfbay.craigslist.org/sfc/fuo/d/san-francisco-desk/7891234567.html",
      "title": "Standing desk, electric",
      "price": 180,
      "location": "inner sunset",
      "searched_in": "sfbay"
    }
  ]
}
```

`price` is always a number or `null` — `"Free"` and posts with no price field come back as `null` rather than `0`, while a post the seller literally listed at `$0` keeps `0`. `searched_in` is the metro or site the result came from. Craigslist has no numeric post id in static results, so the trailing URL segment doubles as `id`. Results are sorted by price ascending with unknown prices last. `sources_failed` collects per-metro and per-listing errors without failing the whole call — a single timed-out metro does not sink the search.

**Price handling.** Craigslist enforces `price_min`/`price_max` server-side; Facebook has no price parameter, so its results are filtered here. Either way, when you set a bound, listings with no parsable price are dropped — otherwise every "contact me" post would match every budget.

**Deep check.** Titles are short and omit almost everything. With `deep_check: true` the server fetches each candidate's own page and matches against the full description, which is how you find "must be sealed" or "no rips" or a model number buried in prose. Precisely what happens:

- `exclude_keywords` are applied **early, against titles**, before anything is fetched — no reason to pay for a page that is already disqualified. They are applied again against the full text afterwards.
- `require_keywords` are **held back** and matched against the title plus the full description together. Filtering them against titles first would make the fetch pointless.
- Only the **40 cheapest candidates** are fetched, four at a time, at roughly 2–4 seconds each. Past that cap the title is all there is to judge by, so `require_keywords` fall back to title matching for the remainder. The response reports `deep_checked` and `skipped_deep_checks` so you know which rule applied.
- Deep-checked listings gain a `detail_excerpt` field, the first 600 characters of the description.
- If a detail page fails to load, the listing survives on its title alone and the error lands in `sources_failed`.

Each source hands back at most 400 raw listings before filtering.

### `get_listing`

Fetch one listing's title, price, and full description.

| Parameter | Type | Notes |
| --- | --- | --- |
| `url_or_id` | string | A craigslist.org post URL, a `facebook.com/marketplace/item/<id>/` URL, or a bare Facebook item id. |

Returns `{ source, title, price, detail }`, with `price` normalized to a number or `null`. Anything it cannot recognize as one of those three forms is an error rather than a guess: the host is parsed and checked, so a lookalike such as `https://example.com/?craigslist.org` is rejected instead of fetched.

### `list_sources`

No parameters. Returns the default Facebook metro slugs, Craigslist site slugs, and the common category codes — useful for confirming a slug before searching.

**Facebook metros (12):** `nyc`, `la`, `chicago`, `dallas`, `phoenix`, `sanfrancisco`, `seattle`, `denver`, `saltlakecity`, `miami`, `atlanta`, `boston`

**Craigslist sites (36):** `newyork`, `losangeles`, `chicago`, `houston`, `phoenix`, `philadelphia`, `sanantonio`, `sandiego`, `dallas`, `austin`, `sfbay`, `seattle`, `denver`, `boston`, `miami`, `atlanta`, `tampa`, `orlando`, `portland`, `minneapolis`, `detroit`, `stlouis`, `charlotte`, `raleigh`, `nashville`, `kansascity`, `lasvegas`, `sacramento`, `columbus`, `indianapolis`, `cleveland`, `pittsburgh`, `saltlakecity`, `washingtondc`, `neworleans`, `oklahomacity`

**Common Craigslist categories**

| Code | Category |
| --- | --- |
| `sss` | all for sale (default) |
| `fua` | furniture |
| `ela` | electronics |
| `tla` | tools |
| `ppa` | appliances |
| `bia` | bikes |
| `boo` | boats |
| `cta` | cars & trucks |
| `mca` | motorcycles |
| `zip` | free stuff |

Any other code Craigslist accepts works too — grab it from the `cat=` parameter of any craigslist.org search URL.

## Examples

**A used Aeron chair under $400, across five metros.** Fast: no detail fetches, and the exclusions kill the parts listings that dominate this search.

```json
{
  "query": "herman miller aeron",
  "sources": "both",
  "fb_metros": ["saltlakecity", "denver", "phoenix", "sanfrancisco", "seattle"],
  "cl_sites": ["saltlakecity", "denver", "phoenix", "sfbay", "seattle"],
  "cl_category": "fua",
  "price_max": 400,
  "exclude_keywords": ["parts only", "broken", "for parts"],
  "max_results": 40
}
```

**A nationwide hunt for a discontinued item, where the detail text decides.** Whether a set is sealed is almost never in the title, so `deep_check` earns its cost here. Craigslist-only keeps it browser-free and quick enough to run wide.

```json
{
  "query": "lego star wars",
  "sources": "craigslist",
  "cl_category": "sss",
  "price_min": 50,
  "deep_check": true,
  "require_keywords": ["sealed"],
  "exclude_keywords": ["bulk", "minifigures only", "incomplete"],
  "max_results": 25
}
```

With `deep_check` on, `sealed` is matched against each post's full description, while `bulk` and `incomplete` knock out obvious misses by title before any page is fetched. Watch `skipped_deep_checks` in the response: if it is large, the 40-fetch cap was reached and the tail was judged on titles only — narrow `cl_sites` or add a `price_min` to tighten the candidate pool.

## Composing with other servers

This server deliberately contains **zero domain logic**. It knows how to find and filter listings, and nothing about what any of them mean. Domain-specific servers compose cleanly on top: pair it with a specs database, a price-history service, or a safety-recall lookup for whatever you are shopping for, and the model can search here and interpret there. Keeping the domain knowledge out of the search layer is what lets the same tool hunt for a dresser, a kayak, and a discontinued Lego set.

## Limitations and etiquette

- **Public data only.** Everything here is what a logged-out visitor sees. No login, no cookies, no credentials, and no access to anything gated.
- **No anti-bot circumvention.** There is no CAPTCHA solving and no attempt to defeat rate limiting or bot detection. If a site asks for a challenge, the request simply fails and shows up in `sources_failed`.
- **Be polite.** Requests are deliberately bounded — concurrency limits, a 40-fetch deep-check cap, per-request timeouts. Please keep it that way rather than turning this into a crawler. Start narrow; a nationwide `deep_check` sweep is slow for you and rude to them.
- **Markup drift breaks parsers.** Both sites are parsed from HTML that they can change without notice. When results suddenly go empty, the parser has probably fallen behind. `npm test` is the fastest way to tell whether that is what happened.
- **Facebook zero results are normal.** A metro with no matches is a valid, non-error outcome, as is a listing with no description block.
- **Not affiliated** with Meta, Facebook, or Craigslist. Use it in accordance with those sites' terms and your local laws.

## License

MIT — see [LICENSE](LICENSE).
