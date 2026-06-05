---
name: stackexchange-mcp-server
description: "Stack Overflow and the wider Stack Exchange network — search and read full Q&A threads as clean markdown, accepted answer first, code blocks intact."
version: 0.0.0
status: idea
category: developer-tooling
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/stackexchange-mcp-server"
created: 2026-05-30
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
mirror: "not viable as full mirror — SE data dump is tens of GB (SO alone); use HTTP cache + respect the API backoff field instead."
pattern: multi-endpoint single-source (HTML→markdown normalization)
complexity: low-medium
api-deps: Stack Exchange API v2.3
api-cost: free (keyless ~300 req/day per IP; a registered key — no OAuth — lifts to 10k/day)
hostable: true
composes-with: package-intel-mcp-server, nist-nvd-mcp-server, hn-mcp-server
---

# stackexchange-mcp-server

Search and read the Stack Exchange network — Stack Overflow plus Super User, Server Fault, Ask Ubuntu, Unix & Linux, Math, DBA, and the rest — and get full Q&A threads back as clean markdown with the accepted answer first and code blocks preserved. Read-only, no user auth.

The workflow isn't "query the SE API" — it's "find the answer to this and read it." The raw API makes that surprisingly painful: answer and question bodies come back as **HTML**, and you only get bodies at all if you construct the right `filter` (an opaque, arcane part of the API). Agents naively hitting it burn calls discovering filters and tokens parsing HTML. The server bakes in the body filter, strips HTML to markdown with fenced code intact, and ranks the thread so the agent reads a resolved answer, not a DOM.

**Audience:** Every developer. Stack Overflow is the single most-referenced programming knowledge base, and agents reach for it constantly when debugging — but the API is awkward enough that most don't parse it well. High agent-operator demand even relative to the (already huge) general dev population.

## User Goals

- Search Q&A for a programming problem or error across a Stack Exchange site
- Read a question with its accepted + top answers as clean markdown, code blocks intact
- Find the canonical accepted answer for an error message
- Pull the highest-voted answered questions for a tag (e.g. `[rust]`, `[kubernetes]`)
- Check an answer author's credibility (reputation, top tags)
- Search across the whole network, not just Stack Overflow

## API Surface

Stack Exchange API v2.3, single source covering the entire network via a `site` parameter. Read endpoints need no OAuth; a registered key (no user auth) raises the per-IP quota from ~300/day to 10k/day. Bodies require a constructed `filter`; responses carry a `backoff` field the service layer must respect.

| Endpoint | Purpose |
|:---------|:--------|
| `/search/advanced` | Full-text Q&A search with tag/score/accepted/sort filters |
| `/questions/{ids}` | Question records (with a body filter) |
| `/questions/{id}/answers` | Answers for a question (with a body filter) |
| `/tags/{tag}/faq` | Top answered questions for a tag |
| `/users/{ids}` | User profile, reputation, top tags |
| `/sites` | Enumerate the network's sites and their `site` params |

## Tool Surface (sketch)

```
stackexchange_search_questions — full-text search across a Stack Exchange site (default
                                 stackoverflow). Filters: tags, site, accepted-only,
                                 min-score, sort (relevance|votes|activity|newest).
                                 Returns ranked questions: title, score, answer count,
                                 is_answered / has_accepted, tags, link, excerpt. The
                                 entry point — SE keys on integer question IDs.

stackexchange_get_thread    — the flagship. Question id or SE question URL (+ site) →
                              the full resolved thread: question body and all answers,
                              accepted answer first then by score, HTML rendered to
                              clean markdown with fenced code blocks preserved,
                              comments optional. One call replaces fetch-question +
                              fetch-answers + HTML-strip + rank, and bakes in the API
                              filter needed to return bodies at all. Accepts a bare
                              integer id or a full stackoverflow.com/questions/…/…
                              URL so agents can pass pasted links directly.

stackexchange_get_tag_faq   — highest-voted answered questions for a tag (e.g.
                              [rust], [kubernetes]) on a site, over an optional time
                              window. Maps to /tags/{tag}/faq. The "show me the
                              canonical answers in X" tool.

stackexchange_get_user      — user profile by id (+ site): reputation, top tags, and
                              highest-scored answers. Credibility context for an
                              answer's author; lighter-weight, optional in most flows.

stackexchange_list_sites    — enumerate the Stack Exchange network sites
                              (stackoverflow, superuser, serverfault, unix, math, …)
                              with their api site params. Discovery for cross-site
                              search.
```

## Design Notes

- **The moat is HTML→markdown + filter handling, not the endpoint set.** Raw SE returns answer bodies only when you pass a constructed `filter`, and those bodies are HTML. The server bakes the right filter and renders to markdown with code fences intact — that's the whole reason this beats a curl.
- **Whole network, not just SO.** `site` defaults to `stackoverflow`; Super User, Server Fault, Ask Ubuntu, Unix & Linux, Math, DBA, etc. are all reachable through one surface. `stackexchange_list_sites` exposes the catalog.
- **CC BY-SA content** — output must carry attribution (author + canonical link) per the license. Put it in the tool output metadata, same as TMDB's attribution requirement.
- **No fabricated ranking.** Surface real score and the accepted flag; never synthesize a "confidence" or "quality" number. The accepted-answer-first ordering is the honest signal.
- **Respect `backoff`.** Some responses carry a `backoff` seconds field — the service layer must honor it or the IP gets throttled. Cache aggressively; accepted answers are effectively static.
- Optional key (no OAuth) bumps quota 300/day → 10k/day; document it as an env var, work without it.
- Composes with `package-intel` (a flagged dependency → its SO discussions), `nist-nvd` (CVE → community remediation threads), `hn` (the other developer-discussion corpus).
- README one-liner: "Search and read Stack Overflow and the wider Stack Exchange network — full Q&A threads as clean markdown, accepted answer first, code blocks intact."
