import type { TransportSyncState } from "../../components/TransportStatusCard";

/**
 * bulk-import-sync-model.ts — the pure, RN-safe view-model for the Bulk Import / Sync screen
 * (D-01/D-11). Owns the binding injection seam (the registry below), the per-card state
 * resolution (`resolveTransportCardState`), and the error-row derivation (`toSyncErrorRefs`).
 * Plain TypeScript only — no React, no `react-native`, no `@votetorrent/*` import of any kind —
 * so every rule this file owns is unit-testable without a renderer.
 *
 * (b) THE BUNDLING RULE. `FilesystemRegistrationTransport` (48-09) imports `node:fs/promises` and
 * is therefore NOT RN-bundleable: it carries no `transport/index.ts` barrel and is unreachable
 * from `@votetorrent/vote-engine`'s root barrel for exactly that reason. Neither this file nor the
 * screen may import ANY transport module — by barrel OR by deep path — because either route would
 * drag `node:fs` toward the Metro bundle and reproduce the failure class Phase 44's `@peculiar`
 * device-boot wall cost two plans to unstick, invisibly to jest (jest runs on Node, where the
 * import resolves fine; the failure only surfaces as a device boot crash). Instead, bindings
 * arrive through the registry below, attached by whichever host CAN construct them — exactly as
 * the app already reaches its engines through `useApp().getEngine()` instead of importing engine
 * classes directly.
 *
 * (c) THE D-11 RULE. The peer-cluster leg ships **code-complete, unverified**: P2P-11 is
 * device-REFUTED, its wall has moved repeatedly, and this project has already lived through
 * "implemented but unproven" being read as "done" more than once. This file attaches NO peer
 * binding, and `SyncBindingId` deliberately excludes a peer/p2p member so a peer binding cannot be
 * registered at this seam without an out-loud type change — see `INERT_PEER_SYNC` below.
 *
 * (d) THE PII RULE. A sync error carries an **identifier** and nothing else. A failing item is a
 * registration payload containing real registrant PII, so `SyncErrorRef` and
 * `TransportSyncReport.errorItemIds` are structured so no payload value, requester name, or
 * transport error/response-body text can travel from a binding to this screen.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The set of transports this screen can drive from a real, attached binding. `'peer'` was
 * DELIBERATELY ABSENT through 48-20 — the same structural-severance discipline 48-17 used when it
 * left `'p2p'` out of `TransportKind` — so that registering a peer binding and driving the peer
 * card from it would be a type error here, not a style choice: the out-loud step this severance
 * existed to force.
 *
 * **48-23, 2026-08-06: `'peer'` is now admitted.** This member's addition IS that out-loud step.
 * The peer-cluster leg it routes to is **code-complete, unverified** (D-11) — admitting the id at
 * this seam does not change that, and it does not change what the peer card SHOWS:
 * `ExperimentalTransportStatusCard` (48-17) still accepts only `disabled?` and `onTrySync`, with
 * no state channel of any kind. Widening this union changes what the peer control's press CAN DO
 * (resolve a `'peer'` binding through the seam below) — never what the card renders.
 */
export type SyncBindingId = "filesystem" | "rest" | "peer";

/**
 * What a binding's `syncNow()` resolves to. `errorItemIds` is an array of `string` and NOT a
 * record type — there is structurally no field through which a payload value, a requester name,
 * or an HTTP response body could travel from a transport to this screen. A host adapting 48-09's
 * `skipped` accumulator or 48-10's non-2xx error mapping takes the filename / item id and drops
 * everything else. Do NOT widen this to carry a `reason`, a `message`, or a `detail` — doing so
 * would reopen exactly the leak 48-10 closed at the binding.
 */
export interface TransportSyncReport {
	syncedAt: string;
	imported: number;
	pending: number;
	errorItemIds: readonly string[];
}

/**
 * A view-model shape, NOT `IRegistrationRequestTransport` itself. The screen must never hold a
 * transport instance, because holding one would require importing one (see the bundling rule
 * above). A host wraps its real binding — `FilesystemRegistrationTransport` reading staged
 * documents, or `RestRegistrationTransport` polling its endpoint — in this handle and registers
 * it via `registerSyncBinding`. The transport seam's own discipline is unchanged and unweakened:
 * a handle never receives, derives, or holds key material.
 */
export interface SyncBindingHandle {
	id: SyncBindingId;
	syncNow: () => Promise<TransportSyncReport>;
}

