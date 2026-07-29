/**
 * Last-write-wins reduction over the append-only sheet log.
 *
 * The sheet is never updated in place. An edit appends a new row with the same
 * id and a newer `updated_at`; a delete appends a row with `deleted = TRUE`.
 * Reading therefore means collapsing many rows per id down to one.
 *
 * Three properties this must have, because there is no server to arbitrate:
 *
 *  1. **Idempotent.** If a write succeeds but the HTTP response is lost, the
 *     retry appends a byte-identical row. Collapsing must treat that as one
 *     record, not two.
 *  2. **Deterministic across devices.** Two devices reducing the same rows in
 *     different orders must reach the same answer, or they will fight forever.
 *     Hence the `device_id` tie-break — without it, equal `updated_at` values
 *     resolve by array order, which differs per device.
 *  3. **Convergent.** Merging is commutative and associative, so it does not
 *     matter whether we merge local-then-remote or remote-then-local.
 */

/** Anything the sheet stores as a versioned, tombstone-able record. */
export interface Versioned {
  readonly updated_at: string;
  readonly deleted: boolean;
  readonly device_id: string;
}

export type IdOf<T> = (record: T) => string;

/**
 * Compare two versions of the same record. Positive means `a` wins.
 *
 * `updated_at` is compared as a parsed instant, never as a string: ISO strings
 * only sort lexicographically when their precision matches, and
 * "2026-01-01T00:00:00Z" > "2026-01-01T00:00:00.000Z" as text ('Z' > '.')
 * even though they are the same moment. That would make the winner depend on
 * which client wrote the row.
 */
export function compareVersions(a: Versioned, b: Versioned): number {
  const timeA = Date.parse(a.updated_at);
  const timeB = Date.parse(b.updated_at);
  const validA = !Number.isNaN(timeA);
  const validB = !Number.isNaN(timeB);

  // An unparseable timestamp always loses; it can never silently win a conflict.
  if (!validA && !validB) return 0;
  if (!validA) return -1;
  if (!validB) return 1;

  if (timeA !== timeB) return timeA > timeB ? 1 : -1;

  // Same instant: break the tie on device_id so every device agrees.
  if (a.device_id !== b.device_id) return a.device_id > b.device_id ? 1 : -1;

  return 0;
}

/** The winning version of two candidates. Returns `a` on an exact tie. */
export function pickWinner<T extends Versioned>(a: T, b: T): T {
  return compareVersions(b, a) > 0 ? b : a;
}

/**
 * Collapse an append-only row set to the newest version of each record.
 * Tombstones are *kept*, not dropped — a delete has to survive the reduce in
 * order to propagate to other devices. Filter with `visibleOnly` for display.
 */
export function reduceLatest<T extends Versioned>(records: readonly T[], id: IdOf<T>): Map<string, T> {
  const latest = new Map<string, T>();
  for (const record of records) {
    const key = id(record);
    const existing = latest.get(key);
    latest.set(key, existing === undefined ? record : pickWinner(existing, record));
  }
  return latest;
}

/** Live records only: tombstones removed. */
export function visibleOnly<T extends Versioned>(records: Iterable<T>): T[] {
  return [...records].filter((r) => !r.deleted);
}

export interface MergeResult<T> {
  /** Newest version of every id seen on either side, tombstones included. */
  merged: T[];
  /** Records whose winning version came from `remote` — what to persist locally. */
  changedLocally: T[];
  /** Records whose winning version came from `local` — what still needs pushing. */
  changedRemotely: T[];
}

/**
 * Merge the local mirror with what the sheet currently holds.
 *
 * A local edit made offline naturally wins, because its `updated_at` was
 * stamped when the user made it. There is no separate "pending" concept needed
 * here — the timestamps carry that information.
 */
export function mergeRecords<T extends Versioned>(
  local: readonly T[],
  remote: readonly T[],
  id: IdOf<T>,
): MergeResult<T> {
  const localLatest = reduceLatest(local, id);
  const remoteLatest = reduceLatest(remote, id);

  const merged: T[] = [];
  const changedLocally: T[] = [];
  const changedRemotely: T[] = [];

  for (const key of new Set([...localLatest.keys(), ...remoteLatest.keys()])) {
    const mine = localLatest.get(key);
    const theirs = remoteLatest.get(key);

    if (mine === undefined) {
      // Only the sheet has it: another device created it.
      merged.push(theirs!);
      changedLocally.push(theirs!);
      continue;
    }
    if (theirs === undefined) {
      // Only we have it: created here and not yet pushed.
      merged.push(mine);
      changedRemotely.push(mine);
      continue;
    }

    const winner = pickWinner(mine, theirs);
    merged.push(winner);
    const decision = compareVersions(mine, theirs);
    if (decision < 0) changedLocally.push(theirs);
    else if (decision > 0) changedRemotely.push(mine);
    // decision === 0: both sides already agree, nothing to do either way.
  }

  return { merged, changedLocally, changedRemotely };
}

/**
 * Rows that can be dropped when compacting the sheet: everything that is not
 * the winning version of its id. Used by Settings -> Compact sheet.
 */
export function supersededCount<T extends Versioned>(records: readonly T[], id: IdOf<T>): number {
  return records.length - reduceLatest(records, id).size;
}
