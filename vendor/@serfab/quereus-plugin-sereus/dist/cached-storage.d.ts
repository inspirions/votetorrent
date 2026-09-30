/**
 * Wrap an embedder-supplied `IRawStorage` in `@optimystic/db-p2p`'s write-through
 * raw-storage cache (`CachedRawStorage`) before handing it to a node or transactor.
 *
 * Why: bringing a control database or strand up is raw-storage-operation bound —
 * uncached, a cold start re-reads the same handful of blocks ~2000 times (see the
 * budget history in cadre-core's `test/control-start-storage-op-budget.spec.ts` and
 * the sereus tickets `complete/optimystic-block-read-amplification-on-control-start`
 * + `complete/optimystic-schema-catalog-reread-per-write-blows-storage-budgets`).
 * Upstream ships the remedy as an opt-in wrapper — adoption is deliberately the
 * consumer's choice — and this module is where Sereus opts in. It lives in this
 * package (not cadre-core) for the same reason `cluster-size.ts` does: both the SQL
 * plugin's own connectors (`composeStrand`, including the browser/IndexedDB path,
 * where per-operation latency is highest) and cadre-core's control/strand seams
 * need the identical wrap, and two copies could disagree.
 *
 * Soundness rests on the cache's single-process-owner invariant (upstream
 * docs/storage.md §6): every write to the backend must funnel through the wrapped
 * instance. Two rules uphold that:
 *
 * - **One wrap per inner instance** (WeakMap memo): the same `IRawStorage` reaches
 *   this function from several seams at once — cadre-core's node wiring and the
 *   strand backfill share the instance the node was built with, and the SQL
 *   plugin's `composeStrand` re-wraps whatever it is handed. Two live caches over
 *   one backend would each miss the other's writes; the memo makes the wrap
 *   idempotent instead — a caller wrapping an already-wrapped or already-seen
 *   instance gets the same object back.
 * - **A Sereus process owns its data stores** — no second process writes the same
 *   backend, which is the invariant's other half.
 *
 * `MemoryRawStorage` is returned unwrapped on upstream's own guidance: the backend
 * is already in-memory, so the cache adds bookkeeping with nothing to save.
 *
 * **{@link wrapStorageWithCache} and {@link disposeStorageCache} are a matched pair
 * with a holder count between them.** Every wrap that hands back a cache this module
 * created takes one claim on it; every dispose of that cache releases one. The cache
 * is emptied, unregistered from the shared pool, and forgotten only when the LAST
 * claim goes. That is what makes overlapping scopes safe: `CadreNodeConfig.storage.provider`
 * may be a single `IRawStorage` shared by the control database and every workspace,
 * and without a count the first scope to stop would retire the cache the others are
 * still reading through — then the next scope to start, finding the memo empty, would
 * build a SECOND cache over the same backend, and each would serve its own stale view
 * (including remembered "this block does not exist" answers). It is also what lets
 * `composeStrand` release its own claim unconditionally on `shutdown()` without having
 * to guess whether it or cadre-core created the wrapper.
 *
 * The memo dedupes *concurrent* seams; it is not what keeps a cache alive across a
 * runtime rebuild. That is cadre-core's job, and it does it by OWNERSHIP: one
 * resolved store per scope per runtime lifetime — a strand's store for the life of
 * its instance (a hibernation quiesce → resume reuses the store already resolved,
 * so the wake lands on a warm cache), the control store for the life of one
 * `CadreNode.start()`. Because the store outlives the rebuild, so does its wrap,
 * whether or not the embedder's provider returns a stable instance.
 *
 * When a scope's runtime stops for good, it calls {@link disposeStorageCache} — the
 * release half of that ownership. Without it the retired wrapper's `CacheStoreHandle`
 * would stay in the shared pool's registry for the process lifetime (`unregisterStore`
 * is the only removal), one orphan per stop.
 *
 * NOTE: upstream ships an equivalent counted wrap of its own — `withReadCache`, which
 * hands back a `ReadCacheLease` per caller and additionally dedupes by
 * `getStoreIdentity()`, so two DISTINCT instances over one directory share one cache.
 * This module keeps its own count instead, because its public surface releases by
 * WRAPPER (`disposeStorageCache(storage)`) rather than by lease, and `withReadCache`
 * returns no lease on its already-cached pass-through — which would leave
 * `composeStrand`'s unconditional release unable to tell its own claim from cadre-core's.
 * Adopting the lease API would mean changing that surface at all three call sites; worth
 * doing if Sereus ever needs the identity-keyed dedupe (two `FileRawStorage` over one
 * path), and not before.
 */
import { type IRawStorage } from '@optimystic/db-p2p/rn';
/**
 * The cached view of `storage`, memoized per instance, with one holder claim taken for
 * this caller — release it with {@link disposeStorageCache} when this caller's scope
 * ends. `label` names the store in the shared pool's `stats()` (e.g. `control`, or the
 * strand id); on a memo hit the first caller's label sticks, since a second cache over
 * one backend is the failure that matters and a stale pool label is not.
 */
export declare function wrapStorageWithCache(storage: IRawStorage, label: string): IRawStorage;
/**
 * Release this caller's claim on the cache wrapper {@link wrapStorageWithCache} returned.
 * The wrapper is emptied, unregistered from the shared pool, and dropped from the memo
 * only when the LAST holder releases — so a scope stopping never retires a cache another
 * live scope is still reading through, and a still-held wrapper is never replaced by a
 * competing second cache over the same backend.
 *
 * A wrapper with no live claim is left alone: that covers both a cache the embedder built
 * itself (theirs to dispose) and a late second dispose of an already-retired wrapper,
 * whose successor in the memo must not be dropped.
 *
 * No-op for anything this module returned unwrapped (e.g. `MemoryRawStorage`), so callers
 * need no `instanceof` test. Only the wrapper is released: the inner store the embedder
 * returned is never closed — that handle stays the embedder's to manage.
 */
export declare function disposeStorageCache(storage: IRawStorage): Promise<void>;
