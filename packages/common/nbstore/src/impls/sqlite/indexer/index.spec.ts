import { describe, expect, test, vi } from 'vitest';

import { bindNativeDBApis, type NativeDBApis } from '../db';
import { SqliteIndexerStorage } from './index';

let counter = 0;

function createStorage(total: number) {
  const indexSearch = vi.fn(async (..._args: unknown[]) => ({
    total,
    hits: [],
  }));
  bindNativeDBApis({ indexSearch } as unknown as NativeDBApis);
  const storage = new SqliteIndexerStorage({
    flavour: 'local',
    type: 'workspace',
    // connections are shared by id
    id: `test-${counter++}`,
  });
  return { storage, indexSearch };
}

describe('SqliteIndexerStorage search window', () => {
  test('clamps an unbounded limit to the native window and reports truncation', async () => {
    const { storage, indexSearch } = createStorage(12_000);
    const result = await storage.search(
      'doc',
      { type: 'all' },
      { pagination: { limit: Infinity } }
    );
    expect(indexSearch.mock.calls[0][3]).toMatchObject({
      limit: 10_000,
      offset: 0,
    });
    expect(result.pagination.hasMore).toBe(true);
  });

  test('clamps an unbounded limit after a skip', async () => {
    const { storage, indexSearch } = createStorage(12_000);
    const result = await storage.search(
      'doc',
      { type: 'all' },
      { pagination: { skip: 9_500, limit: Infinity } }
    );
    expect(indexSearch.mock.calls[0][3]).toMatchObject({
      limit: 500,
      offset: 9_500,
    });
    expect(result.pagination.hasMore).toBe(true);
  });

  test('throws for an unbounded limit starting past the window', async () => {
    const { storage, indexSearch } = createStorage(12_000);
    await expect(
      storage.search(
        'doc',
        { type: 'all' },
        { pagination: { skip: 10_000, limit: Infinity } }
      )
    ).rejects.toThrow('search window exceeds');
    expect(indexSearch).not.toHaveBeenCalled();
  });

  test('passes an explicit window through unchanged', async () => {
    const { storage, indexSearch } = createStorage(12_000);
    const result = await storage.search(
      'doc',
      { type: 'all' },
      { pagination: { skip: 9_500, limit: 1_000 } }
    );
    expect(indexSearch.mock.calls[0][3]).toMatchObject({
      limit: 1_000,
      offset: 9_500,
    });
    expect(result.pagination.hasMore).toBe(true);
  });

  test('is not truncated when everything fits', async () => {
    const { storage, indexSearch } = createStorage(20);
    const result = await storage.search(
      'doc',
      { type: 'all' },
      { pagination: { limit: Infinity } }
    );
    expect(indexSearch.mock.calls[0][3]).toMatchObject({ limit: 10_000 });
    expect(result.pagination.hasMore).toBe(false);
  });
});
