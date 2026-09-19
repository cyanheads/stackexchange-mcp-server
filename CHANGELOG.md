# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.15](changelog/0.1.x/0.1.15.md) — 2026-09-19

Bounded Stack Exchange requests, safer markdown tables, and the mcp-ts-core 0.13.6 runtime adoption.

## [0.1.14](changelog/0.1.x/0.1.14.md) — 2026-09-09

Reference-style links, definition lines, and blockquote markers no longer survive into search excerpts as literal text

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-09-09

Search excerpts, result paging, opt-in thread comments, and declared error contracts for site listing and unrecognized API keys

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-09-09

Full site pagination, wired recovery hints, populated user counts, and post dates across search, thread, tag-FAQ, and user outputs

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-09-09

HTML→markdown normalizer rewritten to stop losing escaped brackets, doubled entities, linked bold/italic text, and table/image content

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-08-22

MCP SDK v2 adds 2026-07-28 client support and strict inputs; Stack Exchange requests now have a 30-second whole-exchange timeout

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-07-16

search_questions, get_tag_faq, and get_thread now flag truncated only on genuine capping; get_thread also merges in an out-of-page accepted answer and surfaces answerCount (#7, #11)

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-07-16

search_questions: 'newest' sort now translates to SE's 'creation', and minScore forces sort=votes instead of erroring under the default relevance sort (#6, #10)

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-07-16

HTML-normalization fixes for non-BMP entities, SE code-block language capture, and author/location decoding (#8, #9, #12); mcp-ts-core ^0.10.9 → ^0.10.14 with Socket scanner supply-chain hardening

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-20

Framework maintenance: mcp-ts-core ^0.10.9 — new check-dependency-specifiers devcheck step, plugin-manifest packaging checks, fresh-scaffold devcheck guards, ctx.content skill sync; dev-dep refresh

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-12

Framework adoption (mcp-ts-core ^0.10.6); validationError reclassification for invalid_site/invalid_id_or_url; truncation enrichment on search/thread/FAQ; MCPB bundle cleaner and Docker healthcheck

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-06

HTML entity decoding in question titles, out-of-range ID error classification, authorUserId field alignment, and empty-result notices in structuredContent

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-06

Public hosted endpoint registered — server.json remotes + README hosted instance docs

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-05

CC BY-SA attribution added to search and tag-FAQ output for license compliance

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-05 · 🛡️ Security

Initial public release — 5 Stack Exchange tools covering question search, Q&A threads, tag FAQs, user profiles, and site discovery; error bodies stripped from service errors
