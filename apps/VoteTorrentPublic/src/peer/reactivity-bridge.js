/**
 * reactivity-bridge.js — verified peer notification -> one injected `Database`
 * handle -> `notifyPeerWrite`. `56-09`'s replication seam, restated in this
 * module's own words for this module's own setting (do not import
 * `snapshot-restore.js`'s argument by analogy):
 *
 * 1. THE SEAM THAT EXISTS FOR EXACTLY THIS. `applyExternalRowChanges` is
 *    documented for "trusted replication-style writes" and runs NO
 *    constraint validation (no PK / UNIQUE / CHECK / FK). The whole
 *    `votetorrent.qsql` argument `snapshot-restore.js` makes for why SQL DML
 *    is not an alternative applies here VERBATIM: the signature-gated
 *    `InsertValid` families, `context.SigningNonce`, and the expiration
 *    CHECKs on historical rows would all reject a row this browser never
 *    signed and has no signing context for. A peer-replicated row is
 *    exactly that shape.
 *
 * 2. WHY THE TRUST POSTURE IS SATISFIED HERE. The seam's precondition is a
 *    trusted origin. In THIS flow the origin is trusted because the
 *    notification carried a THRESHOLD SIGNATURE over the commit-vote
 *    payload — verified by db-core's own delivery path
 *    (`ReactivitySubscriptionManager.onNotification`) against the cached
 *    tail-cohort `MembershipCertV1` — before `deliver` (this module's
 *    `onVerifiedNotification`) is ever called. That verification plays the
 *    role `verifySnapshot`'s out-of-band digest plays for
 *    `snapshot-restore.js`. What it buys, stated plainly: it authenticates
 *    that the SERVING COHORT COMMITTED this revision. What it does NOT buy:
 *    it does not re-check a single column value, because nothing on this
 *    path runs a CHECK, UNIQUE or FK constraint. T-56-09-03 in this plan's
 *    threat model records that residual as accepted, not overlooked.
 *
 * 3. THE STANDING RULE AND ITS BOUNDARY. "Write through `vote-engine`,
 *    never the raw Quereus `Database` handle" governs AUTHORITY ACTIONS — a
 *    write that represents someone doing something, where 26 of the 41
 *    authorization sites are engine-delegated `context.Is*Valid`
 *    constraints a raw handle silently loses. A peer replication represents
 *    NOBODY DOING ANYTHING on this device; it re-materialises rows the
 *    strand already committed. This app holds no key and performs no
 *    authority action at all, so the two-tier authorization argument has no
 *    purchase here — there is no engine API for "apply a replicated row"
 *    and, per point 1, there cannot be a SQL one either.
 *
 * 4. THIS MODULE OWNS THE DATA EVENTS. `Database.ingestExternalRowChanges`'s
 *    own docstring states the division of responsibility verbatim: the seam
 *    "does NOT emit module data events (the external writer owns those,
 *    including the `remote` flag)". The single `notifyPeerWrite(...)` call
 *    below is that ownership discharged — not defensive belt-and-braces,
 *    but the ONLY place in this flow a data event is ever raised.
 *
 * THE SECOND PRODUCTION SITE. This is the second production site of the
 * external-write seam in this repo; the first is
 * `apps/VoteTorrentDashboard/src/lifecycle/snapshot-restore.js`. Both are
 * pinned by `test/node/external-write-seam-sites.test.mjs` (Task 3).
 * `resolvePublicStoreModule` below is a deliberate re-implementation of
 * `snapshot-restore.js`'s `resolveStoreModule`, not a shared import: the two
 * apps do not import each other, and D-22 forbids growing
 * `@votetorrent/web-data/public`'s surface with an external-write helper.
 *
 * ONE HANDLE, RECEIVED NEVER CONSTRUCTED. `open-db.js`'s `setDefaultVtabName`
 * routing trap means a second call to the connection layer's own
 * store-handle opener (keyed on this network) would yield a second,
 * differently-routed handle whose writes the UI's read handle would never
 * see — same-session-invisible, per `Skill("spike-findings-votetorrent")`.
 * `startPeerReplication` therefore takes `db` as a REQUIRED option; this
 * module never opens, attaches or constructs a handle of its own — see the
 * grep this plan's acceptance criteria runs for the exact identifiers this
 * paragraph deliberately does not repeat, to keep that grep meaningful
 * rather than self-tripping.
 *
 * RESEARCH OPEN QUESTION 3, ANSWERED. The two untyped `OptimysticNode`
 * attachments this module reads (`node.cohortTopicHost.service`,
 * `node.reactivitySubscribers`) are deliberately excluded from
 * `OptimysticNodeAttachments` — `optimystic-node.d.ts`'s own docstring names
 * them as node-internal wiring, not a host-facing surface. Both exist only
 * when the node was built with `cohortTopic.enabled === true` over a live
 * FRET service (`@optimystic/db-p2p` `libp2p-node-base.js:1095-1110`), so a
 * missing attachment is a NODE-CONSTRUCTION DEFECT and must surface as a
 * named error at start (`resolveCohortTopicService` /
 * `resolveSubscriberRegistry`), never as a subscription that quietly never
 * fires. RESEARCH's own Priority-Question-6 sketch — constructing a second
 * instance of db-p2p's libp2p-backed notify-transport class and calling its
 * `onNotification` — is WRONG on the transport: `createLibp2pNode` already
 * constructs one such instance, already registers the inbound protocol
 * handler against THAT instance, and already routes decoded frames into
 * `reactivitySubscribers.deliver(topicId, n)`. A
 * second transport object owns no protocol handler and would never be
 * reached. This module registers on the node-level registry instead — the
 * sanctioned Edge-side seam upstream itself says is unbuilt
 * (`libp2p-node-base.js:1197-1199`: "the Quereus `Database.watch` -> manager
 * bridge that CONSTRUCTS managers stays the backlog item
 * `optimystic-network-reactive-watch-integration-test`").
 *
 * THE OPEN SEAM THIS MODULE DOES NOT CLOSE. `NotificationV1` carries no rows
 * (`db-core` `wire.d.ts:46-87` — verified by reading it, not assumed): there
 * is no field a row could arrive in. Reading the changed collection is the
 * injected `readRows` contract. Nothing in `56-05`/`56-02` builds a browser
 * strand read path yet (see this plan's `<open_seam>`), so `readRows` is a
 * REQUIRED option with no default, no stub and no "static for now" variant:
 * `startPeerReplication` throws `PeerReplicationError` when it is absent. A
 * bridge that silently replicated nothing would be the exact failure this
 * phase exists to prevent. `56-16` owns the production `readRows`
 * implementation (`strand-read.js`); this module does not create that file.
 *
 * ERROR HYGIENE, same discipline as `subscribe.js` and
 * `snapshot-restore.js`: only an error's `name` is ever logged, never its
 * message and never the notification or a row.
 *
 * DOES NOT PROVE: the browser page re-renders (`56-11`'s liveness proof) or
 * the D-16 production-variant inversion (`56-13`, which rebuilds a
 * genuinely mutated bundle rather than transforming a source copy — see
 * Task 3's isolation control). Nothing in this module is imported from
 * `main.tsx`.
 */

