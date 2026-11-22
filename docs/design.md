# stackexchange-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `stackexchange_search_questions` | Search questions across a Stack Exchange site. Returns ranked questions with title, score, answer count, accepted status, tags, ask and last-activity dates, and a prose excerpt — no full bodies at this stage. Entry point; results supply `question_id` for `stackexchange_get_thread`. Reports the sort applied (`appliedSort`), with `sortOverrideReason` when a score threshold forced `votes` over the requested sort. | `query` (string), `site` (default `stackoverflow`), `tags` (string[]), `acceptedOnly` (bool), `minScore` (int), `sort` (enum: relevance\|votes\|activity\|newest), `pageSize` (max 30), `page` (1-based) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `stackexchange_get_thread` | Read a question or answer URL, a page of answers and optional comments. Duplicate questions carry their original question IDs. | `questionIdOrUrl`, `site`, `includeComments`, `maxAnswers`, `answersPage`, `commentsPage` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `stackexchange_get_tag_faq` | A tag's frequently asked questions on a site — Stack Exchange's own selection, returned in its order and not sorted by score. Maps to `/tags/{tag}/faq`. Returns question list without bodies; use `stackexchange_get_thread` to read any result. | `tag` (string), `site` (default `stackoverflow`), `pageSize` (max 30), `page` (1-based) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `stackexchange_get_user` | Read the user profile and the first ten tags from `/users/{id}/top-answer-tags` in answer-score order. | `userId`, `site` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `stackexchange_list_sites` | Search site names, API site parameters and audiences. The standalone `meta` token includes meta sites. A partial page walk is disclosed. | `filter` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |

### Tool Error Contracts

Typed contracts for domain-specific failures. Every tool declares one, so a caller can branch on `data.reason` and read `data.recovery.hint` on any failure. Baseline codes (`InternalError`, `Timeout`) bubble freely and aren't listed.

Six reasons are shared, because they arise in `fetchSe` rather than in any one tool:

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `invalid_site` | `ValidationError` | SE answers a bad `site` with prose — `No site found for name \`x\`` | No — use `stackexchange_list_sites` to discover valid values |
| `invalid_parameter` | `ValidationError` | SE rejects a request parameter and names the bare field (`pagesize`, `tagged`) | No — correct the named parameter |
| `invalid_api_key` | `ConfigurationError` | SE does not recognize the key the server is configured with | No — no tool input fixes it; an operator corrects `STACKEXCHANGE_API_KEY` |
| `throttled` | `RateLimited` | SE throttles this server's IP — a `throttle_violation` envelope or a bare HTTP 429 — or a `backoff` window outlasts the call's deadline | After `retryAfter` seconds (also in the message). Retried within the call while the wait fits its deadline and is 30 s or less; a wait of hours means the IP's daily quota is spent |
| `pacer_shed` | `RateLimited` | The framework pacer sheds a call whose queue wait would outlast its deadline | After `retryAfter` seconds (also in the message) |
| `upstream_unavailable` | `ServiceUnavailable` | SE answers a `temporarily_unavailable` (503) or `internal_error` (500) envelope, or a body that is not the expected JSON envelope | Yes — retried like a 5xx within the call; past that SE is degraded, retry in a few minutes |

SE reports every method error on HTTP 400, so `error_name` and message shape do the classifying, not the status. Note that SE's envelope carries its own `error_id` — a `403`, `500`, `502`, or `503` there is not an HTTP status. `throttled` is also raised from a bare HTTP 429, whose `Retry-After` supplies the wait when present.

`retryAfter` reports how long the caller should wait. An IP throttle can state a delay in the `throttle_violation` envelope or `Retry-After` header. Without a stated delay, the shared pacer supplies its cooldown. A successful wrapper's `backoff` applies to subsequent requests to that API method across sites and arguments.

