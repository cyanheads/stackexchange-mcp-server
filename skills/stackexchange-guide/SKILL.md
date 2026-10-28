---
name: stackexchange-guide
description: Find, read, and cite Stack Overflow and other Stack Exchange answers with the stackexchange_* tools — resolving site and IDs from URLs, search syntax for error messages and tags, choosing which answer to trust, vetting an author, and budgeting the daily API quota. Use when answering from Stack Exchange content, quoting an answer, or checking who wrote one.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Live, read-only Stack Exchange API v2.3 across the network: Stack Overflow, Super User, Server Fault, Unix & Linux, Mathematics, TeX, and the rest. Question search, full threads with answers and optional comments, a tag's FAQ list, and user profiles. Every call targets one site; there is no network-wide search, so a question that could live on several sites takes one search per site.

Reach for it for community answers: error messages, how-to and practice questions, what a tag's community treats as canonical. Not for official documentation or changelogs, not for behavior newer than the answers you find, and not for anything outside the Stack Exchange network.

## Identifiers

Every ID is scoped to its site. The same number on another site is a different post or account, or nothing, so carry the site alongside every ID.

| Identifier | Where it comes from |
|:--|:--|
| site | `api_site_parameter` from stackexchange_list_sites, or the host of a Stack Exchange URL passed as-is (`unix.stackexchange.com`), which skips the list call |
| question ID | Search and tag FAQ results, or the number after `/questions/` in a URL |
| answer ID | Answers in stackexchange_get_thread; its permalink is `https://<site host>/a/<answerId>` |
| user ID | `authorUserId` on a thread's question and answers. Comments carry only `authorLink`, whose path is `/users/<id>/<name>`. Deleted and anonymous authors have no ID and cannot be looked up |
| tag | `tags` on any question, or a user's `topTags`. stackexchange_get_tag_faq resolves a tag synonym (`js` → `javascript`) |

## Gates

- **A question URL carries its site; a bare ID does not.** Pass a full URL to stackexchange_get_thread and leave `site` out: the question is read from the URL's host. A `site` naming a different site is ignored; a URL whose host is not a Stack Exchange site, such as a translation proxy, is read from `site` when you pass one and fails with `invalid_site` when you don't. `siteConflict` in the response says which of the two was used. A bare question ID is read from `site`, which defaults to `stackoverflow`, so an ID from any other site needs its `site`; without it the call returns an unrelated question, or `question_not_found`.
- **Look a user up on the site they posted on.** A Stack Overflow user ID sent with another site returns `user_not_found` or a different account.
- **Don't present `answers[0]` as the top answer.** The accepted answer comes first because the asker chose it; the rest follow by score, so a higher-voted answer can sit below it. Compare scores and dates, and say which one you are quoting: accepted, highest-voted, or both.
- **Check dates before relaying advice.** Every question and answer carries `creationDate` and `lastActivityDate`. When an answer predates the version the user is on, fetch the thread with comments, where corrections usually land, before relying on it.
- **Attribute what you quote.** Content is CC BY-SA 4.0: name the author and link the post, using the answer permalink above or the question `link`.
- **Closed and duplicate status is not reported.** A search hit can be a question closed as a duplicate of the real canonical, and its answers still come back normally. When a hit looks thin, look for the canonical in the tag FAQ.

## Quota

Without a key the API allows 300 requests a day per IP address, shared with every other client on that address (on a hosted deployment, every user of it); a key raises it to about 10,000. Every response reports `quotaRemaining`. Requests per tool call:

| Call | Requests |
|:--|:--|
| stackexchange_search_questions, stackexchange_get_tag_faq | 1 per page |
| stackexchange_get_thread | 2, +1 when the accepted answer falls outside `maxAnswers`, +2 with comments (+1 when the question has no answers), +1 when a URL's host is not a Stack Exchange site and `site` is given |
| stackexchange_get_user | 2 |
| stackexchange_list_sites | 1 per 100 network sites, about 4 per call |

Skip stackexchange_list_sites whenever a URL or a known `api_site_parameter` gives you the site. An answer's `authorReputation` comes with the thread, so call stackexchange_get_user only when you need top tags, badges, or activity dates.

Separately from the daily quota, Stack Exchange throttles an IP address that sends requests too fast. A call rejected with reason `throttled` carries `retryAfter`: wait that many seconds before calling any stackexchange_* tool again. A call made inside the window waits it out when the window fits the call's 50-second budget and fails at once when it does not. A wait of hours means the address's daily quota is spent. Reason `pacer_shed` means the call would have waited in the server's queue past its time budget; wait its `retryAfter` the same way. The server already sends one request at a time and honors Stack Exchange's backoff, so parallel calls finish no sooner.

## Search syntax

stackexchange_search_questions matches its query against questions with an algorithm Stack Exchange does not document. Observed behavior:

- `[tag]` inside the query filters by that tag, the same as the tags filter. Several `[a] [b]` tokens, or several tags, require all of them; for either-or, run one search per tag.
- Results are questions only; answer text is read through stackexchange_get_thread.
- A verbatim error message under the default relevance sort returns the questions whose wording is closest, mostly zero-score and tied to someone's specific code. For an error, drop the app-specific parts (variable names, paths, line numbers), add the language or framework tag, sort by votes or set a minimum score, then judge hits by score, answer count, and whether they are answered.
- Every response reports `appliedSort`, the order Stack Exchange used. A minimum score forces vote order whatever `sort` asked for, and `sortOverrideReason` appears whenever that replaced the requested sort. When results look out of order, read both before re-issuing the same call.

## Workflows

**Error message → quotable answer.** Search as above → open the highest-scored relevant hit with stackexchange_get_thread on the same site → compare the accepted and the highest-voted answers and their dates, adding comments when the answer predates the user's version → quote with attribution.

**Accepted practice on a niche site.** Resolve the site from a URL host, or stackexchange_list_sites with a name filter → stackexchange_get_tag_faq for the topic's tag → search with that tag for the specific question → read the strongest threads. The tag FAQ is Stack Exchange's own "frequently asked" selection, not a score ranking; compare scores yourself.

**Is this answerer credible?** `authorUserId` from the thread → stackexchange_get_user on the same site. Reputation counts on that site only; check whether the thread's tags appear in `topTags` with real answer score, and read `lastAccessDate` before expecting the author to respond to anything.

**Survey a tag before asking.** stackexchange_get_tag_faq for the tag → open the threads whose titles match the problem → search with the tag and key terms, accepted answers only, to find solved variants.
