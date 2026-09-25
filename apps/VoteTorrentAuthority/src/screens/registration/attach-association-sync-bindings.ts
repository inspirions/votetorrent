import type { AssociationAttestationAnswer, AssociationRequestInit, Signature } from "@votetorrent/vote-core";
import {
	mergeTransportSyncReports,
	registerSyncBinding,
	resolveSyncBinding,
	runAssociationSync,
	type SyncBindingHandle,
	type TransportSyncReport,
} from "./bulk-import-sync-model";
import { getOrCreateDeviceUser } from "../../engines/device-user";
import { createDeviceSigner } from "../../engines/device-signer";
// Deep RELATIVE filesystem import — deliberately NOT a "@votetorrent/vote-engine" bare package
// specifier, for the SAME reason `attach-sync-bindings.ts:5-34` documents in full for the
// registration sibling: @votetorrent/vote-engine's package.json "exports" map lists only "." and
// "./rn", so a bare-specifier deep subpath is blocked by that map in both Metro and Jest, and a
// literal RELATIVE path bypasses "exports" entirely because that field governs bare-specifier
// resolution only. `__DEV__`-gated and lazy (never a top-level static import) for the identical
// WR-17 reason: a static import would put this REST transport, and this five-level relative path
// into a git-ignored `dist/` tree, into the module graph of EVERY build, reachable from
// `AppProvider` on every launch. The require keeps a LITERAL path string: Metro cannot resolve a
// computed specifier, and a resolution failure must stay a loud build-time error.
type RestAssociationTransportCtor = new (options: { baseUrl: string }) => {
	pollDecisions(sinceCursor?: string): Promise<unknown[]>;
};

function loadRestAssociationTransport(): RestAssociationTransportCtor | undefined {
	if (!__DEV__) return undefined;
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require("../../../../../packages/vote-engine/dist/association/transport/rest-association-transport.js")
		.RestAssociationTransport as RestAssociationTransportCtor;
}

/**
 * attach-association-sync-bindings.ts — DEVELOPMENT / DEVICE-PROOF ATTACHMENT ONLY (D-01/D-19).
 *
 * Structural analog of `attach-sync-bindings.ts` (registration, 48-22). Copies verbatim: the
 * no-default base-URL constant declared below, the WR-17 TWO-INDEPENDENT-CONDITIONS gate
 * (`__DEV__` at build time AND the base URL at session time, kept as two separate `if`
 * statements), and the `__DEV__`-gated lazy `require` of the deep relative `dist/` path above.
 *
 * WHAT THIS FILE DOES NOT DO, THE SAME WAY THE REGISTRATION SIBLING DOES NOT:
 *   - Never ship with a hardcoded base URL. `DEV_ASSOCIATION_SYNC_REST_BASE_URL` has NO default; a
 *     normal checkout/build leaves it `undefined` and `attachAssociationSyncBindings()` registers
 *     nothing, byte-identically inert.
 *   - Never receive, derive, or hold a requester's or an officer's private key. Every submit call
 *     below forwards an already-resolved `Signature` UNCHANGED; the driver call is signed via
 *     `createDeviceSigner`'s `SignCallback`, which sends only a digest across the native bridge
 *     and receives back a signature (D-01) — no JS code in this app ever sees a private-key byte.
 *
 * D-19 SHAPE DECISION — see `bulk-import-sync-model.ts`'s own doc comment beside
 * `mergeTransportSyncReports`/`runAssociationSync` for the full rationale. In short: this file adds
 * NO new `SyncBindingId` member and registers NOTHING new for the UI to discover — it COMPOSES onto
 * the existing `"rest"` binding registration's `attach-sync-bindings.ts` already registers, via the
 * SAME registry seam (`resolveSyncBinding`/`registerSyncBinding`) that seam's own header already
 * documents as "attached by whichever host CAN construct them". The REST card's existing "Sync Now"
 * press is therefore the ONE press D-19 requires, driving both legs. `AppProvider.tsx` sequences
 * `attachSyncBindings()` before `attachAssociationSyncBindings()` so `previousRest` below captures
 * the real registration handle before this file overwrites the registry entry with the combined one.
 *
 * THE BRIDGE PROTOCOL THIS FILE READS (throwaway, dev-only — never a claim about 51-06's locked
 * `IAssociationRequestTransport` R-1/R-2/R-3 wire protocol, which is the SUBMITTER's view and is
 * exercised separately below via `transport.pollDecisions()`). This file is the AUTHORITY-side
 * intake for the REST binding, which `rest-association-transport.ts`'s own header states does NOT
 * live on `RestAssociationTransport` — it lives in whatever dev-only bridge server a device-proof
 * session runs. This file defines that bridge's listing shape itself (there is no locked protocol
 * to conform to), served only by 51-13's own throwaway host bridge script:
 *   - `GET {baseUrl}/staged-association-requests` -> `{ staged: StagedAssociationRequestJson[] }`
 *   - `GET {baseUrl}/staged-association-attestations` -> `{ staged: StagedAttestationJson[] }`
 *   - `POST {baseUrl}/association-decisions` `AssociationDecisionJson` -> `{ cursor: string }`
 * Each `StagedAssociationRequestJson.init` carries its own `authorityId` (D-02's
 * `AssociationRequestInit.authorityId` field) — the authority id the driver call below needs is
 * read off the FIRST staged request document observed in a run, never hardcoded and never inferred
 * from a device-level concept this app has no notion of. A run with no staged request document
 * (e.g. only staged attestations answering already-known requests) falls back to `""`: the driver
 * call is still made UNCONDITIONALLY (see the `processPending` comment below), and both of its legs
 * scope every read by `AuthorityId = :rowAuthorityId`, so an empty id simply matches zero rows — a
 * harmless no-op, never a thrown error and never a fabricated claim about which authority ran.
 */

