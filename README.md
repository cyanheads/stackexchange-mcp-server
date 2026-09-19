<div align="center">
  <h1>@cyanheads/stackexchange-mcp-server</h1>
  <p><b>Search Stack Exchange questions, fetch complete Q&A threads as clean markdown, browse tag FAQs, and look up user profiles via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.15-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/stackexchange-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/stackexchange-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/stackexchange-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/stackexchange-mcp-server/releases/latest/download/stackexchange-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=stackexchange-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc3RhY2tleGNoYW5nZS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22stackexchange-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fstackexchange-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://stackexchange.caseyjhand.com/mcp](https://stackexchange.caseyjhand.com/mcp)

</div>

---

## Overview

Stack Exchange network access — Stack Overflow, Super User, Server Fault, Unix & Linux, and the wider network. Search questions, fetch complete Q&A threads as clean markdown, browse tag FAQs, and look up user profiles from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `stackexchange_search_questions` | Search questions across a Stack Exchange site with full-text query, tag filters, score threshold, and sort order |
| `stackexchange_get_thread` | Fetch a question and its answers as markdown, with a configurable answer limit and the accepted answer first |
| `stackexchange_get_tag_faq` | Fetch the highest-voted answered questions for a tag — the canonical "best answers in X" list |
| `stackexchange_get_user` | Fetch a user profile by ID: reputation, badge counts, top tags by answer score, and account metadata |
| `stackexchange_list_sites` | Enumerate all Stack Exchange network sites and their `api_site_parameter` values |

---

## Capability reference

### `stackexchange_search_questions` <sub>tool</sub>

- Full-text query with optional tag filters, minimum score threshold, and accepted-only filter; sort by relevance (default), votes, activity, or newest
- Up to 30 results per page (default 10); `page` for more — each page costs one API quota unit, and paging past 25 requires `STACKEXCHANGE_API_KEY`
- Returns question ID, title, score, answer count, tags, and a ~300-character excerpt — IDs flow directly into `stackexchange_get_thread`
- Quota remaining and max surfaced via enrichment on every response

---

### `stackexchange_get_thread` <sub>tool</sub>

- Accepts a numeric question ID or a full Stack Exchange question URL; fetches the question and a page of `maxAnswers` answers (1–100, default 10), adding the accepted answer if it falls outside that page
- HTML→markdown normalization built in — code blocks, links, lists, headers, and blockquotes all converted
- Optional `includeComments` fetches up to 20 comments per post, newest first, using two extra API calls (one when there are no answers); `commentsTruncated` reports partial lists
- Attribution (author name, profile link, score) on every answer per CC BY-SA 4.0
- Quota remaining and max surfaced via enrichment; `truncated` when more answers exist upstream than `maxAnswers` returned

---

### `stackexchange_get_tag_faq` <sub>tool</sub>

- Highest-voted answered questions for a tag — maps to `/tags/{tag}/faq`, the canonical "best answers in X" list
- Up to 30 results per page (default 10); `page` for more — each page costs one API quota unit, and paging past 25 requires `STACKEXCHANGE_API_KEY`
- Returns a question list without bodies; pipe any `questionId` into `stackexchange_get_thread` for full content
- Quota remaining and max surfaced via enrichment on every response

---

### `stackexchange_get_user` <sub>tool</sub>

- `userId` must be at most 2,147,483,647 (32-bit) — typically the `authorUserId` from `stackexchange_get_thread` output
- Fetches the profile and top tags in two upstream API calls
- Returns reputation, badge counts (gold/silver/bronze), location, website, answer/question counts, and up to 10 top tags by answer score (empty array for users with no answers)
- An unknown user ID returns a typed `user_not_found` error — Stack Exchange answers HTTP 200 with empty results rather than 404

---

### `stackexchange_list_sites` <sub>tool</sub>

- Fetches every site in the Stack Exchange network, walking pages of 100 up to a 10-page cap; an enrichment notice flags a partial list if the network still has more
- Optional case-insensitive name filter matches against site name and `api_site_parameter`, applied client-side after the fetch
- Returns the `api_site_parameter` value (e.g. `stackoverflow`, `superuser`, `serverfault`) that every other tool's `site` parameter accepts

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Stack Exchange-specific:

- HTML→markdown conversion preserves code blocks, tables, links, images, and nested lists
- Shared upstream queue honors response backoff and HTTP 429 cooldowns; each operation has a 50-second budget covering queue time, backoff, requests, and retries
- Quota logging: `quota_remaining` and `quota_max` surfaced via enrichment on every tool call
- Typed error contracts on every tool — `invalid_site`, `invalid_parameter`, `invalid_api_key`, `invalid_id_or_url`, `invalid_user_id`, `question_not_found`, `user_not_found`, `paging_depth_limit`, `quota_exceeded`, and `upstream_unavailable`
- Optional `STACKEXCHANGE_API_KEY` lifts the per-IP quota from ~300/day to ~10,000/day with no OAuth required

Agent-friendly output:

- Quota remaining on every response — agents can plan around rate limits without the server needing to fail
- The accepted answer appears first, followed by the remaining answers sorted by score
- Each answer includes attribution under CC BY-SA 4.0
- Typed `not_found` errors for missing questions and users (SE returns HTTP 200 with empty `items[]` rather than 404)

---

## Getting started

### Public Hosted Instance

A public instance is available at `https://stackexchange.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "stackexchange-mcp-server": {
      "type": "streamable-http",
      "url": "https://stackexchange.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "stackexchange": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/stackexchange-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "stackexchange": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/stackexchange-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "stackexchange": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/stackexchange-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

**Rate limits:** The Stack Exchange API allows ~300 requests/day per IP without a key. Set `STACKEXCHANGE_API_KEY` in `env` to lift this to ~10,000/day. Register a key at [stackapps.com/apps/oauth/register](https://stackapps.com/apps/oauth/register) (the OAuth flow is only required for write access — a key alone is sufficient for read-only use).

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+)
- A `STACKEXCHANGE_API_KEY` is optional but strongly recommended for any sustained use

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/stackexchange-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd stackexchange-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set STACKEXCHANGE_API_KEY if desired
```

---

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `STACKEXCHANGE_API_KEY` | Optional. Stack Exchange API key — lifts per-IP quota from ~300/day to ~10,000/day. | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_HTTP_HOST` | Host for HTTP server. | `127.0.0.1` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. `auto` resolves to stateful. A meaningful env value overrides this server's stateless source default; blank or unsubstituted placeholders use the source default. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t stackexchange-mcp-server .
docker run --rm -e STACKEXCHANGE_API_KEY=your-key -p 3010:3010 stackexchange-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/stackexchange-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Path | Purpose |
|:-----|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config/` | Server-specific environment variable parsing with Zod (`STACKEXCHANGE_API_KEY`). |
| `src/mcp-server/tools/` | Tool definitions (`*.tool.ts`). |
| `src/services/stackexchange/` | Stack Exchange API v2.3 HTTP client, backoff tracking, quota logging, HTML→markdown normalizer. |
| `tests/` | Vitest unit and integration tests. |
| `docs/` | Design document and directory tree. |

---

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

---

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
