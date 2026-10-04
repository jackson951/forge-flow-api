import { EgressPolicy } from '../../../infrastructure/egress/egress-policy';
import {
  backoffMs,
  cursorFrom,
  extractItems,
  itemIdentity,
  MAX_SEEN_IDS,
  newItems,
  pollConfigHash,
  PollDataError,
  rememberIds,
} from './http-poll';
import { httpNodeTypes, httpPollConfigSchema } from './http.node-types';

const policy: EgressPolicy = {
  allowPlainHttp: false,
  allowPrivateNetworks: false,
  deniedPorts: [],
  deniedHosts: [],
};
const schema = httpPollConfigSchema(policy, 5);
const base = {
  request: { url: 'https://api.example.com/items' },
  schedule: { kind: 'interval', timezone: 'UTC', everyMinutes: 15 },
};
const messages = (config: object) => {
  const r = schema.safeParse(config);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('http.poll (Part 24, FR-24.16)', () => {
  describe('config', () => {
    it('applies defaults', () => {
      expect(schema.parse(base)).toMatchObject({
        request: {
          method: 'GET',
          query: {},
          headers: {},
          body: { type: 'none' },
          timeoutMs: 10_000,
        },
        items: {},
        identity: {},
        seedOnFirstPoll: true,
        maxItemsPerPoll: 50,
      });
    });

    it('checks the URL, templates, schedule minimum, body and credentials', () => {
      expect(messages({ ...base, request: { url: 'https://169.254.169.254/x' } })).toEqual([
        'request.url: Destination not allowed: private, loopback or reserved address',
      ]);
      expect(messages({ ...base, request: { url: 'https://a.example/{{ trigger.x }}' } })).toEqual([
        'request.url: templates are not available in a poll request',
      ]);
      expect(messages({ ...base, request: { url: '/relative' } })).toEqual([
        'request.url: Use an absolute URL (https://…), or a connection with a base URL',
      ]);
      expect(
        messages({ ...base, schedule: { kind: 'interval', timezone: 'UTC', everyMinutes: 1 } }),
      ).toEqual(['schedule.everyMinutes: Schedules on this server run at most every 5 minutes']);
      expect(
        messages({
          ...base,
          request: { url: 'https://a.example/', body: { type: 'json', value: {} } },
        }),
      ).toEqual(['request.body: GET requests cannot have a body']);
      expect(
        messages({
          ...base,
          request: { url: 'https://a.example/', headers: { Authorization: 'x' } },
        }),
      ).toEqual([expect.stringContaining('use an HTTP connection')]);
      expect(messages({ ...base, items: { path: 'a..b' } })).toHaveLength(1);
      expect(messages({ ...base, maxItemsPerPoll: 500 })).toHaveLength(1);
    });

    it('is a POLL schedule trigger with an optional HTTP connection', () => {
      const type = httpNodeTypes(policy, true).find((t) => t.type === 'http.poll')!;
      expect(type).toMatchObject({
        kind: 'TRIGGER',
        scheduleKind: 'POLL',
        connectionProvider: 'HTTP',
        connectionOptional: true,
      });
      expect(type.schedule?.(base)).toEqual(base.schedule);
    });
  });

  describe('items', () => {
    const body = {
      data: {
        items: [
          { id: 1, t: 'a' },
          { id: 2, t: 'b' },
        ],
      },
      next: 'cur-2',
    };

    it('extracts items at a path, or treats the response as one item', () => {
      expect(extractItems(body, 'data.items')).toHaveLength(2);
      expect(extractItems(body)).toEqual([body]);
      expect(extractItems(body, 'data.missing')).toEqual([]);
      expect(() => extractItems(body, 'next')).toThrow(PollDataError);
    });

    it('identifies items by id field or by content hash', () => {
      expect(itemIdentity({ id: 7 }, 'id')).toBe('7');
      expect(itemIdentity({ meta: { key: 'k' } }, 'meta.key')).toBe('k');
      expect(() => itemIdentity({ x: 1 }, 'id')).toThrow(/no usable id/);
      // Content hash ignores key order.
      expect(itemIdentity({ a: 1, b: 2 })).toBe(itemIdentity({ b: 2, a: 1 }));
      expect(itemIdentity({ a: 1 })).not.toBe(itemIdentity({ a: 2 }));
      expect(itemIdentity({ id: 'x'.repeat(300) }, 'id')).toMatch(/^sha256:/);
    });

    it('finds new items in order, without repeats, against the seen window', () => {
      const items = [{ id: 1 }, { id: 2 }, { id: 2 }, { id: 3 }];
      expect(newItems(items, ['1'], 'id').map((i) => i.id)).toEqual(['2', '3']);
      expect(newItems(items, ['1', '2', '3'], 'id')).toEqual([]);
    });

    it('keeps a bounded seen window, newest last', () => {
      const many = Array.from({ length: MAX_SEEN_IDS }, (_, i) => String(i));
      const next = rememberIds(many, ['new']);
      expect(next).toHaveLength(MAX_SEEN_IDS);
      expect(next[next.length - 1]).toBe('new');
      expect(next[0]).toBe('1');
      expect(rememberIds(['a', 'b'], ['a'])).toEqual(['b', 'a']);
    });

    it('reads the cursor; fingerprints the settings', () => {
      expect(cursorFrom(body, 'next')).toBe('cur-2');
      expect(cursorFrom({ n: 5 }, 'n')).toBe('5');
      expect(cursorFrom(body, undefined)).toBeUndefined();
      const a = pollConfigHash({ request: { url: 'x' }, items: {}, identity: {} });
      expect(pollConfigHash({ request: { url: 'x' }, items: {}, identity: {} })).toBe(a);
      expect(pollConfigHash({ request: { url: 'y' }, items: {}, identity: {} })).not.toBe(a);
    });

    it('backs off from the third failure, capped at an hour', () => {
      expect(backoffMs(2)).toBeNull();
      expect(backoffMs(3)).toBe(60_000);
      expect(backoffMs(5)).toBe(240_000);
      expect(backoffMs(20)).toBe(3_600_000);
    });
  });
});