// No default. A device-proof session sets this before the app cold-starts; a normal checkout/build
// leaves it `undefined`, and `attachAssociationSyncBindings()` then registers nothing — a
// byte-identical no-op. See 51-10-SUMMARY.md for the exact value 51-13's hardware ceremony uses.
export const DEV_ASSOCIATION_SYNC_REST_BASE_URL: string | undefined = undefined;

/** The bridge's per-document shape for a staged association request (leg 1, D-02/D-18). A
 * superset of what this file reads is tolerated (unused keys are ignored), never a subset. */
interface StagedAssociationRequestJson {
	requestId: string;
	init: AssociationRequestInit;
	requesterKey: string;
	signature: Signature;
}

/** The bridge's per-document shape for a staged attestation answer (leg 2, D-18). */
interface StagedAttestationJson {
	requestId: string;
	answer: AssociationAttestationAnswer;
	requesterKey: string;
	signature: Signature;
}

/** The minimal local structural type this file needs from `IAssociationEngine` (widened, per
 * 51-09-SUMMARY.md, with an optional-but-runtime-required third `intake` parameter on
 * `processPendingAssociationRequests` beyond `IAssociationEngine`'s declared 2-arg signature) —
 * declared here rather than imported from `@votetorrent/vote-engine`, so this file's only
 * vote-engine import stays the one deep relative `require` documented above. */
interface AssociationIntakeEngine {
	submitAssociationRequest(
		init: AssociationRequestInit,
		requesterKey: string,
		signatureOrCallback: Signature,
	): Promise<string>;
	submitAssociationAttestation(
		answer: AssociationAttestationAnswer,
		requesterKey: string,
		signatureOrCallback: Signature,
	): Promise<void>;
	processPendingAssociationRequests(
		authorityId: string,
		signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>),
		intake: RestBridgeAssociationIntake,
	): Promise<{ challengesIssued: number; associated: number; rejected: number }>;
	/** WR-07 (51-REVIEW): the idempotency read. Resolves `undefined` for an unknown id rather
	 * than throwing, so it is safe to call speculatively on every staged document. */
	getAssociationRequest(requestId: string): Promise<{ status: string } | undefined>;
}

