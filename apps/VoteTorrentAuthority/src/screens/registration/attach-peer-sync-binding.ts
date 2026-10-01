import type { Signature } from '@votetorrent/vote-core';
import type {
	IKeyVault,
	P2pAssociationTransport,
	P2pRegistrationTransport,
	P2pStagedAssociationRequest,
	P2pStagedAttestation,
	P2pStagedRequest,
	StagingDecisionSigner,
	StagingOpener,
	StagingReadReport,
	StagingUnreadableRow,
} from '@votetorrent/vote-engine/rn';
import {
	registerSyncBinding,
	runAssociationSync,
	type PeerSyncCounts,
	type SyncBindingContext,
	type SyncBindingHandle,
	type TransportSyncReport,
} from './bulk-import-sync-model';
import { resolveAuthorityKeyVault } from '../../engines/key-vault';
import type { PeerStagingTransports } from '../../engines/engine-factory';

/**
 * attach-peer-sync-binding.ts — Phase 62 Plan 21 (D-28/D-31/D-32).
 *
 * The 'peer' `SyncBindingHandle`: `syncNow` intakes this authority's staged registration and
 * association requests from the strand, publishes officer-signed registration decisions for
 * locally-decided peer requests, and drives association processing with the P2P transport AS the
 * intake. `readCounts` derives pending/synced/failed from the transport's own reports, signing
 * nothing.
 *
 * D-28: `attachPeerSyncBinding` is called UNCONDITIONALLY from `AppProvider.tsx` — no dev-only
 * build gate, no configuration. P2P is the default intake path, unlike the REST/filesystem dev/device-
 * proof harnesses (`attach-sync-bindings.ts`/`attach-association-sync-bindings.ts`).
 *
 * D-32: the transports come from the factory's `createPeerStagingTransports`, bound to
 * `strandId = currentNetworkHash`; this file never opens a strand itself.
 *
 * D-23: the peer leg is code-complete and unverified on devices (proof debt against P2P-11).
 *
 * Count semantics (D-31, planner discretion): `pending`/`synced` are derived from the transport's
 * own delivered reports against this authority's local read model — pending = delivered and not
 * yet locally present, synced = delivered and locally present. `failed` = the set of unreadable
 * row ids (excluding `'not-a-recipient'` — those rows are sealed to OTHER officers/authorities
 * sharing the strand, never a failure of this device) unioned with the ids this device's last run
 * itself failed to submit/publish.
 *
 * This file imports no filesystem or REST transport module, and contains no dev-only build gate. `createSigner`
 * is a REQUIRED injected dependency — this file never imports the injected signer factory module
 * directly, so it is not a new rollout invoker (see `officer-intake-key.ts`'s identical discipline).
 */

export interface PeerSyncBindingDeps {
	getEngine: <T>(engineName: string) => Promise<T>;
	createTransports: (deps: { opener: StagingOpener; decisionSigner: StagingDecisionSigner }) => PeerStagingTransports;
	resolveVault?: () => IKeyVault;
	createSigner: () => Promise<(digest: Uint8Array) => Promise<Signature>>;
}

/** The minimal local structural type this file needs from `IntakeEngine`. */
interface PeerIntakeEngine {
	createOpener(vault: IKeyVault): StagingOpener;
}

/** The minimal local structural type this file needs from `RegistrationEngine`. */
interface PeerRegistrationEngine {
	getRegistrationRequest(
		requestId: string,
	): Promise<{ status: string; decidedAt?: string; rejectionReason?: string } | undefined>;
	submitRegistrationRequest(init: unknown, requesterKey: string, signatureOrCallback: Signature): Promise<string>;
}

/** The minimal local structural type this file needs from `AssociationEngine`. */
interface PeerAssociationEngine {
	getAssociationRequest(requestId: string): Promise<{ status: string } | undefined>;
	submitAssociationRequest(init: unknown, requesterKey: string, signatureOrCallback: Signature): Promise<string>;
	submitAssociationAttestation(answer: unknown, requesterKey: string, signatureOrCallback: Signature): Promise<void>;
	processPendingAssociationRequests(
		authorityId: string,
		signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>),
		intake: P2pAssociationTransport,
	): Promise<{ challengesIssued: number; associated: number; rejected: number }>;
}

