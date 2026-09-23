# @pipeworx/nih-supplements

NIH fact sheets for vitamins, minerals and a few botanicals — uses, safety,
interactions with medications, references — plus real supplement product
labels from NIH's Dietary Supplement Label Database, and NCCIH's herb
safety/science summaries for the many popular herbs ODS itself doesn't cover.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1663+ live data sources.

## Tools

- `supplement_factsheet(name, level?)` — a topic's ODS fact sheet: what it
  does, whether it works, safety, and interactions with medications.
  `level` is `consumer` (short, default) or `professional` (long, clinical,
  with a references list).
- `supplement_factsheets(query?)` — the bundled list of ~45 topics ODS
  publishes a fact sheet for, and which reading levels each has.
- `supplement_labels(query, limit?)` — search real product labels (brand,
  ingredients, amounts, claims) from the Dietary Supplement Label Database
  (DSLD) by product, brand, or ingredient.
- `supplement_label(id)` — one product's full label detail: ingredient
  amounts, other ingredients, manufacturer contact, precaution statements.
- `herb_at_a_glance(herb)` — NCCIH's "Herbs at a Glance" science-and-safety
  summary for ~56 popular herbs (turmeric, ginkgo, echinacea, garlic,
  ginseng, milk thistle, St. John's Wort, and more) that ODS does not have
  its own fact sheet for.
- `supplement_recent_changes(since, limit?)` — new DSLD product labels
  entered on or after a date, newest first, deterministic on replay. DSLD is
  the only NIH supplement upstream with a queryable change signal; the
  response states plainly that withdrawals (offMarket transitions) and
  ODS/NCCIH content updates are NOT diffable upstream rather than pretending
  to cover them.

## Change tracking & enumeration (for periodic refreshers)

- **New labels:** `supplement_recent_changes(since)` pages DSLD newest-first
  (`sort_by=entryDate&sort_order=desc`) to the cutoff — deterministic, so
  replays are idempotent until NIH enters new labels.
- **Fact-sheet / herb-page content changes:** not diffable upstream — no
  list endpoint, no sitemap `lastmod` (checked 2026-09-08; NCCIH's sitemap
  exists but carries no dates, and HHS's syndication API is bot-walled).
  Each `supplement_factsheet` response carries its own `reviewed` date.
- **Full enumeration:** both content corpora are bundled and small —
  `supplement_factsheets()` lists all ~45 ODS topics; the ~56 NCCIH herbs
  are in `NCCIH_HERBS` in `src/index.ts` (and any name from either list can
  be fetched in full). DSLD's full corpus (~215k labels) is enumerable via
  the same sorted paging (`size`/`from`), and NIH also publishes full DSLD
  dataset downloads at <https://dsld.od.nih.gov/> for bulk use. There is no
  versioned bulk file for the fact sheets — enumeration over the bundled
  inventory IS the snapshot path for them.

## Auth

Keyless. All three upstreams (ODS fact sheets, DSLD, NCCIH) are open NIH
sites with no API key.

## Data sources

- <https://ods.od.nih.gov/api/> — ODS fact sheet XML API
  (`?resourcename=<slug>&readinglevel=Consumer|HealthProfessional&outputformat=XML`).
  **Trap:** a fresh call from a browser-shaped User-Agent returns real XML; a
  rapid second call from the same client comes back **HTTP 200 with an HTML
  bot-check page** instead of data — same status code, no error, completely
  different body. Never trust an HTML-shaped 200 from this host as a "not
  found"; it means "slow down and retry". This pack handles it with a
  per-isolate cache plus a floor between outbound calls
  (`spacedFetch`/`MIN_GAP_MS` in `src/index.ts`) — don't remove that if you
  touch this file.
- <https://ods.od.nih.gov/factsheets/list-all/> — there is no live endpoint
  that lists every fact sheet (the obvious one 403s; the sitemap carries no
  fact-sheet URLs), so the ~45-topic inventory (`ODS_TOPICS` in
  `src/index.ts`) is bundled by hand from this page, read once on 2026-09-07.
  Almost every topic uses the same slug for both reading levels — level is a
  separate query param — except two: "Dietary Supplements in the Time of
  COVID-19" and Chromium each use a different slug per level, which is why
  the inventory stores `consumerSlug`/`professionalSlug` per topic instead of
  one shared slug.
- <https://api.ods.od.nih.gov/dsld/v9/search-filter?q=> — DSLD label search,
  keyless JSON. `hit._source` carries `brandName`, `fullName`, `productType`,
  `allIngredients`, `claims`, `netContents`, `offMarket`.
- <https://api.ods.od.nih.gov/dsld/v9/label/<id>> — DSLD label detail (not
  documented anywhere findable; discovered by pattern-matching the search
  API's `_id` field on 2026-09-07). Carries ingredient amounts
  (`ingredientRows[].quantity[]`), other ingredients, manufacturer contact,
  and the precaution/warning statements printed on the bottle.
- <https://www.nccih.nih.gov/health/<slug>> — NCCIH "Herbs at a Glance"
  pages. No JSON-LD, `__NEXT_DATA__`, or XHR/API was found (checked
  2026-09-07), but every page's content `<h2>` carries a **stable `id`
  attribute** — `background`, `how-much-do-we-know`, `what-have-we-learned`,
  `what-do-we-know-about-safety`, `keep-in-mind`, `for-more-information`,
  `key-references` — verified identical and in the same order across 5 herbs
  (ashwagandha, echinacea, garlic, ginkgo, turmeric). That is the "sections
  are stable" condition required before building a bounded prose extractor
  over these pages (docs/herbal-sources-scope.md §2); it passed, so
  `herb_at_a_glance` ships. The ~56-herb list (`NCCIH_HERBS`) is likewise
  bundled by hand from `nccih.nih.gov/health/herbsataglance`, read once on
  2026-09-07 — there is no live index for this either.
- German Commission E (the ABC English translation on herbalgram.org) is
  **not ingested** — it's a copyrighted 1998/2000 work with no reuse terms
  on the page. If you need it, link the URL; don't scrape or mirror the
  text.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "nih-supplements": {
      "url": "https://gateway.pipeworx.io/nih-supplements/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/nih-supplements/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1663+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/supplement_factsheet \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ashwagandha","level":"consumer"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/supplement_factsheet`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "nih-supplements": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-nih-supplements"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-nih-supplements
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Nih Supplements data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
