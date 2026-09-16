/**
 * registration-status.ts (Phase 59 plan 59-09, D-06 via D-23) — the derived, four-outcome
 * registration-status read for the Timeline tab's Registration Ends panel.
 *
 * Implements D-06 (the "You are registered" panel is a REAL read, not a mock boolean) via D-23's
 * derivation mechanism: the answer is computed fresh, every time, from the authority-signed
 * `Association`/`Registrant` rows this device can prove it owns — nothing is cached client-side.
 * D-23 rejected the mechanism originally drafted for this feature (persist the locally-minted
 * `registrantId` to `AsyncStorage`), for reasons restated briefly here (full reasoning:
 * `59-CONTEXT.md` D-23): a cached id would lie about a request that may still be rejected, it
 * duplicates a fact the `Association` table already holds, and it widens the existing plaintext-
 * `AsyncStorage` device-key surface (`device-user.ts`) for no gain.
 *
 * The device's stable handle is the P-256 public key `resolveAttestationProducer().provisionDeviceKey()`
 * returns — NOT `getOrCreateDeviceUser()`'s secp256k1 key. `ConfirmationScreen.tsx` uses two
 * distinct keypairs in the registration ceremony: the P-256 key is the one `Association.DeviceKey`
 * is keyed on; the secp256k1 key only signs the registration REQUEST document. Passing the wrong
 * key here would return an empty result forever and the panel would read "not registered"
 * permanently, with no error anywhere. This module never imports `getOrCreateDeviceUser` — Task
 * 3's source gate enforces that.
 *
 * Four outcomes, closed union — `registered` / `pending` / `notRegistered` / `indeterminate`. The
 * result carries nothing beyond an optional display network name: no registrantId, no device key,
 * no status code, no rejection reason — the same disclosure posture `classifyAttestationFailure`
 * already uses for the ceremony's own failure UX (raw reject codes / internal error text never
 * reach the UI).
 */
import type {Association, IAssociationEngine, INetworkEngine, IRegistrationEngine} from '@votetorrent/vote-core';
import {resolveVoterRequestTransports} from '../screens/registration/attach-voter-request-transport';

export type RegistrationStatusKind = 'registered' | 'pending' | 'notRegistered' | 'indeterminate';

export interface RegistrationStatusResult {
	kind: RegistrationStatusKind;
	/** The real network's display name — resolved before any short-circuit/failure that would
	 * leave it unknown. Never a hardcoded string. */
	networkName?: string;
}

export interface RegistrationStatusDeps {
	/** `useVoterApp()`'s own composition-root read. */
	getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>;
	/** The P-256 device-key provisioner — pass `() => resolveAttestationProducer().provisionDeviceKey()`,
	 * never `getOrCreateDeviceUser` (see this file's header). */
	provisionDeviceKey: () => Promise<{publicKey: string}>;
	/** Defaults to `resolveVoterRequestTransports` — injected so every branch below is testable
	 * without the real `__DEV__` + base-URL transport gate. */
	resolveTransports?: () => ReturnType<typeof resolveVoterRequestTransports>;
	/** Narrows `listAssociationRequests` results to this election — a request whose own
	 * `electionId` is set and differs is ignored; a request with no `electionId` is accepted
	 * regardless. */
	electionId?: string;
}

/**
 * Resolves the four-outcome registration status for this device, deriving everything from the
 * `Association`/`Registrant` rows and outstanding `AssociationRequestRead`s this device's own
 * P-256 key can prove it owns. See this file's header for the full D-06/D-23 rationale.
 */
