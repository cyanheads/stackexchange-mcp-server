# stackexchange-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `stackexchange_search_questions` | Search questions across a Stack Exchange site. Returns ranked questions with title, score, answer count, accepted status, tags, and excerpt — no bodies at this stage. Entry point; results supply `question_id` for `stackexchange_get_thread`. | `query` (string), `site` (default `stackoverflow`), `tags` (string[]), `accepted_only` (bool), `min_score` (int), `sort` (enum: relevance\|votes\|activity\|newest), `page_size` (max 30) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `stackexchange_get_thread` | Fetch a complete Q&A thread — question body and all answers, accepted answer first then sorted by score, rendered as clean markdown with fenced code blocks. Accepts an integer question ID or a full Stack Overflow/SE question URL (e.g., `https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster` or `https://stackoverflow.com/questions/11227809/title#answerAnchor` — extract the integer immediately following `/questions/`). The HTML→markdown normalization and the `withbody` filter are baked in; one call replaces fetch-question + fetch-answers + strip-HTML + rank. Attribution (author + link) included per CC BY-SA. | `question_id_or_url` (string), `site` (default `stackoverflow`), `include_comments` (bool, default false), `max_answers` (int, default 10) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `stackexchange_get_tag_faq` | Highest-voted answered questions for a tag on a site — the "canonical answers in X" tool. Maps to `/tags/{tag}/faq`. Returns question list without bodies; use `stackexchange_get_thread` to read any result. | `tag` (string), `site` (default `stackoverflow`), `page_size` (max 30) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `stackexchange_get_user` | User profile by ID: reputation, badge counts, top tags by answer score, and account metadata. Credibility context for an answer author. Makes 2 upstream calls: `/users/{id}` (profile) + `/users/{id}/top-tags` (parallelized). | `user_id` (int), `site` (default `stackoverflow`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `stackexchange_list_sites` | Enumerate the Stack Exchange network sites — name, `api_site_parameter`, audience, and URL. Discovery for cross-site search; the `site` param on every other tool comes from `api_site_parameter` here. Results are filtered client-side from a single paged fetch (the network site list is small and bounded). | `filter` (optional string, local name filter) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |

### Tool Error Contracts

Typed contracts for domain-specific failures. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`) bubble freely and aren't listed.

**`stackexchange_search_questions`**

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `invalid_site` | `InvalidParams` | SE returns `error_name: "bad_parameter"` for unknown `site` value | No — fix the `site` value; use `stackexchange_list_sites` to discover valid values |
| `quota_exceeded` | `ServiceUnavailable` | `quota_remaining` reaches 0 | No — quota resets at midnight UTC; supply `STACKEXCHANGE_API_KEY` to lift to 10 k/day |

**`stackexchange_get_thread`**

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `question_not_found` | `NotFound` | `items[]` is empty (HTTP 200 with no items — SE does NOT return 400 for a missing question ID) | No — verify the ID or re-run a search |
| `invalid_site` | `InvalidParams` | SE returns `error_name: "bad_parameter"` for unknown `site` value | No — fix the `site` value |
| `invalid_id_or_url` | `InvalidParams` | Input is not a parseable integer ID and not a recognizable SE question URL | No — provide a numeric question ID or a valid URL |
| `quota_exceeded` | `ServiceUnavailable` | `quota_remaining` reaches 0 | No — quota resets at midnight UTC |

**`stackexchange_get_tag_faq`**

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `invalid_site` | `InvalidParams` | SE returns `error_name: "bad_parameter"` for unknown `site` value | No — fix the `site` value |
| `quota_exceeded` | `ServiceUnavailable` | `quota_remaining` reaches 0 | No — quota resets at midnight UTC |

**`stackexchange_get_user`**

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `user_not_found` | `NotFound` | `/users/{id}` returns `items[]` empty (HTTP 200 — same empty-items pattern as questions) | No — verify the user ID |
| `invalid_site` | `InvalidParams` | SE returns `error_name: "bad_parameter"` for unknown `site` value | No — fix the `site` value |
| `quota_exceeded` | `ServiceUnavailable` | `quota_remaining` reaches 0 | No — quota resets at midnight UTC |

### Resources

None. All data is accessible via tools. SE content is dynamic (vote scores, new answers) and question IDs are not stable enough across sites to warrant URI-addressable resources for this use case.

### Prompts

None. This is a read-only data access server; no recurring interaction template adds value over the tools themselves.

---

## Overview

stackexchange-mcp-server gives agents access to Stack Overflow and the wider Stack Exchange network (Super User, Server Fault, Ask Ubuntu, Unix & Linux, Mathematics, DBA, etc.) and returns full Q&A threads as clean markdown — accepted answer first, code blocks intact, attribution included.

The primary value-add is the HTML→markdown normalization layer. The Stack Exchange API returns question and answer bodies only when a `filter=withbody` parameter is supplied, and the bodies are HTML. Without this server, agents either call the API without bodies (getting no content) or get raw HTML they must parse themselves. This server bakes in the filter and normalizes the output.

Wraps the Stack Exchange API v2.3 (`https://api.stackexchange.com/docs`). Read-only; no OAuth or user auth required.

---

