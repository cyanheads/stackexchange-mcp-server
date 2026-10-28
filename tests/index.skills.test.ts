/**
 * @fileoverview Wire test for the published skill tree: launches the server
 * entry over stdio from an unrelated working directory and reads the
 * `stackexchange-guide` skill back through the SEP-2640 Skills extension, so
 * the `skills` option in `src/index.ts`, the application-root resolution of
 * `skills/`, and the SDK's acceptance of the SKILL.md are covered together.
 * No tool is called, so no request reaches Stack Exchange.
 * @module tests/index.skills.test
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface Reply {
  error?: { code: number; message: string };
  result?: Record<string, unknown>;
}

const PROJECT_ROOT = new URL('..', import.meta.url).pathname;
const ENTRY = join(PROJECT_ROOT, 'src/index.ts');
const SKILL_PATH = join(PROJECT_ROOT, 'skills/stackexchange-guide/SKILL.md');
const SKILL_URI = 'skill://stackexchange-guide/SKILL.md';
const REPLY_TIMEOUT_MS = 15_000;

/** Bun runs the TypeScript entry and its `@/` aliases directly; Node cannot. */
const BUN = process.versions.bun ? process.execPath : 'bun';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'stackexchange-skills-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Spawns the entry over stdio from `scratch`, sends `initialize` and then each
 * request in order, and returns the replies. The child is killed by its own
 * PID if it outlives the session.
 */
async function stdioSession(requests: Array<{ method: string; params?: Record<string, unknown> }>) {
  const child = spawn(BUN, [ENTRY], {
    cwd: scratch,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith('MCP_') &&
            !key.startsWith('OTEL_') &&
            key !== 'LOGS_DIR' &&
            key !== 'STACKEXCHANGE_API_KEY',
        ),
      ),
      MCP_TRANSPORT_TYPE: 'stdio',
      LOGS_DIR: join(scratch, 'logs'),
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stderr = '';
  let buffered = '';
  const waiters = new Map<number, (reply: Reply) => void>();
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at !== -1; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Reply & { id?: unknown };
      if (typeof message.id === 'number') waiters.get(message.id)?.(message);
    }
  });
  const exited = new Promise<void>((settle) => child.once('exit', () => settle()));

  const request = (id: number, method: string, params: Record<string, unknown> = {}) =>
    new Promise<Reply>((settle, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No reply to ${method}:\n${stderr}`)),
        REPLY_TIMEOUT_MS,
      );
      waiters.set(id, (reply) => {
        clearTimeout(timer);
        settle(reply);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    const initialize = await request(0, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'stackexchange-skills-test', version: '0.0.0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const replies: Reply[] = [];
    for (const [index, { method, params }] of requests.entries()) {
      replies.push(await request(index + 1, method, params));
    }
    child.stdin.end();
    await Promise.race([exited, new Promise((settle) => setTimeout(settle, 10_000))]);
    return { initialize, replies };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

describe('published skills', () => {
  it('serves stackexchange-guide over MCP from the application root', async () => {
    const { initialize, replies } = await stdioSession([
      { method: 'skills/list' },
      { method: 'resources/read', params: { uri: SKILL_URI } },
    ]);
    const [list, read] = replies;

    expect(initialize.result?.capabilities).toHaveProperty([
      'extensions',
      'io.modelcontextprotocol/skills',
    ]);

    const skills = list?.result?.skills as Array<{ uri: string }> | undefined;
    expect(skills?.map((skill) => skill.uri)).toEqual([SKILL_URI]);

    const contents = read?.result?.contents as Array<{ uri: string; text?: string }> | undefined;
    expect(contents?.[0]?.text).toBe(readFileSync(SKILL_PATH, 'utf8'));
  }, 45_000);
});
