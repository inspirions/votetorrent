import type {
	AssociationAttestationAnswer,
	AssociationRequestInit,
	RegistrationRequestInit,
	Signature,
} from '@votetorrent/vote-core';

/**
 * attach-voter-request-transport.ts — DEVELOPMENT / DEVICE-PROOF ATTACHMENT ONLY (D-01/D-07).
 *
 * This is the VOTER SIDE mirror of
 * `apps/VoteTorrentAuthority/src/screens/registration/attach-sync-bindings.ts`. Where that file
 * constructs the REST binding for the AUTHORITY to pull staged requests, this file constructs the
 * SAME two REST bindings (`RestRegistrationTransport`, `RestAssociationTransport`) for the VOTER to
 * SUBMIT a self-signed registration request and a self-signed association request/attestation
 * answer — the D-07 replacement for the voter running the authority's `'vrg'` ceremony itself
 * (ConfirmationScreen.tsx).
 *
 * WHAT THIS FILE MUST NEVER DO (each load-bearing, each mechanically gated):
 *   - Never import the drop-file courier bindings (the `node:fs/promises`-backed sibling modules
 *     under each transport directory) — those modules are deliberately unreachable from the RN
 *     bundle (Phase 44's `@peculiar` device-boot wall cost two plans to unstick; jest is
 *     structurally blind to this class of failure because jest runs on Node, where the import
 *     resolves fine).
 *   - Never ship with a hardcoded base URL. `DEV_VOTER_REQUEST_REST_BASE_URL` below has NO
 *     default; a normal checkout/build leaves it `undefined` and `resolveVoterRequestTransports()`
 *     then returns `undefined`, byte-identically inert. A device-proof session sets this before
 *     the app cold-starts, and reverting it before this file is ever committed with a real value is
 *     that session's mandatory teardown obligation. A base URL left configured in a shipped build
 *     is a live outbound submission target.
 *   - Never hold key material. Both transports receive a completed `Signature` or a
 *     digest-to-`Signature` callback bound to the voter's own P-256/secp256k1 device key — never a
 *     raw private key (D-01/D-19).
 *
 * WR-17: TWO independent conditions must hold before anything is constructed, and they are
 * deliberately not collapsed into one. `__DEV__` is the BUILD-time condition (a release build
 * constructs nothing, whatever the constant says); the base URL is the SESSION-time condition (a
 * dev build with no target configured also constructs nothing).
 */

/** Local restatement of the seam's signature union (matches the authority-side courier's own
 * convention of redeclaring rather than importing a private transport type). */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>);

/** The minimal structural shape this file needs from `IRegistrationRequestTransport` — declared
 * here rather than imported from `@votetorrent/vote-engine`, so this file's only vote-engine
 * imports stay the two deep relative `require`s below. */
export interface VoterRegistrationRequestTransport {
	submitRequest(
		init: RegistrationRequestInit,
		requesterKey: string,
		signatureOrCallback: SignatureOrCallback,
	): Promise<string>;
	pollDecisions(sinceCursor?: string): Promise<
		Array<{requestId: string; status: string; reason?: string; cursor: string}>
	>;
}

/** The minimal structural shape this file needs from `IAssociationRequestTransport` (D-18: a
 * distinct `submitAttestation` leg alongside `submitRequest`). */
export interface VoterAssociationRequestTransport {
	submitRequest(
		init: AssociationRequestInit,
		requesterKey: string,
		signatureOrCallback: SignatureOrCallback,
	): Promise<string>;
	submitAttestation(
		answer: AssociationAttestationAnswer,
		requesterKey: string,
		signatureOrCallback: SignatureOrCallback,
	): Promise<void>;
	pollDecisions(sinceCursor?: string): Promise<
		Array<{requestId: string; status: string; challengeNonce?: string; reason?: string; cursor: string}>
	>;
}

type RestRegistrationTransportCtor = new (options: {baseUrl: string}) => VoterRegistrationRequestTransport;
type RestAssociationTransportCtor = new (options: {baseUrl: string}) => VoterAssociationRequestTransport;

// Deep RELATIVE dist-path requires — deliberately NOT bare "@votetorrent/vote-engine" specifiers.
// See attach-sync-bindings.ts's own header for the full rationale (package "exports" map blocks
// deep subpaths under unstable_enablePackageExports; a relative import bypasses that map because it
// governs bare-specifier resolution only). Both `__DEV__`-gated and lazily `require`d so a release
// build's module graph never includes them — Metro replaces `__DEV__` with a literal `false` in a
// release transform, making the branch below unreachable there.
function loadRestRegistrationTransport(): RestRegistrationTransportCtor | undefined {
	if (!__DEV__) return undefined;
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require('../../../../../packages/vote-engine/dist/registration/transport/rest-registration-transport.js')
		.RestRegistrationTransport as RestRegistrationTransportCtor;
}

function loadRestAssociationTransport(): RestAssociationTransportCtor | undefined {
	if (!__DEV__) return undefined;
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require('../../../../../packages/vote-engine/dist/association/transport/rest-association-transport.js')
		.RestAssociationTransport as RestAssociationTransportCtor;
}

// No default. A device-proof session sets this before the app cold-starts (and must revert it to
// `undefined` afterward); a normal checkout/build leaves it `undefined`, and
// `resolveVoterRequestTransports()` then returns `undefined` — a byte-identical no-op.
export const DEV_VOTER_REQUEST_REST_BASE_URL: string | undefined = undefined;

export interface VoterRequestTransports {
	registrationTransport: VoterRegistrationRequestTransport;
	associationTransport: VoterAssociationRequestTransport;
}

/**
 * Resolves both REST bindings the voter's registration ceremony submits through, or `undefined`
 * when either the build-time or the session-time gate is closed. `undefined` is the CORRECT
 * behavior when the authority cannot be reached — the caller (`ConfirmationScreen`) must treat it
 * as a user-visible "cannot reach the authority" condition, never a crash.
 */
export function resolveVoterRequestTransports(): VoterRequestTransports | undefined {
	// WR-17: two independent conditions, deliberately not collapsed into one.
	if (!__DEV__) return undefined;
	const baseUrl = DEV_VOTER_REQUEST_REST_BASE_URL;
	if (!baseUrl) return undefined;

	const RestRegistrationTransport = loadRestRegistrationTransport();
	const RestAssociationTransport = loadRestAssociationTransport();
	// Unreachable while `__DEV__` is true, but checked because both loaders are gated: an
	// unattached harness must be a silent "no transports" result, never a throw.
	if (!RestRegistrationTransport || !RestAssociationTransport) return undefined;

	return {
		registrationTransport: new RestRegistrationTransport({baseUrl}),
		associationTransport: new RestAssociationTransport({baseUrl}),
	};
}
