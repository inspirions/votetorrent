/**
 * registration-status.test.ts (Phase 59 plan 59-09) — every branch in
 * `resolveRegistrationStatus`'s `<behavior>` contract, driven entirely from hand-built stub
 * engines through `deps.getEngine` (no provider, no real engine, no network). Uses the
 * production-length network fixture throughout (`59-UI-SPEC.md`'s 49-char
 * "Salt Lake County Unified School District Network"), per this project's standing
 * production-length-fixture rule.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Association, AssociationRequestRead, Registrant} from '@votetorrent/vote-core';
import {resolveRegistrationStatus} from '../registration-status';
import type {RegistrationStatusDeps} from '../registration-status';
import type {
	VoterAssociationRequestTransport,
	VoterRegistrationRequestTransport,
	VoterRequestTransports,
} from '../../screens/registration/attach-voter-request-transport';

const NETWORK_NAME = 'Salt Lake County Unified School District Network'; // 49 chars
const AUTHORITY_ID = 'authority-1';
const DEVICE_KEY = 'p256-device-key-1';
const ELECTION_ID = 'election-1';

function makeNetworkEngine() {
	return {
		getDetails: jest.fn(async () => ({
			network: {
				id: 'network-1',
				hash: 'network-hash-1',
				name: NETWORK_NAME,
				primaryAuthorityId: AUTHORITY_ID,
				relays: [] as string[],
			},
		})),
	};
}

function makeAssociationEngine(opts: {rows?: Association[]; requests?: AssociationRequestRead[]}) {
	return {
		getAssociationsByDeviceKey: jest.fn(async (_deviceKey: string) => opts.rows ?? []),
		listAssociationRequests: jest.fn(async (_authorityId: string) => opts.requests ?? []),
	};
}

function makeRegistrationEngine(registrants: Record<string, Registrant>) {
	return {
		getRegistrant: jest.fn(async (registrantId: string) => registrants[registrantId]),
	};
}

function makeAssociation(registrantId: string, deviceKey: string = DEVICE_KEY): Association {
	return {
		registrantId,
		deviceKey,
		expiration: '2999-01-01T00:00:00.000Z',
		signorKey: 'authority-signor-key',
		signature: 'authority-signature',
	};
}

function makeRegistrant(id: string, status: Registrant['status'], authorityId: string = AUTHORITY_ID): Registrant {
	return {
		id,
		authorityId,
		privateCid: 'private-cid',
		status,
		expiration: '2999-01-01T00:00:00.000Z',
		signorKey: 'authority-signor-key',
		signature: 'authority-signature',
	};
}

function makeRequest(overrides: {
	requestId: string;
	status: AssociationRequestRead['status'];
	deviceKey?: string;
	electionId?: string;
}): AssociationRequestRead {
	return {
		requestId: overrides.requestId,
		authorityId: AUTHORITY_ID,
		registrantId: 'registrant-unrelated',
		deviceKey: overrides.deviceKey ?? DEVICE_KEY,
		electionId: overrides.electionId,
		status: overrides.status,
		submittedAt: '2026-01-01T00:00:00.000Z',
		receivedAt: '2026-01-01T00:00:01.000Z',
	};
}

/** Builds a fully-typed `VoterRequestTransports` stub around a caller-supplied `pollDecisions`
 * spy -- every other method is an unused jest.fn() stub (never called by the leg under test). */
function makeTransports(pollDecisions: VoterAssociationRequestTransport['pollDecisions']): VoterRequestTransports {
	const associationTransport: VoterAssociationRequestTransport = {
		submitRequest: jest.fn(),
		submitAttestation: jest.fn(),
		pollDecisions,
	};
	const registrationTransport: VoterRegistrationRequestTransport = {
		submitRequest: jest.fn(),
		pollDecisions: jest.fn(),
	};
	return {associationTransport, registrationTransport};
}

interface BuildDepsParams {
	provisionDeviceKey?: RegistrationStatusDeps['provisionDeviceKey'];
	networkEngine?: ReturnType<typeof makeNetworkEngine>;
	associationEngine?: ReturnType<typeof makeAssociationEngine>;
	registrationEngine?: ReturnType<typeof makeRegistrationEngine>;
	resolveTransports?: RegistrationStatusDeps['resolveTransports'];
	electionId?: string;
}