/**
 * The authority-side intake this file constructs itself, backed by the throwaway dev bridge
 * described above. Implements the SAME three-method shape `filesystem-association-transport.ts`
 * declares as `IAssociationRequestIntake` (readStagedRequests/readStagedAttestations/
 * publishDecision) structurally, without importing that vote-engine type — matching this file's
 * own "only the one deep `require`" discipline. Every read is fail-conservative: an unreachable or
 * non-2xx bridge resolves to an empty batch, an honest empty sync, never a thrown error.
 */
class RestBridgeAssociationIntake {
	constructor(private readonly baseUrl: string) {}

	async readStagedRequests(): Promise<StagedAssociationRequestJson[]> {
		try {
			const res = await fetch(`${this.baseUrl}/staged-association-requests`);
			if (!res.ok) return [];
			const body = (await res.json()) as { staged?: unknown };
			return Array.isArray(body.staged) ? (body.staged as StagedAssociationRequestJson[]) : [];
		} catch {
			return [];
		}
	}

	async readStagedAttestations(): Promise<StagedAttestationJson[]> {
		try {
			const res = await fetch(`${this.baseUrl}/staged-association-attestations`);
			if (!res.ok) return [];
			const body = (await res.json()) as { staged?: unknown };
			return Array.isArray(body.staged) ? (body.staged as StagedAttestationJson[]) : [];
		} catch {
			return [];
		}
	}

