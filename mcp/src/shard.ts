/**
 * Splits a flow list across matrix jobs. Shard `index` (0-based) of `count`
 * takes every flow whose position is congruent to `index` modulo `count`, so
 * shards differ by at most one flow and the split is the same on every run.
 */
export function shardFlows<T>(items: T[], index: number, count: number): T[] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be >= 1, got ${count}`);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`shard index must be between 0 and ${count - 1}, got ${index}`);
  }
  return items.filter((_, i) => i % count === index);
}