function buildDeps(params: BuildDepsParams = {}): RegistrationStatusDeps {
	const networkEngine = params.networkEngine ?? makeNetworkEngine();
	const associationEngine = params.associationEngine ?? makeAssociationEngine({});
	const registrationEngine = params.registrationEngine ?? makeRegistrationEngine({});

	const getEngine = jest.fn(async (engineName: string) => {
		switch (engineName) {
			case 'network':
				return networkEngine;
			case 'association':
				return associationEngine;
			case 'registration':
				return registrationEngine;
			default:
				throw new Error(`registration-status.test.ts stub: unexpected engine "${engineName}"`);
		}
	});

	return {
		getEngine: getEngine as unknown as RegistrationStatusDeps['getEngine'],
		provisionDeviceKey: params.provisionDeviceKey ?? (async () => ({publicKey: DEVICE_KEY})),
		resolveTransports: params.resolveTransports,
		electionId: params.electionId,
	};
}

describe('resolveRegistrationStatus (D-06/D-23, four-outcome derived read)', () => {
	beforeEach(() => {
		(AsyncStorage.setItem as jest.Mock).mockClear();
		(AsyncStorage.multiSet as jest.Mock).mockClear();
	});

	test('registered: an active (a) Registrant for this authority, linked via Association, resolves registered', async () => {
		const registrantId = 'registrant-active';
		const associationEngine = makeAssociationEngine({rows: [makeAssociation(registrantId)]});
		const registrationEngine = makeRegistrationEngine({[registrantId]: makeRegistrant(registrantId, 'a')});

		const result = await resolveRegistrationStatus(buildDeps({associationEngine, registrationEngine}));

		expect(result).toEqual({kind: 'registered', networkName: NETWORK_NAME});
	});

	test('notRegistered (revoked): a revoked (r) Registrant resolves notRegistered, asserted separately from suspended', async () => {
		const registrantId = 'registrant-revoked';
		const associationEngine = makeAssociationEngine({rows: [makeAssociation(registrantId)]});
		const registrationEngine = makeRegistrationEngine({[registrantId]: makeRegistrant(registrantId, 'r')});

		const result = await resolveRegistrationStatus(buildDeps({associationEngine, registrationEngine}));

		expect(result).toEqual({kind: 'notRegistered', networkName: NETWORK_NAME});
	});

	test('notRegistered (suspended): a suspended (s) Registrant resolves notRegistered, asserted separately from revoked', async () => {
		const registrantId = 'registrant-suspended';
		const associationEngine = makeAssociationEngine({rows: [makeAssociation(registrantId)]});
		const registrationEngine = makeRegistrationEngine({[registrantId]: makeRegistrant(registrantId, 's')});

		const result = await resolveRegistrationStatus(buildDeps({associationEngine, registrationEngine}));

		expect(result).toEqual({kind: 'notRegistered', networkName: NETWORK_NAME});
	});

	test('notRegistered (never registered): zero Association rows, no matching request, no transport resolves notRegistered', async () => {
		const associationEngine = makeAssociationEngine({rows: [], requests: []});

		const result = await resolveRegistrationStatus(buildDeps({associationEngine}));

		expect(result).toEqual({kind: 'notRegistered', networkName: NETWORK_NAME});
	});

	test('pending (engine): zero Association rows, a matching request with status p or c resolves pending', async () => {
		const pendingRequest = makeRequest({requestId: 'req-pending', status: 'p'});
		const associationEngineP = makeAssociationEngine({rows: [], requests: [pendingRequest]});
		const resultP = await resolveRegistrationStatus(buildDeps({associationEngine: associationEngineP}));
		expect(resultP).toEqual({kind: 'pending', networkName: NETWORK_NAME});

		const challengeIssuedRequest = makeRequest({requestId: 'req-challenge', status: 'c'});
		const associationEngineC = makeAssociationEngine({rows: [], requests: [challengeIssuedRequest]});
		const resultC = await resolveRegistrationStatus(buildDeps({associationEngine: associationEngineC}));
		expect(resultC).toEqual({kind: 'pending', networkName: NETWORK_NAME});
	});

	test('pending (transport corroboration, D-23 d): zero Association rows, no matching engine request, an attached transport corroborates pending', async () => {
		const associationEngine = makeAssociationEngine({rows: [], requests: []});
		const pollDecisions = jest.fn(async () => [
			{requestId: 'unattributable-request', status: 'p', cursor: 'cursor-1'},
		]);
		const resolveTransports = jest.fn(() => makeTransports(pollDecisions));

		const result = await resolveRegistrationStatus(buildDeps({associationEngine, resolveTransports}));

		expect(result).toEqual({kind: 'pending', networkName: NETWORK_NAME});
		expect(pollDecisions).toHaveBeenCalledTimes(1);
	});

	test('notRegistered (rejected): zero Association rows and the only matching request is rejected (r) resolves notRegistered', async () => {
		const rejectedRequest = makeRequest({requestId: 'req-rejected', status: 'r'});
		const associationEngine = makeAssociationEngine({rows: [], requests: [rejectedRequest]});

		const result = await resolveRegistrationStatus(buildDeps({associationEngine}));

		expect(result).toEqual({kind: 'notRegistered', networkName: NETWORK_NAME});
	});

	test('indeterminate (dangling linkage): an Association row whose Registrant lookup resolves undefined', async () => {
		const registrantId = 'registrant-dangling';
		const associationEngine = makeAssociationEngine({rows: [makeAssociation(registrantId)]});
		const registrationEngine = makeRegistrationEngine({}); // getRegistrant(registrantId) -> undefined

		const result = await resolveRegistrationStatus(buildDeps({associationEngine, registrationEngine}));

		expect(result).toEqual({kind: 'indeterminate', networkName: NETWORK_NAME});
	});

	test('indeterminate (contradiction): zero Association rows but a matching request already shows associated (a)', async () => {
		const associatedRequest = makeRequest({requestId: 'req-associated', status: 'a'});
		const associationEngine = makeAssociationEngine({rows: [], requests: [associatedRequest]});

		const result = await resolveRegistrationStatus(buildDeps({associationEngine}));

		expect(result).toEqual({kind: 'indeterminate', networkName: NETWORK_NAME});
	});

	test('indeterminate (read failure): a throw anywhere in the chain resolves indeterminate, never a silent notRegistered', async () => {
		const associationEngine = makeAssociationEngine({});
		associationEngine.getAssociationsByDeviceKey.mockRejectedValueOnce(new Error('simulated read failure'));
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

		const result = await resolveRegistrationStatus(buildDeps({associationEngine}));

		expect(result).toEqual({kind: 'indeterminate', networkName: NETWORK_NAME});
		errorSpy.mockRestore();
	});

	test('electionId scoping: a request whose electionId differs from deps.electionId is ignored; one with no electionId is accepted', async () => {
		const differingElectionRequest = makeRequest({requestId: 'req-differing', status: 'p', electionId: 'a-different-election'});
		const associationEngineDiffering = makeAssociationEngine({rows: [], requests: [differingElectionRequest]});
		const resultDiffering = await resolveRegistrationStatus(
			buildDeps({associationEngine: associationEngineDiffering, electionId: ELECTION_ID}),
		);
		expect(resultDiffering.kind).toBe('notRegistered');

		const unscopedRequest = makeRequest({requestId: 'req-unscoped', status: 'p', electionId: undefined});
		const associationEngineUnscoped = makeAssociationEngine({rows: [], requests: [unscopedRequest]});
		const resultUnscoped = await resolveRegistrationStatus(
			buildDeps({associationEngine: associationEngineUnscoped, electionId: ELECTION_ID}),
		);
		expect(resultUnscoped.kind).toBe('pending');
	});

	test('transport never claims registered: a pollDecisions notice with status a does not produce registered', async () => {
		const associationEngine = makeAssociationEngine({rows: [], requests: []});
		const pollDecisions = jest.fn(async () => [{requestId: 'unattributable-request', status: 'a', cursor: 'cursor-1'}]);
		const resolveTransports = jest.fn(() => makeTransports(pollDecisions));

		const result = await resolveRegistrationStatus(buildDeps({associationEngine, resolveTransports}));

		expect(result.kind).toBe('notRegistered');
		expect(pollDecisions).toHaveBeenCalledTimes(1);
	});

	test('no persistence: AsyncStorage setItem/multiSet are never called across any resolve', async () => {
		const registrantId = 'registrant-np';
		const associationEngine = makeAssociationEngine({rows: [makeAssociation(registrantId)]});
		const registrationEngine = makeRegistrationEngine({[registrantId]: makeRegistrant(registrantId, 'a')});

		await resolveRegistrationStatus(buildDeps({associationEngine, registrationEngine}));

		expect(AsyncStorage.setItem).not.toHaveBeenCalled();
		expect(AsyncStorage.multiSet).not.toHaveBeenCalled();
	});
});
