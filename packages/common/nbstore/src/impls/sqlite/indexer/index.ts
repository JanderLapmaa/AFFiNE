import type { Observable } from 'rxjs';
import { merge, of, Subject } from 'rxjs';
import { filter, throttleTime } from 'rxjs/operators';

import { share } from '../../../connection';
import type {
  AggregateOptions,
  AggregateResult,
  IndexerDocument,
  IndexerSchema,
  Query,
  SearchOptions,
  SearchResult,
} from '../../../storage';
import { IndexerStorageBase } from '../../../storage';
import { fromPromise } from '../../../utils/from-promise';
import { backoffRetry, exhaustMapWithTrailing } from '../../idb/indexer/utils';
import {
  NativeDBConnection,
  type NativeIndexQuery,
  type NativeIndexSearchOptions,
  type SqliteNativeDBOptions,
} from '../db';
import { createNode } from './node-builder';

const SQLITE_INDEXER_VERSION_OFFSET = 1;
const NATIVE_INDEXER_MAX_LIMIT = 0xffffffff;
// memory-indexer (MAX_SEARCH_LIMIT) rejects a search whose limit or
// offset + limit exceeds this. Aggregate buckets have no such cap.
const NATIVE_INDEXER_MAX_WINDOW = 10_000;

export class SqliteIndexerStorage extends IndexerStorageBase {
  static readonly identifier = 'SqliteIndexerStorage';
  override readonly recommendRefreshInterval = 30 * 1000; // 5 seconds
  readonly connection: NativeDBConnection;
  readonly isReadonly = false;
  private readonly tableUpdate$ = new Subject<string>();

  constructor(options: SqliteNativeDBOptions) {
    super();
    this.connection = share(new NativeDBConnection(options));
  }

  private watchTableUpdated(table: string) {
    return this.tableUpdate$.asObservable().pipe(filter(t => t === table));
  }

  async search<T extends keyof IndexerSchema, const O extends SearchOptions<T>>(
    table: T,
    query: Query<T>,
    options?: O
  ): Promise<SearchResult<T, O>> {
    const limit = options?.pagination?.limit ?? 10;
    const skip = options?.pagination?.skip ?? 0;
    const window = toNativeWindow(limit, skip);
    const result = await this.connection.apis.indexSearch(
      String(table),
      toNativeQuery(query),
      toNativeOptions(options, window)
    );
    const nodes = result.hits.map(hit => createNode(hit, options ?? {}));

    return {
      pagination: {
        count: result.total,
        limit,
        skip,
        // a window clamped to the native cap reports the truncation here
        hasMore: result.total > skip + window.limit,
      },
      nodes,
    };
  }

  async aggregate<
    T extends keyof IndexerSchema,
    const O extends AggregateOptions<T>,
  >(
    table: T,
    query: Query<T>,
    field: keyof IndexerSchema[T],
    options?: O
  ): Promise<AggregateResult<T, O>> {
    const limit = options?.pagination?.limit ?? 10;
    const skip = options?.pagination?.skip ?? 0;
    const hitLimit = options?.hits?.pagination?.limit ?? 3;
    const hitSkip = options?.hits?.pagination?.skip ?? 0;
    const hitWindow = toNativeWindow(hitLimit, hitSkip);
    const result = await this.connection.apis.indexAggregate(
      String(table),
      toNativeQuery(query),
      String(field),
      toNativeLimit(limit),
      skip,
      options?.hits ? toNativeOptions(options.hits, hitWindow) : undefined
    );
    const hitsOptions = options?.hits;
    const buckets = result.buckets.map(bucket => ({
      key: bucket.key,
      count: bucket.count,
      score: bucket.score,
      ...(hitsOptions
        ? {
            hits: {
              pagination: {
                count: bucket.count,
                limit: hitLimit,
                skip: hitSkip,
                hasMore: bucket.count > hitSkip + hitWindow.limit,
              },
              nodes: bucket.hits.map(hit => createNode(hit, hitsOptions)),
            },
          }
        : {}),
    }));

    return {
      pagination: {
        count: result.total,
        limit,
        skip,
        hasMore: result.total > skip + limit,
      },
      buckets,
    } as AggregateResult<T, O>;
  }