Every tool also declares `quota_exceeded` (`RateLimited`) when `quota_remaining` reaches 0. Not retryable within the day: it carries `data.retryable: false`, so the call sends its one request and stops. Quota resets at midnight UTC, and `STACKEXCHANGE_API_KEY` lifts the ceiling to 10,000/day (Stack Exchange's default per-key daily limit).

Per-tool reasons on top of those:

| tool | reason | code | when |
|:-----|:-------|:-----|:-----|
| `stackexchange_search_questions` | `paging_depth_limit` | `Forbidden` | `page` above 25 without a key — SE answers `error_name: "access_denied"` |
| `stackexchange_get_tag_faq` | `paging_depth_limit` | `Forbidden` | same, on `/tags/{tag}/faq` |
| `stackexchange_get_thread` | `question_not_found` | `NotFound` | `items[]` empty — SE answers HTTP 200 with no items rather than 404 |
| `stackexchange_get_thread` | `invalid_id_or_url` | `ValidationError` | The input has no recognized question ID or question/answer link, or Stack Exchange refused its ID. |
| `stackexchange_get_thread` | `answer_not_found` | `NotFound` | A short answer link names an unavailable answer. |
| `stackexchange_get_thread` | `paging_depth_limit` | `Forbidden` | A keyless answer or comment request exceeds the upstream page limit. |
| `stackexchange_get_tag_faq` | `invalid_tag` | `ValidationError` | The tag is blank after trimming. |
| `stackexchange_get_user` | `user_not_found` | `NotFound` | Same empty-items pattern as questions |
| `stackexchange_get_user` | `invalid_user_id` | `ValidationError` | `userId` above 2147483647 — SE user IDs are 32-bit signed integers |

`stackexchange_list_sites` declares only the shared set, less `invalid_site`: `/sites` takes no `site` parameter, and its page walk stops at page 10, well under the keyless page-25 wall.

The upper bound on `userId` is enforced in the handler rather than on the input schema deliberately. A schema rejection never reaches `errors[]` — the handler does not run — so it would arrive as a generic `InvalidParams` with no reason and no recovery hint.

### Resources

None. All data is accessible via tools. SE content is dynamic (vote scores, new answers) and question IDs are not stable enough across sites to warrant URI-addressable resources for this use case.

### Prompts

None. This is a read-only data access server; no recurring interaction template adds value over the tools themselves.

---

## Overview

stackexchange-mcp-server gives agents access to Stack Overflow and the wider Stack Exchange network (Super User, Server Fault, Ask Ubuntu, Unix & Linux, Mathematics, DBA, etc.) and returns full Q&A threads as clean markdown — accepted answer first, code blocks intact, attribution included.

The Stack Exchange API serves HTML post bodies when the method's filter includes `body`. The server normalizes those fragments to Markdown and preserves attribution.

Wraps the Stack Exchange API v2.3 (`https://api.stackexchange.com/docs`). Read-only; no OAuth or user auth required.

---

## Requirements

- Search questions across any SE site via full-text + tag/score/accepted filters
- Read a question and its vote-ranked answers as Markdown, with continuation for answers and comments.
- Select body fields through server-owned filters.
- HTML→markdown normalization: `<pre><code>` → fenced code blocks, `<p>` → paragraphs, `<strong>`/`<em>` → bold/italic, `<a>` → `[text](url)`, `<ul>`/`<ol>`/`<li>` → lists, `<h1>`-`<h6>` → headers, `<blockquote>` → blockquote
- Answers sorted: accepted answer first, then by score descending
- Attribution in output: display name + profile link + answer score, per CC BY-SA 4.0
- Rate limit: keyless ~300 req/day per IP; optional `STACKEXCHANGE_API_KEY` env var lifts to ~10,000/day
- Respect the `backoff` field: some responses include a `backoff: N` (seconds) the service layer must honor
- HTTP 400 error envelope: `{ error_id, error_message, error_name }` — map to typed errors
- **Empty-items ≠ not-found for questions/users:** `GET /questions/{id}` and `GET /users/{id}` return HTTP 200 with `{"items":[]}` when the ID is valid-format but nonexistent (confirmed via live probe). `get_thread` and `get_user` must check for empty `items[]` and throw `not_found`; they must NOT return an empty result.
- No fabricated ranking: surface real score and accepted flag; never synthesize a confidence number

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `stackexchange-service` | Stack Exchange API v2.3 HTTP client — rate-limit awareness, `backoff` tracking, quota logging, `withbody` filter management, gzip decompression, error envelope parsing | All tools |
| `html-normalizer` (internal helper, not a service class) | Lightweight HTML→markdown converter for SE post bodies — handles SE's known tag set; no external dep | `stackexchange-service` answer/question fetch methods |

The `html-normalizer` is a module-private function in the service (`src/services/stackexchange/html-normalizer.ts`), not an init/accessor service — it's stateless and synchronous. The framework's `HtmlExtractor` (which uses `defuddle`/`linkedom`) is designed for full web pages and is overkill for SE's structured post snippets; a custom normalizer handles the SE tag set correctly and adds no dependency. Turndown is not needed.

**Backoff tracking.** Every upstream call shares one dispatch slot. The JSON wrapper's `backoff` holds one API method across IDs, arguments and sites. HTTP 429 and `throttle_violation` hold all methods.

Queueing, method waits, IP cooldowns, retries and chained requests share a 50-second operation budget. A method waiting for backoff leaves the dispatch slot available. A wait that cannot fit before the deadline returns `throttled` with `retryAfter`. A queue wait that exhausts the budget returns `pacer_shed`. Caller cancellation propagates.

**Decision:** fail fast with the known wait rather than sleep into the deadline. Sleeping out a backoff the deadline cannot cover cost every caller the full 50 s and ended in `retry_deadline_exceeded`, which names no wait.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `STACKEXCHANGE_API_KEY` | No | Registered API key — lifts per-IP quota from ~300/day to ~10,000/day. No OAuth; just a query param. Obtain at https://stackapps.com/apps/oauth/register (OAuth flow only needed for write access — key-only is read-only). |

---

## Implementation Order

1. `src/config/server-config.ts` — `STACKEXCHANGE_API_KEY` optional string schema
2. `src/services/stackexchange/html-normalizer.ts` — HTML→markdown normalizer (stateless, pure)
3. `src/services/stackexchange/types.ts` — SE API response types
4. `src/services/stackexchange/stackexchange-service.ts` — HTTP client, backoff, quota logging, typed methods
5. `stackexchange_list_sites` tool (no body parsing, bounded dataset, tests easy)
6. `stackexchange_search_questions` tool (search, no bodies)
7. `stackexchange_get_tag_faq` tool (tag FAQ, no bodies)
8. `stackexchange_get_user` tool (user profile)
9. `stackexchange_get_thread` tool (bodies + HTML normalization — the flagship)
10. Remove echo definitions; register all tools in `src/index.ts`
11. `bun run devcheck`

Each step after the service layer is independently testable with mock context.

---

## Domain Mapping

| Noun | Operations | Tool |
|:-----|:-----------|:-----|
| Questions | search, fetch-with-body | `search_questions`, `get_thread` |
| Answers | fetch-with-body (as part of thread) | `get_thread` |
| Tags | FAQ/top questions | `get_tag_faq` |
| Users | profile + top tags | `get_user` |
| Sites | enumerate | `list_sites` |

---

## Workflow Analysis

`stackexchange_get_thread` — 2 upstream calls:

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /questions/{id}` with the thread filter | Question body, closure metadata and duplicate targets |
| 2 | `GET /questions/{id}/answers` with `withbody`, page, page size and vote sort | Selected page of answers |

A short `/a/` URL first resolves the answer's parent question. Page 1 can add an off-page accepted answer. A linked answer can also appear outside the vote-ranked page. With `includeComments`, the service reads the question's comment page and groups answer comments by `post_id` across batches of at most 100 IDs. Each page carries up to 100 comments per batch. Keep `answersPage` and `maxAnswers` fixed while advancing `commentsPage`.

When a long answer URL already identifies the question, the server finishes the requested thread first. An optional lookup for an off-page linked answer and its comments shares a two-second budget within the call's deadline. If that budget or the quota runs out, the caller receives the thread with a notice identifying the missing content.

`stackexchange_get_user` — 2 upstream calls, sent one at a time through the pacer:

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /users/{id}?site={site}` | Profile: reputation, badge counts, display name, location, account metadata |
| 2 | `GET /users/{id}/top-answer-tags?site={site}&pagesize=10` | Top tags by answer score |

If the answer-tag route returns no items, the profile carries `topTags: []`. An empty profile response raises `user_not_found`.

---

## Design Decisions

**No HTML→markdown library dependency.** SE post bodies use a predictable, limited HTML tag set (`<p>`, `<pre><code>`, `<strong>`, `<em>`, `<a>`, `<ul>`, `<ol>`, `<li>`, `<h1>`-`<h6>`, `<blockquote>`, `<code>` inline). A custom normalizer covers this in ~80 lines with no peer dependency. The framework's `HtmlExtractor` (defuddle + linkedom) is designed for full web pages and adds unnecessary complexity for fragments; `turndown` would work but adds a dep for a task this small.

**The server owns the upstream filters.** The question lookup extends `withbody` to return duplicate targets alongside the body. The search filter selects Markdown source for excerpts and closure fields for status. Answer and comment requests use `withbody`.

**Answer order.** When a page contains the accepted answer, it appears first. The remaining answers are sorted by score. Only page 1 brings in an accepted answer outside its vote-ranked page.

**`list_sites` uses local filter, not upstream search.** The full SE network has 365 sites counting per-site metas — a bounded, rarely-changing list. Four pages of 100 retrieve them all. Client-side `filter` matching is appropriate here; there's no upstream search for sites.

**A question URL carries its own site.** Question IDs are per-site, so `get_thread` reads a URL's question from the URL's host and sends that host upstream as `site`. SE resolves a host the same way it resolves an `api_site_parameter`, and resolves a host listed in a site's `aliases` too (confirmed live: `meta.unix.stackexchange.com` reaches `unix.meta`), so no mapping table is kept for the request. Off-domain aliases resolve too (confirmed live: `arqade.com` → `gaming`, `askdifferent.com` → `apple`, `programmers.stackexchange.com` → `softwareengineering`). The host is the authority directly in front of the first `/questions/{id}` in the input — after `//`, or, when no scheme was written, after the start of the text, whitespace, `<`, `(`, `[` or a quote — so wrapped forms (`<https://…>`, `<unix.stackexchange.com/questions/…>`, `"unix.stackexchange.com/questions/…"`, `see unix.stackexchange.com/questions/…`, a markdown link target, an archive URL around a question URL) read the inner host. The trailing dot of a fully qualified host (`stackoverflow.com.`) is dropped, since SE answers the dotted form "No site found". A host must hold two labels, so a relative path (`./questions/88490`, `../questions/88490`) is not read as one. Text with that path but no host in front of it (`/questions/88490`) reads from `site`, as numeric IDs do.

**Nothing 0.1.17 answered correctly with an explicit `site` is rejected.** 0.1.17 took the number after the first `/questions/` anywhere in the input and read it from `site`, so it was right whenever `site` named the URL's site, aliases and wrapped URLs included. Sending the host keeps every such case SE can resolve. A host off the network is still sent: SE answers `bad_parameter` "No site found for name `<host>`". With an explicit non-blank `site` that differs from the host, the service then sends the 0.1.17 request — the question from `site` — once more inside the same attempt and deadline (a retried attempt goes to `site` directly, never re-sending the refused host), which keeps a translation proxy (`stackoverflow-com.translate.goog`, confirmed `No site found`) answering, and the response reports it as `siteConflict` with `resolvedBy: "site"`. Without one, the rejection surfaces as `invalid_site` after a single request; that is the only case 0.1.17 could answer (by its `stackoverflow` default) that now fails, deliberately, since nothing then names the site. A local allowlist of Stack Exchange domains was rejected because it turned alias URLs (`arqade.com` with `site: gaming`) from right answers into errors.

**An explicit `site` that disagrees with a URL is ignored and disclosed, not rejected.** The URL's host is sent, and the response carries `siteConflict` with `resolvedBy: "url_host"`, structured and as a trailer line, when `site` names none of: the URL host, the canonical host of the returned question `link`, or that host's `api_site_parameter`. The parameter is derived as the stem before `.stackexchange.com`, the host less `.com` elsewhere, and `mathoverflow.net` hosts as they are; this matches all 365 sites `/sites` returns. Comparing against the returned link costs no extra request and keeps an alias URL beside its site's current parameter (`arqade.com` with `gaming`) from being reported. `site` is optional rather than defaulted on `get_thread` so an omitted value is never reported: with a Zod default, every non-Stack Overflow URL sent without `site` would have carried a defaulted `stackoverflow` to report.

**No resources.** SE content is dynamic (votes change, new answers appear). The tool surface is self-sufficient for all tool-only agents.

**`stackexchange_get_user` is a lightweight add.** The user tool is useful primarily for credibility context on an answer author. It doesn't justify its own dedicated tool chain but rounds out the surface — `get_thread` surfaces `owner.user_id`, and `get_user` then resolves the author without a separate search.

**Quota limit exposed in enrichment.** The `quota_remaining` and `quota_max` fields from every SE response are surfaced via `ctx.enrich()` so agents can plan around rate limits without the server needing to fail.

**The applied search sort is reported.** SE's `min` bounds the active sort field, so a score threshold forces the `votes` sort whatever the caller asked for. `stackexchange_search_questions` reports `appliedSort` in its own `sort` vocabulary (`newest`, never SE's `creation`) and adds `sortOverrideReason` when the two differ, so a caller can tell vote-ranked results from the order it requested. Echoing the full upstream query was rejected: it restates the input to disclose one field, and spells the sort in a value the tool's `sort` enum rejects.