/** Structural check (not `instanceof`) — `P2pStagingError` crosses from vote-engine's barrel. */
function isP2pStagingError(err: unknown, code?: string): boolean {
	if (typeof err !== 'object' || err === null) return false;
	const e = err as { name?: unknown; code?: unknown };
	if (e.name !== 'P2pStagingError') return false;
	return code === undefined ? typeof e.code === 'string' : e.code === code;
}

/** Memoizes the first `createSigner()` call; `sign` itself is invoked lazily, on its own first call. */
function lazySigner(
	createSigner: () => Promise<(digest: Uint8Array) => Promise<Signature>>,
): (digest: Uint8Array) => Promise<Signature> {
	let resolved: Promise<(digest: Uint8Array) => Promise<Signature>> | undefined;
	return async (digest: Uint8Array): Promise<Signature> => {
		if (resolved === undefined) {
			resolved = createSigner();
		}
		const signer = await resolved;
		return signer(digest);
	};
}

/** Drops `'not-a-recipient'` rows — sealed to other officers/authorities sharing the strand, not a
 * failure of this device (see the module header). */
function countableUnreadableIds<T>(report: StagingReadReport<T>): string[] {
	return report.unreadable
		.filter((row: StagingUnreadableRow) => row.reason !== 'not-a-recipient')
		.map((row) => row.requestId);
}