## Requirements

- Search questions across any SE site via full-text + tag/score/accepted filters
- Fetch complete Q&A threads (question + all answers) as clean markdown in one call
- Bodies require `filter=withbody` — baked in; not exposed as a parameter
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

**Backoff tracking:** The service holds a module-level `backoffUntil: number` timestamp. Before each request, if `Date.now() < backoffUntil`, the service waits the remaining duration. After each response, if `backoff` appears in the JSON wrapper, `backoffUntil = Date.now() + backoff * 1000`. This is per-process (acceptable for server-side use).

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
| 1 | `GET /questions/{id}?filter=withbody&site={site}` | Question body + metadata |
| 2 | `GET /questions/{id}/answers?filter=withbody&site={site}&pagesize=N&sort=votes` | All answers with bodies |

Both are parallelized via `Promise.all`. After fetching, the service sorts answers: accepted first (matched via `question.accepted_answer_id`), then by score descending. Each body is normalized from HTML to markdown by `html-normalizer`. Attribution is appended to each answer block.

`stackexchange_get_user` — 2 upstream calls (parallelized):

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /users/{id}?site={site}` | Profile: reputation, badge counts, display name, location, account metadata |
| 2 | `GET /users/{id}/top-tags?site={site}&pagesize=10` | Top tags by answer score (separate endpoint — not included in the main user profile response) |

Both are parallelized via `Promise.all`. If `top-tags` returns empty (new user, no answers), the tool still returns the profile — `topTags` is an empty array. If either call returns empty `items[]`, the tool throws `user_not_found`.

---

## Design Decisions

**No HTML→markdown library dependency.** SE post bodies use a predictable, limited HTML tag set (`<p>`, `<pre><code>`, `<strong>`, `<em>`, `<a>`, `<ul>`, `<ol>`, `<li>`, `<h1>`-`<h6>`, `<blockquote>`, `<code>` inline). A custom normalizer covers this in ~80 lines with no peer dependency. The framework's `HtmlExtractor` (defuddle + linkedom) is designed for full web pages and adds unnecessary complexity for fragments; `turndown` would work but adds a dep for a task this small.

**`filter=withbody` is always set, never exposed.** The filter is an implementation detail the user should never need to think about. Exposing it would confuse and could produce broken calls (bodies omitted = useless output).

**Accepted-answer-first ordering is hardcoded, not configurable.** The "accepted answer first" ordering is the single correct answer to "what's the best answer here?" — it's the SO community's explicit signal, not a preference. Making it optional would introduce noise for no gain.

**`list_sites` uses local filter, not upstream search.** The full SE network has ~190 sites — a bounded, rarely-changing list. One fetch (or a few pages) retrieves them all. Client-side `nameContains` filtering is appropriate here; there's no upstream search for sites.

**No resources.** SE content is dynamic (votes change, new answers appear). The tool surface is self-sufficient for all tool-only agents.

**`stackexchange_get_user` is a lightweight add.** The user tool is useful primarily for credibility context on an answer author. It doesn't justify its own dedicated tool chain but rounds out the surface — `get_thread` surfaces `owner.user_id`, and `get_user` then resolves the author without a separate search.

**Quote limit exposed in enrichment.** The `quota_remaining` and `quota_max` fields from every SE response are surfaced via `ctx.enrich.notice()` so agents can plan around rate limits without the server needing to fail.

---

## API Reference

**Base URL:** `https://api.stackexchange.com/2.3`

**Key parameters:**
- `site` — required on most endpoints; value is `api_site_parameter` from `/sites` (e.g., `stackoverflow`, `superuser`, `serverfault`)
- `filter=withbody` — required to receive `body` field on questions and answers; absent by default
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
  "backoff": 10  // optional — seconds to wait before next request
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
- Without `filter=withbody`, `body` is absent from both endpoints
- `/tags/{tag}/faq` returns question list without bodies (expected; use `get_thread` for bodies)
- `/users/{id}` returns user profile with badge counts, reputation, but no answer list (separate `/users/{id}/top-tags`)
- Error envelope confirmed: `{ error_id, error_message, error_name }` for bad `site` param
- Keyless quota: 300/day per IP (`quota_max: 300` in every response)
- Responses are gzip-encoded — `Accept-Encoding: gzip` or `curl --compressed` required
- No `backoff` field observed in test calls (appears only when the API throttles)

---

## Known Limitations

- **~300 req/day keyless.** Agents doing broad research will hit this quickly. The `STACKEXCHANGE_API_KEY` env var lifts this to ~10,000/day without any user OAuth flow; the README should make this prominent.
- **Bodies are HTML, not Markdown.** The SE API does not provide a markdown output format. The normalizer handles SE's known tag set; edge cases (MathJax, custom SE rendering plugins, obscure HTML constructs in older posts) may produce imperfect output.
- **No cross-site search.** The SE API requires a `site` parameter; there is no "search all sites at once" endpoint. The `list_sites` tool lets agents enumerate and search each site separately.
- **Answer pagination.** Very popular questions can have hundreds of answers. The `get_thread` tool caps at `max_answers` (default 10) to stay within context budgets; a `page` parameter allows pagination but won't be in v0.1.0.
