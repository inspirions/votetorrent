/**
 * Phase 62 Plan 21 (D-28/D-31/D-32/D-04): attach-peer-sync-binding.ts — the 'peer' sync binding's
 * intake, decision publishing, association processing and live counts (P1-P8, C1, C2, R1-R3).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
	attachPeerSyncBinding,
	createPeerSyncBinding,
	type PeerSyncBindingDeps,
} from '../attach-peer-sync-binding';
import { clearSyncBindings, resolveSyncBinding } from '../bulk-import-sync-model';

function regDoc(id: string, authorityId = 'auth-1') {
	return {
		requestId: id,
		init: { id, authorityId },
		requesterKey: `rk-${id}`,
		signature: { signerUserId: 'req-user', signerKey: 'req-key', signature: `sig-${id}` },
		stagedAt: '2026-01-01T00:00:00.000Z',
		cursor: '0000000000000001',
		digest: 'dg',
	};
}

function assocDoc(id: string, authorityId = 'auth-1') {
	return {
		requestId: id,
		init: { id, authorityId },
		requesterKey: `rk-${id}`,
		signature: { signerUserId: 'req-user', signerKey: 'req-key', signature: `sig-${id}` },
		stagedAt: '2026-01-01T00:00:00.000Z',
		cursor: '0000000000000001',
		digest: 'dg',
	};
}

function makeFakeTransports(overrides: {
	regReport?: { delivered: unknown[]; unreadable: unknown[] };
	decisionRecords?: Array<{ requestId: string }>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	publishDecisionImpl?: (input: any) => Promise<string>;
	assocReqReport?: { delivered: unknown[]; unreadable: unknown[] };
	assocAttReport?: { delivered: unknown[]; unreadable: unknown[] };
}) {
	const registration = {
		readStagedRequestsReport: jest.fn(async () => overrides.regReport ?? { delivered: [], unreadable: [] }),
		readDecisionRecords: jest.fn(async () => overrides.decisionRecords ?? []),
		publishDecision: jest.fn<Promise<string>, [unknown]>(overrides.publishDecisionImpl ?? (async () => 'cursor')),
		close: jest.fn(async () => undefined),
	};
	const association = {
		readStagedRequestsReport: jest.fn(async () => overrides.assocReqReport ?? { delivered: [], unreadable: [] }),
		readStagedAttestationsReport: jest.fn(async () => overrides.assocAttReport ?? { delivered: [], unreadable: [] }),
		close: jest.fn(async () => undefined),
	};
	return { registration, association };
}

function makeDeps(opts: {
	regReport?: { delivered: unknown[]; unreadable: unknown[] };
	decisionRecords?: Array<{ requestId: string }>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	publishDecisionImpl?: (input: any) => Promise<string>;
	assocReqReport?: { delivered: unknown[]; unreadable: unknown[] };
	assocAttReport?: { delivered: unknown[]; unreadable: unknown[] };
	localReg?: Record<string, { status: string; decidedAt?: string; rejectionReason?: string }>;
	localAssoc?: Record<string, { status: string }>;
	submitRegistrationImpl?: (...args: unknown[]) => Promise<unknown>;
	submitAssocReqImpl?: (...args: unknown[]) => Promise<unknown>;
	submitAssocAttImpl?: (...args: unknown[]) => Promise<unknown>;
	createSignerImpl?: () => Promise<(digest: Uint8Array) => Promise<unknown>>;
}) {
	const localReg = opts.localReg ?? {};
	const localAssoc = opts.localAssoc ?? {};

	const regEngine = {
		getRegistrationRequest: jest.fn(async (id: string) => localReg[id]),
		submitRegistrationRequest: jest.fn(opts.submitRegistrationImpl ?? (async () => 'ok')),
	};
	const assocEngine = {
		getAssociationRequest: jest.fn(async (id: string) => localAssoc[id]),
		submitAssociationRequest: jest.fn(opts.submitAssocReqImpl ?? (async () => 'ok')),
		submitAssociationAttestation: jest.fn(opts.submitAssocAttImpl ?? (async () => undefined)),
		processPendingAssociationRequests: jest.fn<
			Promise<{ challengesIssued: number; associated: number; rejected: number }>,
			[string, unknown, unknown]
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		>(async (..._args: any[]) => ({ challengesIssued: 0, associated: 0, rejected: 0 })),
	};
	const intakeEngine = { createOpener: jest.fn(() => ({ open: jest.fn() })) };

	const getEngine = jest.fn(async (name: string) => {
		if (name === 'intake') return intakeEngine;
		if (name === 'registration') return regEngine;
		if (name === 'association') return assocEngine;
		throw new Error(`unknown engine ${name}`);
	});

	const transports = makeFakeTransports(opts);
	const createTransports = jest.fn(() => ({ strandId: 'hash-1', ...transports }));
	const createSigner = jest.fn(
		opts.createSignerImpl ??
			(async () => async (_digest: Uint8Array) => ({ signerUserId: 'u1', signerKey: 'k1', signature: 'sig1' })),
	);

	const deps: PeerSyncBindingDeps = {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		getEngine: getEngine as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createTransports: createTransports as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createSigner: createSigner as any,
	};

	return { deps, regEngine, assocEngine, intakeEngine, transports, createTransports, createSigner };
}

beforeEach(() => {
	clearSyncBindings();
});

describe('createPeerSyncBinding — syncNow (D-28/D-32)', () => {
	it('P1: submits delivered auth-1 docs absent locally, exactly (init, requesterKey, signature); skips other-authority and already-local docs', async () => {
		const docLocal = regDoc('r-local');
		const docNew = regDoc('r-new');
		const docOtherAuth = regDoc('r-other', 'auth-2');
		const { deps, regEngine } = makeDeps({
			regReport: { delivered: [docLocal, docNew, docOtherAuth], unreadable: [] },
			localReg: { 'r-local': { status: 'p' } },
		});
		const binding = createPeerSyncBinding(deps);
		const report = await binding.syncNow({ authorityId: 'auth-1' });

		expect(regEngine.submitRegistrationRequest).toHaveBeenCalledTimes(1);
		expect(regEngine.submitRegistrationRequest).toHaveBeenCalledWith(docNew.init, docNew.requesterKey, docNew.signature);
		expect(report.imported).toBe(1);
	});

	it('P2: a submit rejection adds the requestId to errorItemIds without leaking the thrown message', async () => {
		const doc = regDoc('r1');
		const { deps } = makeDeps({
			regReport: { delivered: [doc], unreadable: [] },
			submitRegistrationImpl: async () => {
				throw new Error('super-secret-leak');
			},
		});
		const binding = createPeerSyncBinding(deps);
		const report = await binding.syncNow({ authorityId: 'auth-1' });

		expect(report.errorItemIds).toContain('r1');
		expect(JSON.stringify(report)).not.toContain('super-secret-leak');
	});

	it("P3: unreadable rows add to errorItemIds except 'not-a-recipient'", async () => {
		const unreadable = [
			{ requestId: 'u1', cursor: '1', requesterKey: 'rk', stagedAt: 't', reason: 'authentication-failed' },
			{ requestId: 'u2', cursor: '2', requesterKey: 'rk', stagedAt: 't', reason: 'no-local-key' },
			{ requestId: 'u3', cursor: '3', requesterKey: 'rk', stagedAt: 't', reason: 'malformed-row' },
			{ requestId: 'u4', cursor: '4', requesterKey: 'rk', stagedAt: 't', reason: 'not-a-recipient' },
		];
		const { deps } = makeDeps({ regReport: { delivered: [], unreadable } });
		const binding = createPeerSyncBinding(deps);
		const report = await binding.syncNow({ authorityId: 'auth-1' });

		expect([...report.errorItemIds].sort()).toEqual(['u1', 'u2', 'u3']);
	});

	it("P4: publishes officer-signed decisions for locally-decided peer requests, treats duplicate-decision as already-published, surfaces rejected as an error, and skips already-decided/pending requests", async () => {
		const docA = regDoc('a1');
		const docR = regDoc('r1');
		const docAlready = regDoc('d1');
		const docPending = regDoc('p1');
		const docDup = regDoc('dup1');
		const docRejected = regDoc('rej1');

		const localReg = {
			a1: { status: 'a', decidedAt: '2026-01-01' },
			r1: { status: 'r', decidedAt: '2026-01-02', rejectionReason: 'bad-reason' },
			d1: { status: 'a', decidedAt: '2026-01-03' },
			p1: { status: 'p' },
			dup1: { status: 'a', decidedAt: '2026-01-04' },
			rej1: { status: 'a', decidedAt: '2026-01-05' },
		};

		const publishDecisionImpl = jest.fn(async (input: { requestId: string }) => {
			if (input.requestId === 'dup1') {
				throw Object.assign(new Error('dup'), { name: 'P2pStagingError', code: 'duplicate-decision' });
			}
			if (input.requestId === 'rej1') {
				throw Object.assign(new Error('rejected'), { name: 'P2pStagingError', code: 'rejected' });
			}
			return 'cursor';
		});

		const { deps } = makeDeps({
			regReport: { delivered: [docA, docR, docAlready, docPending, docDup, docRejected], unreadable: [] },
			localReg,
			decisionRecords: [{ requestId: 'd1' }],
			publishDecisionImpl,
		});
		const binding = createPeerSyncBinding(deps);
		const report = await binding.syncNow({ authorityId: 'auth-1' });

		expect(publishDecisionImpl).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: 'a1', status: 'a', decidedAt: '2026-01-01' }),
		);
		expect(publishDecisionImpl).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: 'r1', status: 'r', reason: 'bad-reason', decidedAt: '2026-01-02' }),
		);
		expect(publishDecisionImpl).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: 'd1' }));
		expect(publishDecisionImpl).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: 'p1' }));
		expect(report.errorItemIds).toContain('rej1');
		expect(report.errorItemIds).not.toContain('dup1');
	});

	it('P5: processPendingAssociationRequests is called exactly once with (authorityId, a sign callback, the association transport), and association docs are filtered by authorityId with pre-resolved signatures', async () => {
		const docAuth = assocDoc('as1');
		const docOther = assocDoc('as2', 'auth-2');
		const { deps, assocEngine, transports } = makeDeps({
			assocReqReport: { delivered: [docAuth, docOther], unreadable: [] },
			submitAssocReqImpl: async () => {
				throw new Error('boom');
			},
		});
		const binding = createPeerSyncBinding(deps);
		await binding.syncNow({ authorityId: 'auth-1' });

		expect(assocEngine.submitAssociationRequest).toHaveBeenCalledTimes(1);
		expect(assocEngine.submitAssociationRequest).toHaveBeenCalledWith(docAuth.init, docAuth.requesterKey, docAuth.signature);
		expect(assocEngine.processPendingAssociationRequests).toHaveBeenCalledTimes(1);
		const call = assocEngine.processPendingAssociationRequests.mock.calls[0]!;
		expect(call[0]).toBe('auth-1');
		expect(typeof call[1]).toBe('function');
		expect(call[2]).toBe(transports.association);
	});

	it('P6: createSigner is never called when nothing needs signing, and is called at most once and propagates its rejection to the first sign() call', async () => {
		const { deps, createSigner, createTransports } = makeDeps({});
		const binding = createPeerSyncBinding(deps);
		await binding.syncNow({ authorityId: 'auth-1' });
		expect(createSigner).not.toHaveBeenCalled();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const decisionSigner = (createTransports as any).mock.calls[0][0].decisionSigner;
		const rejection = new Error('signer unavailable');
		createSigner.mockImplementationOnce(async () => {
			throw rejection;
		});
		await expect(decisionSigner.sign(new Uint8Array([1]))).rejects.toBe(rejection);
		await expect(decisionSigner.sign(new Uint8Array([1]))).rejects.toBe(rejection);
		expect(createSigner).toHaveBeenCalledTimes(1);
	});

	it('P7: both transports are closed exactly once per sync, even when an earlier step throws', async () => {
		const { deps, transports } = makeDeps({});
		(transports.association.readStagedRequestsReport as jest.Mock).mockRejectedValueOnce(new Error('kaboom'));
		const binding = createPeerSyncBinding(deps);
		await expect(binding.syncNow({ authorityId: 'auth-1' })).rejects.toThrow('kaboom');
		expect(transports.registration.close).toHaveBeenCalledTimes(1);
		expect(transports.association.close).toHaveBeenCalledTimes(1);
	});

	it('P8: syncNow rejects before createTransports with no/empty context; a createTransports throw propagates', async () => {
		const { deps, createTransports } = makeDeps({});
		const binding = createPeerSyncBinding(deps);

		await expect(binding.syncNow()).rejects.toThrow();
		await expect(binding.syncNow({ authorityId: '' })).rejects.toThrow();
		expect(createTransports).not.toHaveBeenCalled();

		class FakePeerStrandUnavailableError extends Error {}
		(createTransports as jest.Mock).mockImplementationOnce(() => {
			throw new FakePeerStrandUnavailableError('no-network');
		});
		await expect(binding.syncNow({ authorityId: 'auth-1' })).rejects.toBeInstanceOf(FakePeerStrandUnavailableError);
	});
});

describe('createPeerSyncBinding — readCounts (D-31)', () => {
	it('C1: derives pending/synced/failed from the transport reports plus the last run\'s rejected ids (deduped)', async () => {
		const { deps, transports } = makeDeps({
			regReport: { delivered: [regDoc('rej1')], unreadable: [] },
			submitRegistrationImpl: async () => {
				throw new Error('boom');
			},
		});
		const binding = createPeerSyncBinding(deps);
		const firstReport = await binding.syncNow({ authorityId: 'auth-1' });
		expect(firstReport.errorItemIds).toContain('rej1');

		const regDocLocal = regDoc('r-local');
		const regDocPending = regDoc('r-pending');
		const assocDocPending = assocDoc('as-pending');
		const unreadableAuth = { requestId: 'u-auth', cursor: '1', requesterKey: 'rk', stagedAt: 't', reason: 'authentication-failed' };
		const unreadableNotRecipient = { requestId: 'u-not-recipient', cursor: '2', requesterKey: 'rk', stagedAt: 't', reason: 'not-a-recipient' };

		(transports.registration.readStagedRequestsReport as jest.Mock).mockResolvedValue({
			delivered: [regDocLocal, regDocPending],
			unreadable: [unreadableAuth, unreadableNotRecipient],
		});
		(transports.association.readStagedRequestsReport as jest.Mock).mockResolvedValue({
			delivered: [assocDocPending],
			unreadable: [],
		});
		(transports.association.readStagedAttestationsReport as jest.Mock).mockResolvedValue({ delivered: [], unreadable: [] });
		deps.getEngine = (async (name: string) => {
			if (name === 'intake') return { createOpener: jest.fn(() => ({ open: jest.fn() })) };
			if (name === 'registration') {
				return { getRegistrationRequest: jest.fn(async (id: string) => (id === 'r-local' ? { status: 'p' } : undefined)) };
			}
			if (name === 'association') {
				return { getAssociationRequest: jest.fn(async () => undefined) };
			}
			throw new Error(`unknown engine ${name}`);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		}) as any;

		const counts = await binding.readCounts!({ authorityId: 'auth-1' });
		expect(counts).toEqual({ pending: 2, synced: 1, failed: 2 });
	});

	it('C2: never signs, submits, publishes a decision, or drives processPending; its decision signer rejects if invoked', async () => {
		const { deps, regEngine, assocEngine, createSigner, transports, createTransports } = makeDeps({});
		const binding = createPeerSyncBinding(deps);
		const counts = await binding.readCounts!({ authorityId: 'auth-1' });

		expect(counts).toEqual({ pending: 0, synced: 0, failed: 0 });
		expect(createSigner).not.toHaveBeenCalled();
		expect(regEngine.submitRegistrationRequest).not.toHaveBeenCalled();
		expect(assocEngine.submitAssociationRequest).not.toHaveBeenCalled();
		expect(assocEngine.submitAssociationAttestation).not.toHaveBeenCalled();
		expect(assocEngine.processPendingAssociationRequests).not.toHaveBeenCalled();
		expect(transports.registration.publishDecision).not.toHaveBeenCalled();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const decisionSigner = (createTransports as any).mock.calls[0][0].decisionSigner;
		await expect(decisionSigner.sign(new Uint8Array([1]))).rejects.toThrow();
	});
});

describe('attachPeerSyncBinding / registration (R1-R3, D-28)', () => {
	it('R1: registers a handle resolvable at id "peer" with a readCounts function', () => {
		const { deps } = makeDeps({});
		attachPeerSyncBinding(deps);
		const handle = resolveSyncBinding('peer');
		expect(handle?.id).toBe('peer');
		expect(typeof handle?.readCounts).toBe('function');
	});

	it('R2: the AppProvider effect registering the peer binding has no __DEV__ gate', () => {
		const src = fs.readFileSync(path.resolve(__dirname, '../../../providers/AppProvider.tsx'), 'utf8');
		const idx = src.indexOf('attachPeerSyncBinding(');
		expect(idx).toBeGreaterThan(-1);
		const before = src.lastIndexOf('useEffect(', idx);
		const after = src.indexOf('}, [', idx);
		const block = src.slice(before, after);
		expect(block).not.toContain('__DEV__');
	});

	it('R3: officer-intake-key.ts and attach-peer-sync-binding.ts carry zero createDeviceSigner(/getOrCreateDeviceUser; AppProvider wires createSigner: resolveDeviceSigner', () => {
		function stripComments(s: string): string {
			return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
		}
		const officer = stripComments(fs.readFileSync(path.resolve(__dirname, '../officer-intake-key.ts'), 'utf8'));
		const binding = stripComments(fs.readFileSync(path.resolve(__dirname, '../attach-peer-sync-binding.ts'), 'utf8'));
		expect((officer.match(/createDeviceSigner\(|getOrCreateDeviceUser/g) || []).length).toBe(0);
		expect((binding.match(/createDeviceSigner\(|getOrCreateDeviceUser/g) || []).length).toBe(0);

		const appProvider = fs.readFileSync(path.resolve(__dirname, '../../../providers/AppProvider.tsx'), 'utf8');
		expect(appProvider).toMatch(/createSigner:\s*resolveDeviceSigner/);
	});
});
