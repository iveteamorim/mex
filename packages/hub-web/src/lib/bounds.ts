export const MAX_WORKBENCH_PAGES = 8;
export const MAX_ACCUMULATED_WORKBENCH_ITEMS = 200;
export const MAX_OBSERVED_TERMINAL_JOB_IDS = 64;

export interface BoundedAppend<T> {
  items: T[];
  omitted: boolean;
}

/** Keep the newest/root page first and stop retaining older pagination rows. */
export function appendBounded<T>(
  current: readonly T[],
  incoming: readonly T[],
  limit = MAX_ACCUMULATED_WORKBENCH_ITEMS,
): BoundedAppend<T> {
  const items = [...current, ...incoming].slice(0, limit);
  return { items, omitted: current.length + incoming.length > items.length };
}

/** Append unique pagination rows without allowing one mounted workbench to grow forever. */
export function appendBoundedUnique<T>(
  current: readonly T[],
  incoming: readonly T[],
  keyOf: (item: T) => string,
  limit = MAX_ACCUMULATED_WORKBENCH_ITEMS,
): BoundedAppend<T> {
  const items = current.slice(0, limit);
  const keys = new Set(items.map(keyOf));
  let omitted = current.length > items.length;
  for (const item of incoming) {
    const key = keyOf(item);
    if (keys.has(key)) continue;
    keys.add(key);
    if (items.length < limit) items.push(item);
    else omitted = true;
  }
  return { items, omitted };
}

export function boundedNextCursor(
  nextCursor: string | null,
  retainedPages: number,
): string | undefined {
  return retainedPages >= MAX_WORKBENCH_PAGES ? undefined : nextCursor ?? undefined;
}

/** Set insertion order gives us a deterministic FIFO cap for de-duplication IDs. */
export function rememberBoundedId(
  ids: Set<string>,
  id: string,
  limit = MAX_OBSERVED_TERMINAL_JOB_IDS,
): void {
  if (ids.delete(id)) ids.add(id);
  else ids.add(id);
  while (ids.size > limit) {
    const oldest = ids.values().next().value as string | undefined;
    if (oldest === undefined) break;
    ids.delete(oldest);
  }
}
