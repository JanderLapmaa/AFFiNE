import { afterEach, expect, test, vi } from 'vitest';

import { QuickAddBroker } from '../../src/main/quick-add/broker';

afterEach(() => {
  vi.useRealTimers();
});

test('a request goes out to the tabs and resolves with the first answer', async () => {
  const broker = new QuickAddBroker(1000);
  const seen: { requestId: string; text: string }[] = [];
  broker.requests$.subscribe(request => {
    seen.push(request);
    broker.respond(request.requestId, { ok: true, due: '2026-10-29' });
    // a second tab answering late changes nothing
    broker.respond(request.requestId, { ok: false, reason: 'error' });
  });
  await expect(broker.request('Call bank @tomorrow')).resolves.toEqual({
    ok: true,
    due: '2026-10-29',
  });
  expect(seen.map(r => r.text)).toEqual(['Call bank @tomorrow']);
});

test('requests get their own ids', async () => {
  const broker = new QuickAddBroker(1000);
  const ids: string[] = [];
  broker.requests$.subscribe(({ requestId }) => {
    ids.push(requestId);
    broker.respond(requestId, { ok: true, due: null });
  });
  await Promise.all([broker.request('a'), broker.request('b')]);
  expect(new Set(ids).size).toBe(2);
});

test('without an answer in time the request gives no-workspace', async () => {
  vi.useFakeTimers();
  const broker = new QuickAddBroker(1000);
  const result = broker.request('lost');
  await vi.advanceTimersByTimeAsync(1000);
  await expect(result).resolves.toEqual({ ok: false, reason: 'no-workspace' });
});

test('an answer to an unknown request is ignored', () => {
  const broker = new QuickAddBroker(1000);
  expect(() => broker.respond('nope', { ok: true, due: null })).not.toThrow();
});