export async function resolveRegistrationStatus(deps: RegistrationStatusDeps): Promise<RegistrationStatusResult> {
	let networkName: string | undefined;
	try {
		// The P-256 device key — the SAME key `Association.DeviceKey` is keyed on
		// (`ConfirmationScreen.tsx:154-155`). Never the secp256k1 `deviceUserKey`.
		const {publicKey: p256DeviceKey} = await deps.provisionDeviceKey();

		const network = await deps.getEngine<INetworkEngine>('network');
		const details = await network.getDetails();
		networkName = details.network.name;
		const authorityId = details.network.primaryAuthorityId;

		const association = await deps.getEngine<IAssociationEngine>('association');
		const rows: Association[] = await association.getAssociationsByDeviceKey(p256DeviceKey);

		if (rows.length > 0) {
			const registration = await deps.getEngine<IRegistrationEngine>('registration');
			let sawDanglingLinkage = false;
			for (const row of rows) {
				const registrant = await registration.getRegistrant(row.registrantId);
				if (registrant === undefined) {
					// An Association row with no matching Registrant is a contradiction, not a
					// silent "not registered" — surfaced as indeterminate below once every row has
					// been checked (a LATER row could still resolve `registered`).
					sawDanglingLinkage = true;
					continue;
				}
				// Allow-list `status === 'a'` — NEVER `status !== 'r'`, which would let a
				// suspended ('s') registrant render as registered (T-59-09-01).
				if (registrant.authorityId === authorityId && registrant.status === 'a') {
					return {kind: 'registered', networkName};
				}
			}
			if (sawDanglingLinkage) {
				return {kind: 'indeterminate', networkName};
			}
			// Every row resolved to a real Registrant, none active for this authority — covers
			// both revoked ('r') and suspended ('s') alike, asserted as separate cases by the test.
			return {kind: 'notRegistered', networkName};
		}

		// F4: `getEngine('association')` only resolves once a network ctx is established —
		// `EngineFactory.buildEngine`'s `'association'` case calls `requireEstablishedCtx()`,
		// which THROWS when no network is established. So a resolved `association` engine always
		// has a bound ctx, and an empty `rows`/`requests` result here is a real, determinate
		// empty — not a silent unbound-engine result that should be treated as indeterminate.
		const requests = await association.listAssociationRequests(authorityId);
		const mine = requests.filter(
			r =>
				r.deviceKey === p256DeviceKey &&
				(r.electionId === undefined || deps.electionId === undefined || r.electionId === deps.electionId),
		);
		if (mine.some(r => r.status === 'p' || r.status === 'c')) {
			return {kind: 'pending', networkName};
		}
		if (mine.some(r => r.status === 'a')) {
			// An associated request with no Association row is a contradiction, not a "no".
			return {kind: 'indeterminate', networkName};
		}
		// Empty, or only rejected ('r') requests — fall through to the transport corroboration
		// leg before concluding `notRegistered`.

		// D-23(d)'s explicitly named corroborating leg — deliberately narrow: one call, never a
		// loop, never a re-delivery/cursor walk. In every normal build `resolveTransports()`
		// returns `undefined` (F2: `__DEV__` AND a configured base URL are both required), so this
		// leg is skipped entirely outside a device-proof session.
		const transports = (deps.resolveTransports ?? resolveVoterRequestTransports)();
		if (transports) {
			// `AssociationDecisionNotice` carries NO `deviceKey` (F3), and the ceremony's own
			// `associationRequestId` lives in a `useRef` D-23 forbids persisting — so a notice
			// cannot be attributed to THIS device. This leg is therefore permitted to move
			// `notRegistered -> pending` ONLY, never to claim `registered`: showing "awaiting a
			// decision" to a device whose feed happens to carry someone else's request is
			// strictly less of a lie than telling a voter who just completed the ceremony that
			// they are not registered.
			const notices = await transports.associationTransport.pollDecisions();
			if (notices.some(n => n.status === 'p' || n.status === 'c')) {
				return {kind: 'pending', networkName};
			}
			// A notice with status 'a' must NEVER produce `registered` here — intentionally
			// ignored, falling through to `notRegistered` below.
		}

		return {kind: 'notRegistered', networkName};
	} catch (err) {
		// Mirrors ConfirmationScreen.tsx:299 — logged for the dev console, but the raw error text
		// never reaches the UI (T-59-09-03's disclosure posture).
		console.error('resolveRegistrationStatus: read failed:', err);
		return {kind: 'indeterminate', networkName};
	}
}