import { edgeProfile, reactivityTopicId } from '@optimystic/db-core';
import { ReactivitySubscriptionManager, reactivityTailBytes } from '@optimystic/db-p2p';
import { PUBLIC_SUBSCRIBED_TABLES, STORE_MODULE_NAME, notifyPeerWrite } from '@votetorrent/web-data/public';

/** The one prefix every log line in this module carries. @type {string} */
const LOG_PREFIX = 'peer/reactivity-bridge:';

/**
 * Chunk size for `applyExternalRowChanges` batches — bounds peak memory for a
 * large replicated batch rather than holding one call's worth of ops for the
 * whole table. Mirrors `snapshot-restore.js`'s `RESTORE_BATCH_ROWS` rationale
 * exactly; the two constants are not shared because the two apps do not
 * import each other (see the module header).
 * @type {500}
 */
export const PEER_ROW_BATCH_ROWS = 500;

/**
 * A replication-time failure naming a table, option or module — NEVER a row
 * value. Same discipline as `SnapshotRestoreError`: a peer-replicated row can
 * carry registrant PII and must never reach an error string.
 */
export class PeerReplicationError extends Error {
	/**
	 * @param {string} subject - the table, option or module name this error concerns
	 * @param {string} reason
	 */
	constructor(subject, reason) {
		super(`reactivity-bridge: ${reason} (subject: "${subject}")`);
		this.name = 'PeerReplicationError';
		this.subject = subject;
	}
}

/**
 * The error's `name` and nothing else — see this file's header.
 * @param {unknown} err
 * @returns {void}
 */
function logFailure(err) {
	const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
	console.error(LOG_PREFIX, name);
}

