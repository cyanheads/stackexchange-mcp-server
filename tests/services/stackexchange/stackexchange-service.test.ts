/**
 * @fileoverview Service-layer tests for StackExchangeService entity decoding.
 * The tool tests mock getStackExchangeService wholesale with pre-normalized
 * fixtures, so they cannot catch a decode regression inside getThread/getUser.
 * These exercise the real service methods against a mocked fetch returning raw,
 * entity-encoded upstream payloads.
 * @module tests/services/stackexchange/stackexchange-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StackExchangeService } from '@/services/stackexchange/stackexchange-service.js';

/**
 * The constructor retains only apiKey — config/storage are unused — so minimal
 * stand-ins suffice to exercise the domain methods.
 */
const makeService = () => new StackExchangeService({} as AppConfig, {} as StorageService);

/** A 200 OK Response whose body is the given SE wrapper serialized to JSON. */
const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StackExchangeService entity decoding', () => {
  it('getUser decodes HTML entities in displayName and location', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/top-tags')) {
        return jsonResponse({ items: [], has_more: false, quota_remaining: 100, quota_max: 300 });
      }
      return jsonResponse({
        items: [
          {
            user_id: 1946,
            display_name: 'Tom &amp; Jerry',
            link: 'https://stackoverflow.com/users/1946',
            reputation: 5000,
            location: 'S&#227;o Paulo',
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const svc = makeService();
    const { user } = await svc.getUser(
      { site: 'stackoverflow', userId: 1946 },
      createMockContext(),
    );

    expect(user.displayName).toBe('Tom & Jerry');
    expect(user.location).toBe('São Paulo');
  });

  it('getThread decodes HTML entities in question and answer author names', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/answers')) {
        return jsonResponse({
          items: [
            {
              answer_id: 2,
              question_id: 1,
              score: 10,
              is_accepted: true,
              body: '<p>Answer body.</p>',
              owner: { display_name: 'Fl&#225;vio Amieiro', user_id: 20 },
            },
          ],
          has_more: false,
          quota_remaining: 100,
          quota_max: 300,
        });
      }
      return jsonResponse({
        items: [
          {
            question_id: 1,
            title: 'A question',
            link: 'https://stackoverflow.com/q/1',
            score: 5,
            answer_count: 1,
            is_answered: true,
            tags: ['c'],
            body: '<p>Question body.</p>',
            owner: { display_name: 'Jesper R&#248;nn-Jensen', user_id: 10 },
          },
        ],
        has_more: false,
        quota_remaining: 100,
        quota_max: 300,
      });
    });

    const svc = makeService();
    const { thread } = await svc.getThread(
      { site: 'stackoverflow', questionId: 1 },
      createMockContext(),
    );

    expect(thread.authorName).toBe('Jesper Rønn-Jensen');
    expect(thread.answers[0]?.authorName).toBe('Flávio Amieiro');
  });
});