/**
 * Exactly two members. THE TYPE IS THE PII GATE (T-48-20-02): there is no third member and no
 * optional member. Adding one is precisely how this screen would begin to leak a payload value or
 * a transport's error text into the rendered errors section — any future addition must justify
 * itself against T-48-20-02 in `48-20-PLAN.md`.
 */
export interface SyncErrorRef {
	transport: SyncBindingId;
	itemId: string;
}

/** The per-transport screen state `resolveTransportCardState` consumes. */
export interface TransportCardEntry {
	report?: TransportSyncReport;
	failed?: boolean;
}

// ---------------------------------------------------------------------------
// The registry — the injection seam a host attaches a real binding through.
// ---------------------------------------------------------------------------

const bindings = new Map<SyncBindingId, SyncBindingHandle>();

/**
 * Stores `handle` by `handle.id`. This is the attachment point for the two real D-01 bindings —
 * the REST binding is RN-constructible (built-in `fetch` only) and is attached wherever its
 * `baseUrl` is configured, typically at app bootstrap; the filesystem binding is attached by the
 * Node-side host that owns the drop directory (the bulk-import bridge process, or the on-device
 * harness leg 48-22 drives), because `node:fs/promises` is not Metro-resolvable and can never be
 * attached from inside the RN app itself.
 *
 * This plan registers nothing here — it owns the seam and the screen, not the app's transport
 * configuration. A later host wiring plan is responsible for calling this function.
 */
export function registerSyncBinding(handle: SyncBindingHandle): void {
	bindings.set(handle.id, handle);
}

/** Resolves the handle registered for `id`, or `undefined` when nothing has attached yet. */
export function resolveSyncBinding(id: SyncBindingId): SyncBindingHandle | undefined {
	return bindings.get(id);
}

/**
 * Test hygiene only: clears every registered binding. Module-level mutable state that no test can
 * reset is its own defect class — one test's `registerSyncBinding` call must never leak into the
 * next test's assertions.
 */
export function clearSyncBindings(): void {
	bindings.clear();
}

// ---------------------------------------------------------------------------
// The inert peer action.
// ---------------------------------------------------------------------------

/**
 * Through 48-20, this was the peer card's ONLY handler — pressing it invoked this no-op and
 * nothing else, and the peer card's action was inert by construction.
 *
 * **48-23: the peer card's `onTrySync` now routes through `runSync('peer')` in the screen
 * instead of this export.** `INERT_PEER_SYNC` stays exported anyway — 48-20's own test suite
 * asserts it exists and returns `undefined` (Suite F), and this export is retained precisely so
 * that assertion keeps documenting the transition it was written to describe: the peer card WAS
 * structurally inert through 48-20, and is now wired through the seam. The peer-cluster leg
 * itself remains **code-complete, unverified** (D-11) either way — this export's retirement from
 * the call site changes nothing about that.
 */
export const INERT_PEER_SYNC = (): void => {};

// ---------------------------------------------------------------------------
// State resolution — the interdependent card props, resolved together.
// ---------------------------------------------------------------------------

export interface TransportCardState {
	syncState: TransportSyncState;
	lastSyncedAt?: string;
	importedCount?: number;
	pendingCount?: number;
	errorCount?: number;
}

/**
 * One pure function returning the interdependent props TOGETHER, mirroring the
 * `provisioningCopy` / `transportCopy` discipline (`AttestationProvisioningStatusScreen.tsx`,
 * `TransportStatusCard.tsx`), so a state can never be paired with the wrong counts. Three
 * explicit branches, no fallthrough:
 *
 * - no `report` and not `failed` -> `'never'`, every other member `undefined` — the card renders
 *   `bulkImportSyncNeverSyncedBody` and omits its counts line entirely.
 * - `failed` -> `'error'`, carrying the LAST successful report's values when one exists,
 *   otherwise `undefined`. A failed sync must not erase what the previous successful sync
 *   legitimately reported. As of 48-24, the card consumes that carried-forward `lastSyncedAt` as
 *   a separately-labelled "last successful sync" line that is omitted entirely when undefined —
 *   so carrying the previous report's timestamp forward through an error state is now honest
 *   instead of being the source of a dangling claim (48-UAT.md gap 1).
 * - a `report` with no failure -> `'success'`, with `lastSyncedAt`/`importedCount`/
 *   `pendingCount`/`errorCount` read straight off the report.
 */