/**
 * Resolve `node.cohortTopicHost.service` — an untyped, node-internal
 * attachment `OptimysticNodeAttachments` deliberately excludes (assigned at
 * `@optimystic/db-p2p` `libp2p-node-base.js:1178`, `node.cohortTopicHost =
 * host`; the `.service` accessor is `cohort-topic/host.d.ts:414`). It exists
 * only inside the node's `options.cohortTopic?.enabled === true` branch, over
 * a live FRET service. A missing attachment is a node-construction defect and
 * must surface HERE as a named error, never as a subscription that silently
 * never fires.
 * @param {any} node
 * @returns {import('@optimystic/db-core').CohortTopicService}
 */
export function resolveCohortTopicService(node) {
	const service = node && node.cohortTopicHost ? node.cohortTopicHost.service : undefined;
	if (!service) {
		throw new PeerReplicationError(
			'cohortTopicHost',
			'node.cohortTopicHost.service is absent — the node was not built with cohortTopic.enabled over a live FRET service',
		);
	}
	return service;
}

/**
 * Resolve `node.reactivitySubscribers` — the same class of untyped,
 * node-internal attachment as `resolveCohortTopicService`, assigned at
 * `@optimystic/db-p2p` `libp2p-node-base.js:1199`
 * (`node.reactivitySubscribers = reactivitySubscribers`). This is the
 * `topicId -> handlers` routing table socket-delivered notifications fan out
 * through; a constructed `ReactivitySubscriptionManager` registers its
 * `onNotification` here, keyed by the topic it subscribed under.
 * @param {any} node
 * @returns {import('@optimystic/db-p2p').ReactivitySubscriberRegistry}
 */
export function resolveSubscriberRegistry(node) {
	const registry = node ? node.reactivitySubscribers : undefined;
	if (!registry) {
		throw new PeerReplicationError(
			'reactivitySubscribers',
			'node.reactivitySubscribers is absent — the node was not built with cohortTopic.enabled over a live FRET service',
		);
	}
	return registry;
}

/**
 * Resolve the module registered under `STORE_MODULE_NAME` (imported from
 * `@votetorrent/web-data/public`, never re-derived) as something that
 * exposes `getTableForExternalWrite` — either directly, or through an
 * `IsolationModule`'s public `underlying` property, exactly the resolution
 * `snapshot-restore.js:resolveStoreModule` performs (re-implemented here
 * rather than shared — see the module header). Throws `PeerReplicationError`
 * naming `STORE_MODULE_NAME`, never returning `undefined` for a caller to
 * trip over: a missing/incompatible module here means the handle was built
 * without the mandatory `setDefaultVtabName` path, `open-db.js`'s
 * same-session-invisible trap.
 * @param {import('@quereus/quereus').Database} db
 * @returns {{ getTableForExternalWrite(db: import('@quereus/quereus').Database, schemaName: string, tableName: string): (undefined | { applyExternalRowChanges(ops: readonly any[]): Promise<import('@quereus/quereus').BackingRowChange[]> }) }}
 */
export function resolvePublicStoreModule(db) {
	const registered = db.schemaManager.getModule(STORE_MODULE_NAME);
	const candidate = /** @type {any} */ (registered?.module);

	if (candidate && typeof candidate.getTableForExternalWrite === 'function') {
		return candidate;
	}
	const underlying = candidate?.underlying;
	if (underlying && typeof underlying.getTableForExternalWrite === 'function') {
		return underlying;
	}

	throw new PeerReplicationError(
		STORE_MODULE_NAME,
		'no externally-writable store module is registered under this name (directly, or via an isolation wrapper) -- the handle was built without the mandatory setDefaultVtabName path',
	);
}

/**
 * Apply one peer-replicated batch to `db` through the trusted-replication
 * seam, in chunks of `PEER_ROW_BATCH_ROWS`.
 *
 * `table` is checked against `PUBLIC_SUBSCRIBED_TABLES` BEFORE anything else
 * runs: the allowlist bounds WHAT MAY BE WRITTEN, not only what may be
 * announced (T-56-09-02). A batch naming a table outside the allowlist is
 * refused WHOLE — zero rows applied — with a named error.
 *
 * Returns the accumulated EFFECTIVE `BackingRowChange[]`
 * `applyExternalRowChanges` reported back, never the number of ops
 * submitted: `backing-host.d.ts:32-35` pins that an op that changes
 * nothing — a delete of an absent key, a value-identical upsert — "reports
 * nothing", and that emptiness is what makes T-56-09-05 hold (a replayed
 * batch produces no notice).
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {string} table
 * @param {readonly ({ op: 'upsert', row: import('@quereus/quereus').SqlValue[] } | { op: 'delete', pk: import('@quereus/quereus').SqlValue[] })[]} ops
 * @returns {Promise<import('@quereus/quereus').BackingRowChange[]>}
 */