export function createPeerSyncBinding(deps: PeerSyncBindingDeps): SyncBindingHandle {
	let lastRunRejected = new Set<string>();

	async function requireAuthorityId(context: SyncBindingContext | undefined): Promise<string> {
		const authorityId = context?.authorityId;
		if (typeof authorityId !== 'string' || authorityId.length === 0) {
			throw new Error('peer sync requires an authority');
		}
		return authorityId;
	}

	async function syncNow(context?: SyncBindingContext): Promise<TransportSyncReport> {
		const authorityId = await requireAuthorityId(context);

		const intake = await deps.getEngine<PeerIntakeEngine>('intake');
		const vault = (deps.resolveVault ?? resolveAuthorityKeyVault)();
		const opener = intake.createOpener(vault);
		const sign = lazySigner(deps.createSigner);
		const decisionSigner: StagingDecisionSigner = { authorityId, sign };
		const { registration, association } = deps.createTransports({ opener, decisionSigner });

		const errorItemIds = new Set<string>();
		let imported = 0;
		let pending = 0;

		try {
			const regEngine = await deps.getEngine<PeerRegistrationEngine>('registration');

			// (a) registration intake.
			const regReport = await registration.readStagedRequestsReport();
			for (const id of countableUnreadableIds(regReport)) errorItemIds.add(id);
			const authRegDocs = regReport.delivered.filter((doc: P2pStagedRequest) => doc.init.authorityId === authorityId);
			for (const doc of authRegDocs) {
				const existing = await regEngine.getRegistrationRequest(doc.requestId);
				if (existing) continue;
				try {
					await regEngine.submitRegistrationRequest(doc.init, doc.requesterKey, doc.signature);
					imported += 1;
				} catch {
					errorItemIds.add(doc.requestId);
				}
			}

			// (b) registration decision reconcile — the only Authority path that publishes
			// registration decisions to the strand. Runs on the officer's peer sync, never at
			// decide time, and skips any request that already has a decision row.
			const decided = new Set((await registration.readDecisionRecords()).map((d) => d.requestId));
			for (const doc of authRegDocs) {
				const local = await regEngine.getRegistrationRequest(doc.requestId);
				if (!local) continue;
				if ((local.status === 'a' || local.status === 'r') && local.decidedAt !== undefined && !decided.has(doc.requestId)) {
					try {
						await registration.publishDecision({
							requestId: doc.requestId,
							status: local.status as 'a' | 'r',
							reason: local.status === 'r' ? local.rejectionReason : undefined,
							decidedAt: local.decidedAt,
						});
					} catch (err) {
						if (!isP2pStagingError(err, 'duplicate-decision')) {
							errorItemIds.add(doc.requestId);
						}
					}
				}
			}

			// (c) association — the P2P transport IS the intake (D-06 via 62-15).
			const assocEngine = await deps.getEngine<PeerAssociationEngine>('association');
			const assocReqReport = await association.readStagedRequestsReport();
			const assocAttReport = await association.readStagedAttestationsReport();
			for (const id of countableUnreadableIds(assocReqReport)) errorItemIds.add(id);
			for (const id of countableUnreadableIds(assocAttReport)) errorItemIds.add(id);
			const authAssocDocs = assocReqReport.delivered.filter(
				(doc: P2pStagedAssociationRequest) => doc.init.authorityId === authorityId,
			);

			const assocResult = await runAssociationSync<P2pStagedAssociationRequest, P2pStagedAttestation>({
				readStagedRequests: async () => authAssocDocs,
				readStagedAttestations: async () => assocAttReport.delivered,
				requestIdOf: (doc) => doc.requestId,
				attestationIdOf: (doc) => doc.requestId,
				submitRequest: (doc) => assocEngine.submitAssociationRequest(doc.init, doc.requesterKey, doc.signature),
				submitAttestation: (doc) =>
					assocEngine.submitAssociationAttestation(doc.answer, doc.requesterKey, doc.signature),
				alreadyImportedRequest: async (doc) => (await assocEngine.getAssociationRequest(doc.requestId)) !== undefined,
				alreadyImportedAttestation: async (doc) => {
					const row = await assocEngine.getAssociationRequest(doc.requestId);
					return row === undefined || row.status !== 'c';
				},
				processPending: () => assocEngine.processPendingAssociationRequests(authorityId, sign, association),
			});
			imported += assocResult.imported;
			for (const id of assocResult.errorItemIds) errorItemIds.add(id);

			// (d) pending — delivered authorityId requests (registration + association) still not
			// local after the run.
			for (const doc of authRegDocs) {
				if (!(await regEngine.getRegistrationRequest(doc.requestId))) pending += 1;
			}
			for (const doc of authAssocDocs) {
				if (!(await assocEngine.getAssociationRequest(doc.requestId))) pending += 1;
			}
		} finally {
			await registration.close();
			await association.close();
			lastRunRejected = new Set(errorItemIds);
		}

		return {
			syncedAt: new Date().toISOString(),
			imported,
			pending,
			errorItemIds: [...errorItemIds],
		};
	}

	async function readCounts(context: SyncBindingContext): Promise<PeerSyncCounts> {
		const authorityId = await requireAuthorityId(context);

		const intake = await deps.getEngine<PeerIntakeEngine>('intake');
		const vault = (deps.resolveVault ?? resolveAuthorityKeyVault)();
		const opener = intake.createOpener(vault);
		// Read-only: this signer must never be invoked. readCounts never signs, submits, publishes
		// a decision, or drives processPending.
		const readOnlySign = async (): Promise<Signature> => {
			throw new Error('attach-peer-sync-binding: readCounts must never sign');
		};
		const decisionSigner: StagingDecisionSigner = { authorityId, sign: readOnlySign };
		const { registration, association } = deps.createTransports({ opener, decisionSigner });

		const failed = new Set<string>(lastRunRejected);
		let pending = 0;
		let synced = 0;

		try {
			const regEngine = await deps.getEngine<PeerRegistrationEngine>('registration');
			const assocEngine = await deps.getEngine<PeerAssociationEngine>('association');

			const regReport = await registration.readStagedRequestsReport();
			for (const id of countableUnreadableIds(regReport)) failed.add(id);
			for (const doc of regReport.delivered.filter((d: P2pStagedRequest) => d.init.authorityId === authorityId)) {
				if (await regEngine.getRegistrationRequest(doc.requestId)) synced += 1;
				else pending += 1;
			}

			const assocReqReport = await association.readStagedRequestsReport();
			for (const id of countableUnreadableIds(assocReqReport)) failed.add(id);
			for (const doc of assocReqReport.delivered.filter(
				(d: P2pStagedAssociationRequest) => d.init.authorityId === authorityId,
			)) {
				if (await assocEngine.getAssociationRequest(doc.requestId)) synced += 1;
				else pending += 1;
			}

			const assocAttReport = await association.readStagedAttestationsReport();
			for (const id of countableUnreadableIds(assocAttReport)) failed.add(id);
		} finally {
			await registration.close();
			await association.close();
		}

		return { pending, synced, failed: failed.size };
	}

	return { id: 'peer', syncNow, readCounts };
}

/** Registers the 'peer' binding unconditionally (D-28 — no dev-only build gate). */
export function attachPeerSyncBinding(deps: PeerSyncBindingDeps): void {
	registerSyncBinding(createPeerSyncBinding(deps));
}