---

## API Reference

**Base URL:** `https://api.stackexchange.com/2.3`

**Key parameters:**
- `site` — required on most endpoints; value is `api_site_parameter` from `/sites` (e.g., `stackoverflow`, `superuser`, `serverfault`) or the site's domain (`serverfault.com`, `unix.stackexchange.com`, `ru.stackoverflow.com`, `meta.stackexchange.com`, `stackapps.com` all confirmed live)
- `filter` selects upstream fields. The thread filter includes the question body and duplicate targets.
- `key` — optional API key to lift per-IP quota to ~10,000/day
- `pagesize` — max 100; practical default 10–30 for thread fetches
- `sort` — `votes`, `activity`, `creation`, `relevance` (relevance only on search endpoints)

**Response envelope:**
```json
{
  "items": [...],
  "has_more": true,
  "quota_max": 300,
  "quota_remaining": 291,
  "backoff": 10  // optional wait in seconds before another request to this method
}
```

**Error envelope (HTTP 400/500):**
```json
{
  "error_id": 400,
  "error_message": "No site found for name `invalid_site_xyz`",
  "error_name": "bad_parameter"
}
```

**Confirmed via live probe (2026-06-04):**
- `filter=withbody` returns `body` field as HTML on both `/questions/{id}` and `/questions/{id}/answers`
- The default filter omits post bodies.
- `/tags/{tag}/faq` returns question list without bodies (expected; use `get_thread` for bodies), in SE's "frequently asked" order rather than by score
- `/users/{id}` returns the user profile. Fetch `/users/{id}/top-answer-tags` for answer-score ranking.
- Error envelope confirmed: `{ error_id, error_message, error_name }` for bad `site` param
- Keyless quota: 300/day per IP (`quota_max: 300` in every response)
- Responses are gzip-encoded — `Accept-Encoding: gzip` or `curl --compressed` required
- No `backoff` field observed in test calls (appears only when the API throttles)

---

## Known Limitations

- **~300 req/day keyless.** Agents doing broad research will hit this quickly. The `STACKEXCHANGE_API_KEY` env var lifts this to ~10,000/day without any user OAuth flow; the README should make this prominent.
- **Bodies are HTML, not Markdown.** The SE API does not provide a markdown output format. The normalizer handles SE's known tag set; edge cases (MathJax, custom SE rendering plugins, obscure HTML constructs in older posts) may produce imperfect output.
- **No cross-site search.** The SE API requires a `site` parameter; there is no "search all sites at once" endpoint. The `list_sites` tool lets agents enumerate and search each site separately.
- **Keyless page depth.** Stack Exchange refuses API pages past 25 without a key, including answer pages and comment pages.