export async function applyPeerRowBatch(db, table, ops) {
	if (!PUBLIC_SUBSCRIBED_TABLES.includes(table)) {
		throw new PeerReplicationError(
			table,
			'table is outside PUBLIC_SUBSCRIBED_TABLES -- the allowlist bounds what may be WRITTEN, not only what may be announced',
		);
	}

	const module = resolvePublicStoreModule(db);
	const schemaName = db.schemaManager.getCurrentSchemaName();
	const storeTable = module.getTableForExternalWrite(db, schemaName, table);
	if (!storeTable) {
		throw new PeerReplicationError(table, 'the store module has no externally-writable table under this name');
	}

	/** @type {import('@quereus/quereus').BackingRowChange[]} */
	const allChanges = [];
	const rows = Array.isArray(ops) ? ops : [];
	for (let start = 0; start < rows.length; start += PEER_ROW_BATCH_ROWS) {
		const chunk = rows.slice(start, start + PEER_ROW_BATCH_ROWS);
		const changes = await storeTable.applyExternalRowChanges(chunk);
		allChanges.push(...changes);
	}

	if (allChanges.length > 0) {
		// Same options `snapshot-restore.js` uses, and right here for the same
		// reason: the public app registers no `Database.watch` watcher, and
		// this seam emits no data events under either setting -- `captureChanges`
		// is what makes commit-time global assertions fire over the inbound
		// batch, re-introducing exactly the validation this seam bypasses, and
		// the origin's cascade effects (if any) are already IN the replicated
		// batch, so re-running them would double-apply.
		await db.ingestExternalRowChanges(
			allChanges.map((change) => ({ schemaName, tableName: table, change })),
			{ captureChanges: false, applyForeignKeyActions: false },
		);
	}

	return allChanges;
}

/**
 * @typedef {object} PeerRowBatch
 * @property {string} table
 * @property {readonly ({ op: 'upsert', row: import('@quereus/quereus').SqlValue[] } | { op: 'delete', pk: import('@quereus/quereus').SqlValue[] })[]} ops
 */

/**
 * @typedef {object} StartPeerReplicationOptions
 * @property {import('@quereus/quereus').Database} db - the handle the UI reads. RECEIVED, never constructed here.
 * @property {string} networkHash
 * @property {any} node - a running `OptimysticNode`; only its `cohortTopicHost`/`reactivitySubscribers` attachments are read.
 * @property {Uint8Array} collectionId - the collection's stable identity (its id block id, raw bytes).
 * @property {import('@optimystic/db-core').BlockId} tailId - the collection's tail block id at attach time.
 * @property {(projected: { collectionId: string, revision: number, invalidation: boolean | undefined }) => Promise<ReadonlyArray<PeerRowBatch>>} readRows
 *   REQUIRED. No default, no stub, no static variant -- see the module header's "open seam" paragraph.
 * @property {import('@optimystic/db-core').NodeProfile} [profile] defaults to `edgeProfile()`.
 */

/**
 * @typedef {object} PeerReplicationHandle
 * @property {() => Promise<void>} stop idempotent; unregisters from the subscriber registry then withdraws the subscription manager.
 */

/**
 * Start the peer replication bridge for one collection on one injected
 * `Database` handle. Every required option throws `PeerReplicationError`
 * naming the option when missing -- there is no partial start.
 *
 * Assembly, in the order the module header's RESEARCH section pins:
 * `tailBytes = reactivityTailBytes(tailId)` (NEVER db-core's OTHER,
 * asynchronous tail-byte conversion, which `sha256`s first and would resolve
 * a different coord, silently stranding origination) ->
 * `topicId = reactivityTopicId(tailBytes)` -> construct the
 * `ReactivitySubscriptionManager` with `deliver` bound to this module's own
 * `onVerifiedNotification` -> register `manager.onNotification` on the
 * subscriber registry under `topicId` -> `await manager.register()`.
 *
 * Does NOT construct a second instance of db-p2p's libp2p-backed
 * notify-transport class -- see the module header's correction of
 * RESEARCH's Priority-Question-6 sketch.
 *
 * @param {StartPeerReplicationOptions} options
 * @returns {Promise<PeerReplicationHandle>}
 */
