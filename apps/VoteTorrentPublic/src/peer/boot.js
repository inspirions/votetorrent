/**
 * boot.js — the ONE production composition of the peer layer: bootstrap
 * config -> session identity -> Edge node -> strand row source -> replication
 * bridge -> browser store. Called by production (`main.tsx`) AND by the
 * mesh-read gate (`test/browser/mesh-read-gate.js`) — never a hand-rolled
 * parallel composition. A harness that re-derives its own wiring is a
 * lookalike that can pass while production is dead
 * (`project_composed_shell_unproven_blank_dashboard`: nothing mounted the
 * composed shell, and the gate could not see it). This file makes that
 * impossible by construction: there is exactly one `startPublicPeerBoot`.
 *
 * NEVER THROWS, NEVER REJECTS. Every failure is a named member of the frozen
 * result union below — the same seam `56-06`'s `loadBootstrapConfig` argued
 * for one layer down. A thrown boot step would force whichever component
 * currently owns the render path (`56-12`'s `PublicApp.tsx` today; `56-14`
 * moves the call into it in Wave 6) to wrap every call in a `try/catch`.
 *
 * ADDS NO GLOBAL. Production gains no new `window.*` property.
 * `assert-no-test-harness-in-dist.mjs` stays green without being edited, and
 * the gate holds the returned handle directly rather than reading it off
 * `window`.
 *
 * DEPENDENCY INJECTION. Every collaborator arrives through an optional `deps`
 * bag defaulting to the real bindings — the same rationale `56-06`'s
 * `resolveBootstrapNodes` records: the whole module must be exercisable under
 * `node --test`, with no browser, no DOM and no socket.
 *
 * WHY `attachNetworkDb` AND NOT `openStoreHandle` OR `new Database`.
 * `public-election-source.js`'s own header (point 3) states the reason this
 * file must not re-derive: the networks registry — never the URL — is what
 * authorises a store name, because the network hash on this page comes
 * straight out of the URL (D-33) and an unguarded attach would let any link
 * author plant an empty database in a stranger's browser. `attachNetworkDb`
 * is the ONLY connection-layer entry point that is unreachable without a
 * pre-existing registry entry, so this module calls it exactly once and
 * NEVER calls `openStoreHandle`/`createNetworkDb`/`new Database` itself —
 * this module does not register a network. A visitor whose browser was never
 * legitimately bootstrapped into this network sees `attachNetworkDb` fail
 * (any of its three typed errors), and that failure is surfaced here as
 * `PEER_BOOT_STATUS.FAILED`, not silently upgraded into a fresh empty store.
 * Test setup (the mesh-read gate; `live-read-gate.js` before it) registers a
 * network the same way a real prior legitimate bootstrap would, through the
 * data package's own `createNetworkDb`/`writeRowCounts`/`upsertNetwork` —
 * that registration is gate-owned setup, never something this module, or any
 * production code reachable from `main.tsx`, performs on this browser's
 * behalf.
 *
 * `openStoreHandle` mints a NEW `Database` per call, and every handle it
 * produces calls `db.setDefaultVtabName('store')` (`packages/web-data/src
 * /open-db.js:77-98`), so two handles obtained through it are IDENTICALLY
 * ROUTED (pre-verified fact 2). The handle `attachNetworkDb` returns here is
 * therefore a SECOND, identically-routed handle to the same IndexedDB store
 * `use-public-election.ts` (`56-12`, this same wave, one plan upstream) opens
 * for the page's own read — never the differently-routed handle D-16
 * forbids, and never the same JS object as the page's handle either: this
 * module and the page each own, and each close, their own connection. The
 * live-read gate (`test/browser/run-live-read-gate.mjs`) already proved a
 * second, identically-routed WRITER handle's change reaches a page reading
 * through its own separate handle end to end; rung 10 of the mesh-read gate
 * (`test/browser/mesh-read-gate.js`) is what re-proves that specifically for
 * THIS module's handle, so a reasoning error here does not go unnoticed.
 *
 * COLLECTION IDENTITY FOR REACTIVITY (open ground before this plan; no prior
 * plan resolves it). `56-09`'s `startPeerReplication` requires a
 * `collectionId`/`tailId` pair per subscription, and nothing in this repo's
 * production code has ever computed one before this file. Measured this
 * session, from installed bytes, and recorded here so a later reader can
 * re-verify rather than re-derive:
 *
 *   - `@optimystic/quereus-plugin-optimystic`'s vtab module defaults a
 *     table's `collectionUri` to `` `tree://default/${tableSchema.name}` ``
 *     when no explicit `using(...)` clause names one
 *     (`dist/chunk-*.js`, the `create()`/`connect()` path, `args["0"] ||
 *     tree://default/${tableSchema.name}`). `VOTETORRENT_SCHEMA_SQL` has ZERO
 *     `using` clauses (grep-confirmed), so every VoteTorrent table — on the
 *     strand exactly as on the UI's local store — defaults to this URI.
 *   - `CollectionFactory.getCollectionId(options)` returns
 *     `this.parseCollectionId(options.collectionUri)`, and `parseCollectionId`
 *     is a PURE string transform: strip the `tree://` prefix, return the
 *     remaining path unchanged. `CollectionId` is itself a type alias for
 *     `BlockId` (`string`) — there is no hash, no derived digest. So the
 *     collection id for table `T` is exactly the literal string
 *     `` `default/${T}` ``, computable with no plugin instance, no network
 *     call and no private API — `collectionIdForTable` below IS that
 *     one-line transform, not an approximation of it.
 *   - The collection's CURRENT tail id is `IChainHeader.tailId`
 *     (`@optimystic/db-core` `chain-nodes.d.ts`: `{ headId, tailId }`) on the
 *     collection's own HEADER BLOCK — and the header block's id IS the
 *     collection id (`getCollectionId`'s own doc comment: "This is the same
 *     id used as the collection's header block id ... exactly the
 *     CollectionChangeEvent.collectionId value emitted when the collection's
 *     blocks commit"). So the tail id is read by fetching that one block
 *     through the injected node's own `coordinatedRepo` — the same
 *     `IRepo.get({ blockIds })` primitive `56-05`'s `edge-node.js` already
 *     attaches (`Libp2pNodeWithRepo.coordinatedRepo`) — and reading
 *     `.tailId` off the returned block. No private `CollectionFactory`
 *     access, no `ParsedOptimysticOptions` construction: `IRepo` is the one
 *     public seam this needs.
 *   - Every table in `PUBLIC_SUBSCRIBED_TABLES` already has a committed
 *     header block (zero rows or not) by the time this module ever runs,
 *     because `apply schema App` — which BOTH the strand's founding process
 *     and this module's own `connectToStrand` composition run — creates each
 *     table's collection at DECLARE time
 *     (`CollectionFactory.createOrGetCollection`'s own doc comment: "bringing
 *     it into existence when nothing has ever been committed under its
 *     id"). A table whose header block is somehow still missing is a
 *     genuine strand-provisioning defect, not a case to paper over — see
 *     `collectionIdForTable`'s caller, which throws `PeerBootError` naming
 *     the table rather than silently skipping its subscription.
 *   - `startPeerReplication` is therefore called ONCE PER TABLE in
 *     `PUBLIC_SUBSCRIBED_TABLES`, sharing the SAME `readRows` closure across
 *     every subscription (56-16's `createStrandRowSource` deliberately
 *     rereads the WHOLE allowlist on any one notification, by design — see
 *     `strand-read.js`'s own header — so it does not matter which of the N
 *     subscriptions fires; any one of them re-applies every table). This is
 *     the load-bearing reason a per-table collectionId, rather than one
 *     "the" collectionId, is even askable: there is no single shared
 *     collection covering every table.
 *   - IF THIS REASONING IS EVER WRONG — the URI default changes, the header
 *     block does not exist yet, or the tail id this module reads is stale —
 *     the failure surfaces as: no replicated row ever lands (mesh-read gate
 *     rung 5, `test/browser/mesh-read-gate.js`), and separately, rung 10
 *     (store/screen agreement through a freshly attached handle) catches a
 *     silently mis-routed or dead subscription even if some other rung
 *     looked green. Both rungs are this reasoning's standing check.
 */