  search$<T extends keyof IndexerSchema, const O extends SearchOptions<T>>(
    table: T,
    query: Query<T>,
    options?: O
  ): Observable<SearchResult<T, O>> {
    return merge(of(1), this.watchTableUpdated(table)).pipe(
      throttleTime(3000, undefined, { leading: true, trailing: true }),
      exhaustMapWithTrailing(() => {
        return fromPromise(async () => {
          return await this.search(table, query, options);
        }).pipe(backoffRetry());
      })
    );
  }

  aggregate$<
    T extends keyof IndexerSchema,
    const O extends AggregateOptions<T>,
  >(
    table: T,
    query: Query<T>,
    field: keyof IndexerSchema[T],
    options?: O
  ): Observable<AggregateResult<T, O>> {
    return merge(of(1), this.watchTableUpdated(table)).pipe(
      throttleTime(3000, undefined, { leading: true, trailing: true }),
      exhaustMapWithTrailing(() => {
        return fromPromise(async () => {
          return await this.aggregate(table, query, field, options);
        }).pipe(backoffRetry());
      })
    );
  }

  async deleteByQuery<T extends keyof IndexerSchema>(
    table: T,
    query: Query<T>
  ): Promise<void> {
    await this.connection.apis.indexDeleteByQuery(
      String(table),
      toNativeQuery(query)
    );
  }

  async insert<T extends keyof IndexerSchema>(
    table: T,
    document: IndexerDocument<T>
  ): Promise<void> {
    await this.connection.apis.indexUpsert(String(table), {
      id: document.id,
      fields: [...document.fields].map(([field, values]) => ({
        field: String(field),
        values,
      })),
    });
    this.tableUpdate$.next(table);
  }

  async delete<T extends keyof IndexerSchema>(
    table: T,
    id: string
  ): Promise<void> {
    await this.connection.apis.indexDelete(String(table), id);
    this.tableUpdate$.next(table);
  }

  async update<T extends keyof IndexerSchema>(
    table: T,
    document: IndexerDocument<T>
  ): Promise<void> {
    // Update is essentially insert (overwrite)
    return this.insert(table, document);
  }

  async refresh<T extends keyof IndexerSchema>(_table: T): Promise<void> {
    // No-op for memory index
  }

  async refreshIfNeed(): Promise<void> {
    await this.connection.apis.indexFlush();
  }

  async indexVersion(): Promise<number> {
    return (
      (await this.connection.apis.indexVersion()) +
      SQLITE_INDEXER_VERSION_OFFSET
    );
  }
}

function toNativeQuery(query: Query<any>): NativeIndexQuery {
  switch (query.type) {
    case 'match':
      return { kind: 'match', field: String(query.field), value: query.match };
    case 'exists':
      return { kind: 'exists', field: String(query.field) };
    case 'all':
      return { kind: 'all' };
    case 'boolean':
      return {
        kind: 'boolean',
        occur: query.occur,
        clauses: query.queries.map(toNativeQuery),
      };
    case 'boost':
      return {
        kind: 'boost',
        boost: query.boost,
        clauses: [toNativeQuery(query.query)],
      };
  }
}

function toNativeOptions(
  options: SearchOptions<any> | undefined,
  window: { limit: number; offset: number }
): NativeIndexSearchOptions {
  const highlights = options?.highlights?.map(item => String(item.field)) ?? [];
  return {
    ...window,
    fields: [
      ...new Set([...(options?.fields?.map(String) ?? []), ...highlights]),
    ],
    highlights,
  };
}

function toNativeLimit(limit: number) {
  return limit === Infinity ? NATIVE_INDEXER_MAX_LIMIT : limit;
}

/**
 * Only an unbounded limit is clamped to what memory-indexer accepts. An
 * explicit window is passed through, so an oversized one still gets the native
 * error instead of silently coming back empty.
 */
export function toNativeWindow(limit: number, offset: number) {
  if (limit !== Infinity) return { limit, offset };
  if (offset >= NATIVE_INDEXER_MAX_WINDOW) {
    // nothing sensible to return; fail like an explicit oversized window does
    throw new Error(`search window exceeds ${NATIVE_INDEXER_MAX_WINDOW}`);
  }
  return { limit: NATIVE_INDEXER_MAX_WINDOW - offset, offset };
}