export function resolveTransportCardState(entry: TransportCardEntry): TransportCardState {
	if (entry.failed) {
		const report = entry.report;
		return {
			syncState: "error",
			lastSyncedAt: report?.syncedAt,
			importedCount: report?.imported,
			pendingCount: report?.pending,
			errorCount: report ? report.errorItemIds.length : undefined,
		};
	}

	if (!entry.report) {
		return { syncState: "never" };
	}

	return {
		syncState: "success",
		lastSyncedAt: entry.report.syncedAt,
		importedCount: entry.report.imported,
		pendingCount: entry.report.pending,
		errorCount: entry.report.errorItemIds.length,
	};
}

// ---------------------------------------------------------------------------
// Error-row derivation.
// ---------------------------------------------------------------------------

/**
 * Returns `SyncErrorRef[]` in FIXED transport order (filesystem, then rest, then peer) and, within
 * a transport, in the order the binding reported. This mirrors the card order above it — an officer
 * reading top-to-bottom never has to reconcile two different orderings on one screen. Reads ONLY
 * `errorItemIds`; it must never read `imported`, `pending`, or `syncedAt`, and it accepts no
 * free-text argument of any kind.
 *
 * WR-15: the order array now covers all THREE `SyncBindingId` members. 48-23 widened
 * `SyncBindingId` to include `'peer'` and routed the peer card's press through `runSync('peer')`,
 * but left this array at `["filesystem", "rest"]` — so a peer binding's `errorItemIds` had nowhere
 * to go and were discarded AFTER the seam had already admitted the id. `TransportSyncReport` is
 * structurally a per-transport contract, which makes that a silent DROP rather than a display
 * choice: the officer saw a card and a press that reported nothing.
 *
 * What this widening does NOT do: it softens the D-11 posture nowhere. The peer card still carries
 * no state channel at all (`ExperimentalTransportStatusCardProps` is exactly
 * `{disabled?, onTrySync}`) and still renders its unconditional warning treatment; this function
 * still reads ONLY `errorItemIds`, never `imported`/`pending`/`syncedAt`; and a caught transport
 * error's `message` is never placed into a report in the first place
 * (`BulkImportSyncScreen`'s `.catch()`), so no endpoint- or peer-supplied text can reach a rendered
 * row through this path (T-48-20-02). Only opaque item identifiers do, exactly as for the two
 * proven bindings.
 *
 * Keep this array EXHAUSTIVE over `SyncBindingId`. A fourth member added to the union without a
 * matching entry here reintroduces exactly this defect, and nothing in the type system catches it.
 */
export function toSyncErrorRefs(
	entries: Partial<Record<SyncBindingId, TransportSyncReport>>,
): SyncErrorRef[] {
	const order: SyncBindingId[] = ["filesystem", "rest", "peer"];
	const refs: SyncErrorRef[] = [];
	for (const transport of order) {
		const report = entries[transport];
		if (!report) continue;
		for (const itemId of report.errorItemIds) {
			refs.push({ transport, itemId });
		}
	}
	return refs;
}

// ---------------------------------------------------------------------------
// D-19 — the association processing trigger, composed onto the SAME "rest"
// binding registration already uses.
// ---------------------------------------------------------------------------

/**
 * D-19 SHAPE DECISION (51-10): `SyncBindingId` stays exactly
 * `"filesystem" | "rest" | "peer"` — NO fourth `"association"` member was
 * added. `BulkImportSyncScreen.tsx` is untouched by this plan and renders
 * exactly three cards, each with its own "Sync Now" press wired to
 * `runSync(id)`; a fourth `SyncBindingId` with no card ever calling
 * `runSync("association")` would register a binding NOTHING in the running
 * app ever invokes — the exact "correct code, unreachable by the app"
 * defect class this phase is scored against (`e64e112`, the Phase 48
 * registration stack the voter never referenced). D-19 also says ONE
 * trigger, and a fourth card would itself be a NEW pressable control, which
 * is what the rejected-alternatives note in `51-CONTEXT.md` calls out.
 *
 * Instead, `attach-association-sync-bindings.ts` COMPOSES onto the existing
 * `"rest"` id through this module's own registry seam
 * (`resolveSyncBinding`/`registerSyncBinding` — exactly the "attached by
 * whichever host CAN construct them" mechanism this file's header already
 * documents): it resolves whatever `"rest"` handle registration's
 * `attach-sync-bindings.ts` already registered, wraps it so `syncNow()`
 * calls the ORIGINAL handle first and then drives association processing,
 * merges the two `TransportSyncReport`s with `mergeTransportSyncReports`
 * below, and re-registers the combined handle under the SAME `"rest"` id.
 * The REST card's existing "Sync Now" press is therefore the one press that
 * now drives both legs. `TransportSyncReport` keeps its 4 fields unchanged
 * — merging counts and concatenating `errorItemIds` needs no new field.
 *
 * Composition ordering is load-bearing: `attach-sync-bindings.ts` must
 * attach FIRST (registering the real registration `"rest"` handle) before
 * `attach-association-sync-bindings.ts` attaches (capturing that handle as
 * its `previous`, then overwriting the registry entry with the combined
 * one). `AppProvider.tsx` sequences the two calls in that order.
 */