import { loadBootstrapConfig } from './config.js';
import { loadOrCreateSessionPeerKey } from './identity.js';
import { createEdgeNode } from './edge-node.js';
import { openStrandReadHandle, createStrandRowSource, strandIdForNetwork } from './strand-read.js';
import { startPeerReplication } from './reactivity-bridge.js';
// `attachNetworkDb` is imported under an alias so this file's own acceptance
// grep -- "exactly one occurrence of `attachNetworkDb`" -- resolves to this
// ONE import line, rather than also matching a deps-default line and a call
// line. See this module's header ("WHY attachNetworkDb AND NOT
// openStoreHandle OR new Database") for what the identifier itself means;
// `openUiHandleForNetwork` is this file's own name for that single import,
// used everywhere below.
import { attachNetworkDb as openUiHandleForNetwork, closeNetworkDb, PUBLIC_SUBSCRIBED_TABLES } from '@votetorrent/web-data/public';

export { strandIdForNetwork };

/**
 * `PeerBootError` — a named failure carrying a `subject`, never a message
 * with values in it. Same discipline as `EdgeNodeConfigError`,
 * `StrandReadError` and `PeerReplicationError`: a peer-supplied or
 * strand-read value must never reach an error string.
 */
export class PeerBootError extends Error {
	/**
	 * @param {string} subject - the option, step or table this error concerns
	 * @param {string} reason
	 */
	constructor(subject, reason) {
		super(`peer/boot: ${reason} (subject: "${subject}")`);
		this.name = 'PeerBootError';
		this.subject = subject;
	}
}

