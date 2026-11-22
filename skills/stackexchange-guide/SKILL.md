---
name: stackexchange-guide
description: Find, read, and cite Stack Overflow and other Stack Exchange answers with the stackexchange_* tools — resolving site and IDs from URLs, search syntax for error messages and tags, choosing which answer to trust, vetting an author, and budgeting the daily API quota. Use when answering from Stack Exchange content, quoting an answer, or checking who wrote one.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.1"
---

## Scope

Live, read-only Stack Exchange API v2.3 across the network: Stack Overflow, Super User, Server Fault, Unix & Linux, Mathematics, TeX, and the rest. Question search, full threads with answers and optional comments, a tag's FAQ list, and user profiles. Every call targets one site; there is no network-wide search, so a question that could live on several sites takes one search per site.

Reach for it for community answers: error messages, how-to and practice questions, what a tag's community treats as canonical. Not for official documentation or changelogs, not for behavior newer than the answers you find, and not for anything outside the Stack Exchange network.

## Identifiers

Every ID is scoped to its site. The same number on another site is a different post or account, or nothing, so carry the site alongside every ID.

| Identifier | Where it comes from |
|:--|:--|
| site | `apiSiteParameter` from `stackexchange_list_sites`, or the host of a Stack Exchange URL passed as-is (`unix.stackexchange.com`), which skips the list call |
| question ID | Search and tag FAQ rows, a thread’s `duplicateOf` entries, or the number after `/questions/` or `/q/` in a URL |
| answer ID | Answers in `stackexchange_get_thread`. Pass `https://<site host>/a/<answerId>` directly to read the parent question and the linked answer |
| user ID | `authorUserId` on a thread's question and answers. Comments carry only `authorLink`, whose path is `/users/<id>/<name>`. Deleted and anonymous authors have no ID and cannot be looked up |
| tag | `tags` on any question, or a user's `topTags`. stackexchange_get_tag_faq resolves a tag synonym (`js` → `javascript`) |

## Gates

- **A question URL carries its site; a bare ID does not.** Pass a full URL to stackexchange_get_thread and leave `site` out: the question is read from the URL's host. A `site` naming a different site is ignored; a URL whose host is not a Stack Exchange site, such as a translation proxy, is read from `site` when you pass one and fails with `invalid_site` when you don't. `siteConflict` in the response says which of the two was used. A bare question ID is read from `site`, which defaults to `stackoverflow`, so an ID from any other site needs its `site`; without it the call returns an unrelated question, or `question_not_found`.
- **Look a user up on the site they posted on.** A Stack Overflow user ID sent with another site returns `user_not_found` or a different account.
- **Don't present `answers[0]` as the top answer.** The accepted answer comes first because the asker chose it; the rest follow by score, so a higher-voted answer can sit below it. Compare scores and dates, and say which one you are quoting: accepted, highest-voted, or both.
- **Check dates before relaying advice.** Every question and answer carries `creationDate` and `lastActivityDate`. When an answer predates the version the user is on, fetch the thread with comments, where corrections usually land, before relying on it.
- **Attribute what you quote.** Content is CC BY-SA 4.0: name the author and link the post, using the answer permalink above or the question `link`.
- **Follow a duplicate to its originals.** Open the closed question with `stackexchange_get_thread`. Pass each `duplicateOf[].questionId` back with the same `site` to read and attribute the original answers.

## Quota

Without a key the API allows 300 requests a day per IP address, shared with every other client on that address (on a hosted deployment, every user of it); a key raises it to about 10,000. Every response reports `quotaRemaining`. Requests per tool call:

| Call | Requests |
|:--|:--|
| stackexchange_search_questions, stackexchange_get_tag_faq | 1 per page |
| stackexchange_get_thread | One question request and one answers page. A short answer link first resolves its answer. A missing accepted answer on page 1 or a linked answer outside the page can require an additional lookup. Comments add a question request and one request per answer-ID batch |
| stackexchange_get_user | 2 |
| stackexchange_list_sites | 1 per 100 network sites, about 4 per call |

Skip stackexchange_list_sites whenever a URL or a known `apiSiteParameter` gives you the site. An answer's `authorReputation` comes with the thread, so call stackexchange_get_user only when you need top tags, badges, or activity dates.

Stack Exchange can ask the server to wait before calling one API method again. Other methods can still run. HTTP 429 and `throttle_violation` apply across methods. For `throttled` or `pacer_shed`, wait the `retryAfter` seconds shown before retrying the call.

## Search syntax

stackexchange_search_questions matches its query against questions with an algorithm Stack Exchange does not document. Observed behavior:

- `[tag]` inside the query filters by that tag, the same as the tags filter. Several `[a] [b]` tokens, or several tags, require all of them; for either-or, run one search per tag.
- Use `closed:yes` or `closed:no` in the query to narrow by closure status. A blank query browses with any supplied tags, score or accepted-answer filter.
- A verbatim error message under the default relevance sort returns the questions whose wording is closest, mostly zero-score and tied to someone's specific code. For an error, drop the app-specific parts (variable names, paths, line numbers), add the language or framework tag, sort by votes or set a minimum score, then judge hits by score, answer count, and whether they are answered.
- Every response reports `appliedSort`, the order Stack Exchange used. A minimum score forces vote order whatever `sort` asked for, and `sortOverrideReason` appears whenever that replaced the requested sort. When results look out of order, read both before re-issuing the same call.

## Workflows

**Error message → quotable answer.** Search as above → open the highest-scored relevant hit with stackexchange_get_thread on the same site → compare the accepted and the highest-voted answers and their dates, adding comments when the answer predates the user's version → quote with attribution.

**Accepted practice on a niche site.** Pass a known host as `site`, or find the community with an audience term such as `statistics` in `stackexchange_list_sites`. Add the standalone token `meta` to include community discussion sites. Fetch the topic’s tag FAQ and compare scores before opening a thread.

**Is this answerer credible?** `authorUserId` from the thread → stackexchange_get_user on the same site. Reputation counts on that site only; check whether the thread's tags appear in `topTags` with real answer score, and read `lastAccessDate` before expecting the author to respond to anything.

**Read beyond the first page.** Pass `nextAnswersPage` as `answersPage` and keep `maxAnswers` fixed. For comments, either `nextQuestionCommentsPage` or `nextAnswerCommentsPage` gives the next `commentsPage` to request. Keep the original link, `answersPage`, and `maxAnswers` fixed while reading those comments. An answer with no comment on this page may have comments on another. Paging past 25 requires `STACKEXCHANGE_API_KEY`.

**Survey a tag before asking.** Fetch the tag FAQ, open threads whose titles match the problem, and search with the tag and key terms for solved variants.