	async publishDecision(decision: {
		requestId: string;
		status: string;
		challengeNonce?: string;
		reason?: string;
		decidedAt: string;
	}): Promise<string> {
		try {
			const res = await fetch(`${this.baseUrl}/association-decisions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(decision),
			});
			if (!res.ok) return "";
			const body = (await res.json()) as { cursor?: unknown };
			return typeof body.cursor === "string" ? body.cursor : "";
		} catch {
			// Best-effort — a decision-publish failure must not throw out of the driver's own
			// transaction. Swallowed, mirroring this file's other fail-conservative reads.
			return "";
		}
	}
}

const EMPTY_REPORT: TransportSyncReport = { syncedAt: new Date(0).toISOString(), imported: 0, pending: 0, errorItemIds: [] };

/**
 * Attaches the D-19 association-processing trigger onto the EXISTING `"rest"` sync binding, when
 * (and only when) a base URL is configured. Called from `AppProvider.tsx`, AFTER
 * `attachSyncBindings()` (registration) has already run — ordering is load-bearing, see this
 * file's own header.
 */
export function attachAssociationSyncBindings(getEngine: <T>(engineName: string) => Promise<T>): void {
	// WR-17: TWO independent conditions, kept as two separate `if` statements — see
	// `attach-sync-bindings.ts`'s own header for the full rationale this copies verbatim.
	if (!__DEV__) return;
	const baseUrl = DEV_ASSOCIATION_SYNC_REST_BASE_URL;
	if (!baseUrl) return;

	const RestAssociationTransport = loadRestAssociationTransport();
	// Unreachable while `__DEV__` is true, but typed as optional because the loader is gated: an
	// unattached harness must be a silent no-op, never a boot-time throw.
	if (!RestAssociationTransport) return;
	const transport = new RestAssociationTransport({ baseUrl });
	const intake = new RestBridgeAssociationIntake(baseUrl);

	// D-19 composition — see this file's own header. Captured ONCE, at attach time: the real
	// registration "rest" handle `attach-sync-bindings.ts` already registered (or `undefined` if
	// that file has not run, or has not attached — both honest, both handled below).
	const previousRest = resolveSyncBinding("rest");

	const handle: SyncBindingHandle = {
		id: "rest",
		syncNow: async (): Promise<TransportSyncReport> => {
			const registrationReport = previousRest ? await previousRest.syncNow() : EMPTY_REPORT;

			// Exercise the constructed, real binding with a harmless read so this combined Sync Now
			// speaks the real association transport, not merely holds an unused instance beside a
			// hand-rolled fetch. Best-effort: a poll failure must not abort the sync below.
			try {
				await transport.pollDecisions();
			} catch {
				// Swallowed — see comment above.
			}

			const engine = await getEngine<AssociationIntakeEngine>("association");

			// The authority id the driver call needs is read off the first staged REQUEST document
			// observed this run (see this file's header) — never hardcoded, never guessed.
			let authorityId: string | undefined;
			const associationReport = await runAssociationSync<StagedAssociationRequestJson, StagedAttestationJson>({
				readStagedRequests: async () => {
					const staged = await intake.readStagedRequests();
					if (authorityId === undefined && staged.length > 0) {
						authorityId = staged[0]!.init.authorityId;
					}
					return staged;
				},
				readStagedAttestations: () => intake.readStagedAttestations(),
				requestIdOf: (doc) => doc.requestId,
				attestationIdOf: (doc) => doc.requestId,
				submitRequest: (doc) =>
					// The documented intake pattern (see attach-sync-bindings.ts's own header): the
					// already-resolved Signature crosses unchanged, never a callback — this app never
					// holds and must never hold the requester's private key.
					engine.submitAssociationRequest(doc.init, doc.requesterKey, doc.signature),
				submitAttestation: (doc) =>
					engine.submitAssociationAttestation(doc.answer, doc.requesterKey, doc.signature),
				// WR-07: the bridge's staged reads take no cursor and nothing ever deletes a staged
				// document, so every document from every previous sync is re-offered on every press
				// of Sync Now. Before these predicates, press 2 reported press 1's successful import
				// as a sync ERROR — a duplicate `AssociationRequest.Id` on the request leg, a
				// `Status !== 'c'` rejection on the attestation leg — forever, for every previously
				// imported document, drowning the genuine-error signal.
				//
				// Neither predicate weakens anything: both submit calls are STAGE-and-PRE-FILTER
				// only, and `processPending` below independently re-reads and re-validates every
				// staged document through `validateStagedAttestationAnswer`.
				alreadyImportedRequest: async (doc) =>
					(await engine.getAssociationRequest(doc.requestId)) !== undefined,
				alreadyImportedAttestation: async (doc) => {
					// An attestation answer is actionable ONLY against a row awaiting one. A missing
					// row, or one already decided ('a'/'r'), or one not yet challenged ('p'), is not
					// an error to report on this leg — it is simply not this document's turn.
					const row = await engine.getAssociationRequest(doc.requestId);
					return row === undefined || row.status !== "c";
				},
				processPending: async () => {
					// UNCONDITIONAL — called every time, regardless of what happened in the two loops
					// above, and regardless of whether an authority id was observed this run. See
					// `runAssociationSync`'s own doc comment (T-51-10-09): the two submit calls STAGE
					// and PRE-FILTER only; this driver independently re-reads and re-validates every
					// staged document through `validateStagedAttestationAnswer` (51-08/51-09), so
					// skipping this call on a pre-filter outcome would be exactly the defect class
					// this rule exists to prevent. When no staged request document was observed this
					// run, `authorityId` falls back to `""` — both legs of the driver scope their
					// reads by `AuthorityId = :rowAuthorityId`, so an empty/unknown id simply matches
					// zero rows (a harmless no-op, identical in effect to any OTHER authority's id),
					// never a thrown error and never a fabricated claim about which authority ran.
					const user = await getOrCreateDeviceUser("Device User");
					const sign = await createDeviceSigner(user.name);
					await engine.processPendingAssociationRequests(authorityId ?? "", sign, intake);
				},
			});

			return mergeTransportSyncReports(registrationReport, associationReport);
		},
	};

	registerSyncBinding(handle);
}