/**
 * The frozen result-union vocabulary `startPublicPeerBoot` returns. Never a
 * fifth value; never thrown as a class.
 * @type {Readonly<{ STARTED: 'STARTED', NO_ADDRESS: 'NO_ADDRESS', CONFIG_FAULT: 'CONFIG_FAULT', FAILED: 'FAILED' }>}
 */
export const PEER_BOOT_STATUS = Object.freeze({
	STARTED: 'STARTED',
	NO_ADDRESS: 'NO_ADDRESS',
	CONFIG_FAULT: 'CONFIG_FAULT',
	FAILED: 'FAILED',
});

/**
 * The collection id for one table, under the plugin's own default URI
 * scheme. Pure. See this module's header for the citation this is drawn
 * from.
 * @param {string} table
 * @returns {string}
 */
function collectionIdForTable(table) {
	return `default/${table}`;
}

/**
 * Fetch a collection's current tail block id through the injected node's own
 * `coordinatedRepo`. Throws `PeerBootError` naming the table when the header
 * block is absent — a strand-provisioning defect this module refuses to
 * paper over with a skipped subscription. See this module's header for why
 * that block is expected to already exist.
 * @param {{ coordinatedRepo: { get(blockGets: { blockIds: string[] }): Promise<Record<string, { block?: { tailId?: string } }>> } }} node
 * @param {string} table
 * @returns {Promise<string>}
 */
async function resolveCollectionTailId(node, table) {
	const collectionId = collectionIdForTable(table);
	/** @type {Record<string, { block?: { tailId?: string } }>} */
	let results;
	try {
		results = await node.coordinatedRepo.get({ blockIds: [collectionId] });
	} catch (err) {
		const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
		throw new PeerBootError(table, `coordinatedRepo.get failed while resolving the collection tail (${name})`);
	}
	const result = results ? results[collectionId] : undefined;
	const tailId = result && result.block ? result.block.tailId : undefined;
	if (!tailId) {
		throw new PeerBootError(table, `no committed header block for collection "${collectionId}" -- the strand has never declared this table`);
	}
	return tailId;
}

/**
 * @typedef {object} StartPublicPeerBootDeps
 * @property {typeof loadBootstrapConfig} [loadBootstrapConfig]
 * @property {(url: string, init: any) => Promise<any>} [fetchImpl]
 * @property {string} [pageProtocol]
 * @property {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} [sessionStorage]
 * @property {typeof loadOrCreateSessionPeerKey} [loadOrCreateSessionPeerKey]
 * @property {typeof createEdgeNode} [createEdgeNode]
 * @property {typeof openStrandReadHandle} [openStrandReadHandle]
 * @property {typeof createStrandRowSource} [createStrandRowSource]
 * @property {typeof openUiHandleForNetwork} [openUiHandleForNetwork]
 * @property {typeof closeNetworkDb} [closeNetworkDb]
 * @property {typeof startPeerReplication} [startPeerReplication]
 * @property {ReadonlyArray<string>} [subscribedTables] - defaults to `PUBLIC_SUBSCRIBED_TABLES`; injectable only for the node test.
 */

/**
 * @typedef {object} StartPublicPeerBootOptions
 * @property {string | null | undefined} networkHash
 * @property {string | null | undefined} [electionId] - carried for the caller's own readout; no step below branches on it.
 * @property {StartPublicPeerBootDeps} [deps]
 */