export async function startPeerReplication(options) {
	if (!options || typeof options !== 'object') {
		throw new PeerReplicationError('options', 'startPeerReplication: an options object is required');
	}
	const { db, networkHash, node, collectionId, tailId, readRows, profile } = options;

	if (!db) throw new PeerReplicationError('db', 'startPeerReplication: db is required -- the bridge receives its handle, it never constructs one');
	if (!networkHash) throw new PeerReplicationError('networkHash', 'startPeerReplication: networkHash is required');
	if (!node) throw new PeerReplicationError('node', 'startPeerReplication: node is required');
	if (!collectionId) throw new PeerReplicationError('collectionId', 'startPeerReplication: collectionId is required');
	if (!tailId) throw new PeerReplicationError('tailId', 'startPeerReplication: tailId is required');
	if (typeof readRows !== 'function') {
		// No default, no in-module stub, no "static for now" fallback -- see
		// the module header's open-seam paragraph. A silently-replicating-
		// nothing bridge is the exact failure this plan exists to prevent.
		throw new PeerReplicationError('readRows', 'startPeerReplication: readRows is required and has no default');
	}

	const service = resolveCohortTopicService(node);
	const registry = resolveSubscriberRegistry(node);
	const resolvedProfile = profile ?? edgeProfile();

	// The load-bearing encoding contract: `reactivityTailBytes`, never
	// db-core's OTHER, asynchronous tail-byte conversion (which sha256s the
	// utf8 bytes first). That other conversion would double-hash relative to
	// `H(tailId || "reactivity")` and resolve a DIFFERENT coord --
	// origination would silently never reach this subscriber.
	const tailBytes = reactivityTailBytes(tailId);
	const topicId = reactivityTopicId(tailBytes);

	/**
	 * The whole point of this module. Reads top to bottom: `readRows` once ->
	 * apply each returned batch -> collect the DISTINCT `(table, op)` pairs
	 * from the RETURNED EFFECTIVE changes (never from the ops submitted, so a
	 * value-identical replay announces nothing) -> one `notifyPeerWrite` call
	 * per distinct pair.
	 * @param {import('@optimystic/db-core').NotificationV1} n a VERIFIED notification -- `manager.onNotification` has already run
	 *   db-core's verify/dedupe/gap-detection path before calling this.
	 * @returns {Promise<void>}
	 */
	async function onVerifiedNotification(n) {
		try {
			// A NEW frozen object literal with exactly three keys, read off `n` --
			// never `n` itself, never a spread. Same rule as `subscribe.js`'s
			// projection, applied at the other end of the pipe: `readRows` has no
			// business seeing a signature, a signer list or a delta.
			const projected = Object.freeze({
				collectionId: n.collectionId,
				revision: n.revision,
				invalidation: n.invalidation,
			});

			const batches = await readRows(projected);

			/** @type {Map<string, { table: string, op: string }>} */
			const distinctPairs = new Map();
			for (const batch of Array.isArray(batches) ? batches : []) {
				if (!batch || typeof batch.table !== 'string') continue;
				const changes = await applyPeerRowBatch(db, batch.table, batch.ops);
				for (const change of changes) {
					const key = `${batch.table}:${change.op}`;
					if (!distinctPairs.has(key)) distinctPairs.set(key, { table: batch.table, op: change.op });
				}
			}

			// Driven by the RETURNED EFFECTIVE changes, never by the ops that were
			// submitted -- T-56-09-05. The single `notifyPeerWrite(...)` call below
			// is one complete statement on one line with no other work on that
			// line, so `56-13`'s source-transform inversion (Task 3) can delete
			// exactly it and nothing else. It is deliberately not behind a flag,
			// an option or an injected collaborator -- see
			// `project_esbuild_minifier_defeats_naive_dist_controls`.
			for (const { table, op } of distinctPairs.values()) {
				notifyPeerWrite(db, networkHash, table, op);
			}
		} catch (err) {
			// A throwing readRows, or a refused/failed batch: log the NAME only,
			// fire no notice for this notification, and let the subscription stay
			// registered for the next one.
			logFailure(err);
		}
	}

	const manager = new ReactivitySubscriptionManager({
		service,
		collectionId,
		tailIdAtAttach: tailBytes,
		profile: resolvedProfile,
		deliver: onVerifiedNotification,
	});

	const unregister = registry.register(topicId, manager.onNotification.bind(manager));
	await manager.register();

	let stopped = false;
	/** Idempotent; neither leg throws. @returns {Promise<void>} */
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		try {
			unregister();
		} catch (err) {
			logFailure(err);
		}
		try {
			await manager.withdraw();
		} catch (err) {
			logFailure(err);
		}
	};

	return { stop };
}