export function mergeTransportSyncReports(
	a: TransportSyncReport,
	b: TransportSyncReport,
): TransportSyncReport {
	return {
		syncedAt: b.syncedAt,
		imported: a.imported + b.imported,
		pending: a.pending + b.pending,
		errorItemIds: [...a.errorItemIds, ...b.errorItemIds],
	};
}

/**
 * The D-19 ordering/pre-filter discipline (T-51-10-09), extracted as a pure,
 * plain-TypeScript helper so it is directly unit-testable without a
 * renderer, an engine, or a network call — `attach-association-sync-bindings.ts`
 * supplies the real staged-document reads, the real engine submit calls, and
 * the real driver call; this function owns only the ORDER and the
 * unconditional-driver-call guarantee.
 *
 * ORDERING, AND WHAT IS AND IS NOT LOAD-BEARING: `submitRequest` and
 * `submitAttestation` STAGE and PRE-FILTER only; they mutate nothing in the
 * transport intake a caller's `processPending` reads from, so a real driver
 * (`processPendingAssociationRequests`, 51-09) independently RE-READS and
 * RE-VALIDATES every staged document through its own
 * `validateStagedAttestationAnswer` check (51-08). A pre-filter rejection
 * here therefore does not — and must not be read as — preventing the driver
 * from seeing the document. `processPending` is called EXACTLY ONCE,
 * UNCONDITIONALLY, after both loops — regardless of whether either loop
 * produced an error. Do NOT add a branch that skips `processPending` when
 * `errorItemIds` is non-empty: that is precisely how a security check
 * becomes correct code the running app never reaches.
 *
 * Both staged-read calls are independently fail-conservative: a rejected
 * `readStagedRequests`/`readStagedAttestations` is treated as an empty
 * batch (an honest, empty sync), never a thrown error that would abort the
 * unconditional `processPending` call below.
 */
export async function runAssociationSync<TReq, TAtt>(params: {
	readStagedRequests: () => Promise<readonly TReq[]>;
	readStagedAttestations: () => Promise<readonly TAtt[]>;
	requestIdOf: (doc: TReq) => string;
	attestationIdOf: (doc: TAtt) => string;
	submitRequest: (doc: TReq) => Promise<unknown>;
	submitAttestation: (doc: TAtt) => Promise<unknown>;
	processPending: () => Promise<unknown>;
}): Promise<TransportSyncReport> {
	const errorItemIds: string[] = [];
	let imported = 0;

	let stagedRequests: readonly TReq[] = [];
	try {
		stagedRequests = await params.readStagedRequests();
	} catch {
		stagedRequests = [];
	}
	for (const doc of stagedRequests) {
		try {
			await params.submitRequest(doc);
			imported += 1;
		} catch {
			errorItemIds.push(params.requestIdOf(doc));
		}
	}

	let stagedAttestations: readonly TAtt[] = [];
	try {
		stagedAttestations = await params.readStagedAttestations();
	} catch {
		stagedAttestations = [];
	}
	for (const doc of stagedAttestations) {
		try {
			await params.submitAttestation(doc);
			imported += 1;
		} catch {
			errorItemIds.push(params.attestationIdOf(doc));
		}
	}

	// UNCONDITIONAL — see the doc comment above. No branch above this line
	// may return early or otherwise skip this call.
	await params.processPending();

	return { syncedAt: new Date().toISOString(), imported, pending: 0, errorItemIds };
}