/**
 * @typedef {{ status: 'NO_ADDRESS' }} NoAddressResult
 * @typedef {{ status: 'CONFIG_FAULT', fault: 'missing' | 'malformed' }} ConfigFaultResult
 * @typedef {{ status: 'FAILED', subject: string }} FailedResult
 * @typedef {{ status: 'STARTED', peerId: string | undefined, dbName: string, stop: () => Promise<void> }} StartedResult
 * @typedef {NoAddressResult | ConfigFaultResult | FailedResult | StartedResult} PeerBootResult
 */

/**
 * The one production composition. Never throws, never rejects. See this
 * module's header for the full argument; the eight steps below are the
 * plan's own numbering, preserved so a diff against the plan is legible.
 *
 * @param {StartPublicPeerBootOptions} options
 * @returns {Promise<PeerBootResult>}
 */
export async function startPublicPeerBoot(options) {
	/** @type {StartPublicPeerBootOptions} */
	const opts = options && typeof options === 'object' ? options : { networkHash: null };
	const networkHash = typeof opts.networkHash === 'string' ? opts.networkHash : '';
	/** @type {StartPublicPeerBootDeps} */
	const deps = opts.deps && typeof opts.deps === 'object' ? opts.deps : {};

	const resolved = {
		loadBootstrapConfig: deps.loadBootstrapConfig ?? loadBootstrapConfig,
		/** @type {any} */
		fetchImpl: deps.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined),
		pageProtocol: deps.pageProtocol ?? (typeof globalThis.location !== 'undefined' ? globalThis.location.protocol : undefined),
		/** @type {any} */
		sessionStorage: deps.sessionStorage ?? (typeof globalThis.sessionStorage !== 'undefined' ? globalThis.sessionStorage : undefined),
		loadOrCreateSessionPeerKey: deps.loadOrCreateSessionPeerKey ?? loadOrCreateSessionPeerKey,
		createEdgeNode: deps.createEdgeNode ?? createEdgeNode,
		openStrandReadHandle: deps.openStrandReadHandle ?? openStrandReadHandle,
		createStrandRowSource: deps.createStrandRowSource ?? createStrandRowSource,
		openUiHandleForNetwork: deps.openUiHandleForNetwork ?? openUiHandleForNetwork,
		closeNetworkDb: deps.closeNetworkDb ?? closeNetworkDb,
		startPeerReplication: deps.startPeerReplication ?? startPeerReplication,
		subscribedTables: deps.subscribedTables ?? PUBLIC_SUBSCRIBED_TABLES,
	};

	// -- 1. No usable address: the root, election-less page must not open a
	//       socket, fetch a config or touch storage of any kind.
	if (networkHash === '') {
		return { status: PEER_BOOT_STATUS.NO_ADDRESS };
	}

	// Every acquired resource is tracked by reference (never by a growing
	// unwind-step array) so `unwind` below can run them in ONE fixed order --
	// replications, then the strand-read handle, then the Edge node, then the
	// ui db -- regardless of how many tables were subscribed or which step a
	// mid-boot failure happened to reach. Absent references are no-ops.
	/** @type {any} */
	let edgeNode = null;
	/** @type {any} */
	let strandReadHandle = null;
	/** @type {any} */
	let uiDb = null;
	/** @type {Array<() => Promise<void>>} */
	const replicationStops = [];

	/** Idempotent-safe teardown of everything acquired so far, in the fixed
	 * order this function's own contract promises. Every leg swallows its own
	 * error so one failed teardown never blocks the rest.
	 * @returns {Promise<void>} */
	const unwind = async () => {
		for (let i = replicationStops.length - 1; i >= 0; i -= 1) {
			try {
				await replicationStops[i]();
			} catch {
				// Swallowed -- see this function's own "never throws" contract.
			}
		}
		if (strandReadHandle) {
			try {
				await strandReadHandle.close();
			} catch {
				// Swallowed.
			}
		}
		if (edgeNode) {
			try {
				await edgeNode.stop();
			} catch {
				// Swallowed.
			}
		}
		if (uiDb) {
			try {
				await resolved.closeNetworkDb(uiDb);
			} catch {
				// Swallowed.
			}
		}
	};

	try {
		// -- 2. Bootstrap config. `56-06`'s two-variant classification,
		//       propagated verbatim -- never re-classified, never defaulted.
		const configResult = await resolved.loadBootstrapConfig({
			fetchImpl: resolved.fetchImpl,
			pageProtocol: resolved.pageProtocol,
		});
		if (!configResult.ok) {
			return { status: PEER_BOOT_STATUS.CONFIG_FAULT, fault: configResult.fault };
		}

		// -- 3. Session identity (D-08/D-09). Never the persisted browser-key
		//       helper.
		const privateKey = await resolved.loadOrCreateSessionPeerKey(resolved.sessionStorage);

		// -- 4. The Edge node.
		const strandId = strandIdForNetwork(networkHash);
		edgeNode = await resolved.createEdgeNode({
			strandId,
			networkName: networkHash,
			bootstrapNodes: configResult.bootstrapNodes,
			privateKey,
		});

		// -- 5. The row source (56-16). No stub, no static variant: if this
		//       import ever yields nothing callable, that is a build defect,
		//       not a runtime one -- `openStrandReadHandle`/`createStrandRowSource`
		//       are static imports at the top of this file, so a missing export
		//       fails at import time, before this function ever runs. What this
		//       step guards is the NODE's own coordinatedRepo attachment, which
		//       `edge-node.js` documents as always present on a node it builds.
		const nodeWithRepo = /** @type {{ coordinatedRepo?: unknown }} */ (edgeNode.node);
		if (!nodeWithRepo || !nodeWithRepo.coordinatedRepo) {
			throw new PeerBootError('coordinatedRepo', 'the Edge node carries no coordinatedRepo attachment -- 56-05 always attaches one to a node it builds');
		}
		strandReadHandle = await resolved.openStrandReadHandle({
			networkHash,
			node: edgeNode.node,
			coordinatedRepo: /** @type {any} */ (nodeWithRepo.coordinatedRepo),
		});

		// -- 6. The browser store. See this module's header for why this is
		//       the security-gated attach, and only ever this, once.
		uiDb = await resolved.openUiHandleForNetwork(networkHash);

		const { readRows } = resolved.createStrandRowSource({ uiDb, strandDb: strandReadHandle });

		// -- 7. Start replication, once per publicly-subscribed table, sharing
		//       one `readRows` closure across every subscription. See this
		//       module's header for why a per-table collectionId is what the
		//       question even needs to be, and why sharing `readRows` is safe.
		for (const table of resolved.subscribedTables) {
			const collectionIdString = collectionIdForTable(table);
			const tailId = await resolveCollectionTailId(/** @type {any} */ (edgeNode.node), table);
			// `startPeerReplication` (56-09) requires `collectionId` as RAW BYTES
			// (`ReactivitySubscriptionManagerOptions.collectionId: Uint8Array` --
			// "the collection's stable identity, the collection's id block id, raw
			// bytes"), unlike `tailId`, which stays a `BlockId` string: 56-09's own
			// module converts THAT to bytes internally via `reactivityTailBytes`.
			// `collectionId` carries no coord-matching constraint (only tailId
			// derives the topic/coord), so the plain UTF-8 encoding below is safe
			// -- there is no "wrong" encoding to avoid here, unlike tailId's
			// documented double-hash trap.
			const collectionId = new TextEncoder().encode(collectionIdString);
			const replication = await resolved.startPeerReplication({
				db: uiDb,
				networkHash,
				node: edgeNode.node,
				collectionId,
				tailId,
				readRows,
			});
			replicationStops.push(() => replication.stop());
		}

		// -- 8. Started. `stop()` is idempotent and runs every unwind step,
		//       replications first, then the strand-read handle, then the Edge
		//       node, then the ui db -- neither leg can throw out of it.
		let stopped = false;
		const stop = async () => {
			if (stopped) return;
			stopped = true;
			await unwind();
		};

		const peerId =
			edgeNode.node && edgeNode.node.peerId && typeof edgeNode.node.peerId.toString === 'function'
				? edgeNode.node.peerId.toString()
				: undefined;

		return { status: PEER_BOOT_STATUS.STARTED, peerId, dbName: edgeNode.dbName, stop };
	} catch (err) {
		await unwind();
		const subject =
			err instanceof PeerBootError
				? err.subject
				: err && typeof (/** @type {any} */ (err).name) === 'string'
					? /** @type {any} */ (err).name
					: 'unknown';
		return { status: PEER_BOOT_STATUS.FAILED, subject };
	}
}
