import type { RegistrationRequestInit, RegistrationBridgeKeyInit, Signature } from "@votetorrent/vote-core";
import { registerSyncBinding, type SyncBindingHandle, type TransportSyncReport } from "./bulk-import-sync-model";
import { getOrCreateDeviceUser } from "../../engines/device-user";
import { createDeviceSigner } from "../../engines/device-signer";
// Deep RELATIVE filesystem import — deliberately NOT a "@votetorrent/vote-engine" bare package
// specifier. @votetorrent/vote-engine's package.json "exports" map lists only "." and "./rn";
// Metro runs with unstable_enablePackageExports: true (metro.config.js), so any bare-specifier
// deep subpath (e.g. "@votetorrent/vote-engine/dist/registration/transport/...") is BLOCKED by
// that map in both Metro and Jest (jest.config.js's own moduleNameMapper comment confirms:
// "The package exports field blocks subpath access"). A literal RELATIVE path bypasses "exports"
// entirely — that field governs bare-specifier package-name resolution only, never a relative
// import — and this exact target was verified module-by-module to contain zero runtime
// node:fs/node:http/other-Node-builtin references: rest-registration-transport.js -> utils.js ->
// database/initialize.js -> database/schema-sql.js + database/tid-allocator.js. schema-sql.js's
// own header states it is "Bundled so initDB never needs Node fs / import.meta (Hermes cannot
// parse import.meta)"; its lone "fs" occurrence is inside a code-generation COMMENT describing how
// the file was regenerated, not a runtime import.
import { RestRegistrationTransport } from "../../../../../packages/vote-engine/dist/registration/transport/rest-registration-transport.js";

/**
 * attach-sync-bindings.ts — DEVELOPMENT / DEVICE-PROOF ATTACHMENT ONLY (D-01).
 *
 * This file is the RN-side attachment site `bulk-import-sync-model.ts` (48-20) deliberately did
 * NOT own: it constructs the REST-constructible binding (`RestRegistrationTransport`, 48-10) and
 * registers it into `registerSyncBinding('rest', ...)` so the device leg's "Sync Now" is a real
 * network call, never a simulation.
 *
 * WHAT THIS FILE MUST NEVER DO (each load-bearing, each mechanically gated):
 *   - Never import `filesystem-registration-transport` (48-09) — that module imports
 *     `node:fs/promises` and is deliberately unreachable from the RN bundle (Phase 44's `@peculiar`
 *     device-boot wall cost two plans to unstick; jest is structurally blind to this class of
 *     failure because jest runs on Node, where the import resolves fine).
 *   - Never register a `'peer'` id at this seam — that severance belongs to 48-20/48-23 and this
 *     file does not spend it.
 *   - Never ship with a hardcoded base URL. `DEV_REGISTRATION_SYNC_REST_BASE_URL` below has NO
 *     default; a normal checkout/build leaves it `undefined` and `attachSyncBindings()` then
 *     registers nothing, byte-identically inert. Setting it — and reverting it before this file is
 *     ever committed with a real value — is Task 3's mandatory teardown obligation. A base URL left
 *     configured in a shipped build is a live outbound sync target.
 *
 * THE INTAKE PATTERN this file implements for REST mirrors, field for field, the pattern
 * `filesystem-registration-transport.ts`'s own `IRegistrationRequestIntake.readStagedRequests` doc
 * comment already documents for the filesystem binding: "hand each result to
 * `RegistrationEngine.submitRegistrationRequest(doc.init, doc.requesterKey, doc.signature)` —
 * passing the already-resolved Signature, never a callback, because the authority does not hold
 * and must never hold the requester's key." `RestRegistrationTransport` implements only the
 * SUBMITTER-facing `IRegistrationRequestTransport` (submitRequest/pollDecisions) — it declares no
 * authority-side intake interface of its own (48-10 left that gap open). This file bridges that
 * gap with a small, NON-locked-protocol listing fetch (`GET {baseUrl}/staged-requests`) — served
 * only by this plan's own throwaway host bridge script, never a claim about 48-10's locked R-1/R-2/
 * R-3 wire protocol — and then applies the SAME documented hand-off to the local engine.
 *
 * A bridge-issued staged document's `RegistrationRequest.BridgeIdValid` CHECK requires a matching,
 * un-revoked `RegistrationBridgeKey` row to already exist. This file provisions any bridge keys the
 * listing response names, signed by the device's OWN local signer (`createDeviceSigner` — the
 * same non-interactive signer `AppProvider.tsx` already calls, unprompted, for dev-fixture seeding
 * at boot). A duplicate registration for an already-provisioned key id is expected to fail (PK
 * collision) and is swallowed; it does not block the batch. This file makes no claim that the
 * resulting `AdminSignature` reflects a genuinely provisioned 'vrg' officer — this phase's own
 * documented finding stands unchanged: the 'vrg' gate is a UI legibility control, not a
 * schema-enforced boundary.
 */

// No default. A device-proof session sets this before the app cold-starts (and Task 3's teardown
// reverts it to `undefined` afterward); a normal checkout/build leaves it `undefined`, and
// `attachSyncBindings()` then registers nothing — a byte-identical no-op.
export const DEV_REGISTRATION_SYNC_REST_BASE_URL: string | undefined = 'http://10.0.2.2:8791';

/** The shape the throwaway host bridge's `GET /staged-requests` response carries per document —
 * a superset of what this file reads is tolerated (unused keys are ignored), never a subset. */
interface StagedRequestJson {
	requestId: string;
	init: RegistrationRequestInit;
	requesterKey: string;
	signature: Signature;
}

/** The shape the same response carries per bridge key that must be provisioned before its
 * documents can pass `BridgeIdValid` at local insert. */
interface StagedBridgeKeyJson {
	id: string;
	authorityId: string;
	label: string;
	key: string;
}

/** The minimal local structural type this file needs from `IRegistrationEngine` — declared here
 * rather than imported from `@votetorrent/vote-engine`, so this file's only vote-engine import
 * stays the one deep relative path documented above. */
interface RegistrationIntakeEngine {
	submitRegistrationRequest(
		init: RegistrationRequestInit,
		requesterKey: string,
		signatureOrCallback: Signature,
	): Promise<string>;
	registerBridgeKey(
		init: RegistrationBridgeKeyInit,
		signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>),
	): Promise<void>;
}

/**
 * Attaches the REST sync binding when (and only when) a base URL is configured. Called exactly
 * once from `AppProvider.tsx`, at the point engines become available. `getEngine` is the app's
 * existing engine-factory accessor (`useApp().getEngine`) — this file never constructs or imports
 * an engine class directly.
 */
export function attachSyncBindings(getEngine: <T>(engineName: string) => Promise<T>): void {
	const baseUrl = DEV_REGISTRATION_SYNC_REST_BASE_URL;
	if (!baseUrl) return;

	const transport = new RestRegistrationTransport({ baseUrl });

	const handle: SyncBindingHandle = {
		id: "rest",
		syncNow: async (): Promise<TransportSyncReport> => {
			const syncedAt = new Date().toISOString();
			const errorItemIds: string[] = [];
			let imported = 0;

			// Exercise the constructed, real binding with a harmless R-3 read (48-10's locked wire
			// protocol) so this Sync Now speaks the real transport, not merely holds an unused
			// instance beside a hand-rolled fetch. Best-effort: a poll failure must not abort the
			// import below.
			try {
				await transport.pollDecisions();
			} catch {
				// Swallowed — see comment above.
			}

			let staged: StagedRequestJson[] = [];
			let bridgeKeys: StagedBridgeKeyJson[] = [];
			try {
				const res = await fetch(`${baseUrl}/staged-requests`);
				if (res.ok) {
					const body = (await res.json()) as { staged?: unknown; bridgeKeys?: unknown };
					if (Array.isArray(body.staged)) staged = body.staged as StagedRequestJson[];
					if (Array.isArray(body.bridgeKeys)) bridgeKeys = body.bridgeKeys as StagedBridgeKeyJson[];
				}
			} catch {
				// No listing reachable — an honest, empty sync, not a throw.
			}

			const engine = await getEngine<RegistrationIntakeEngine>("registration");

			for (const key of bridgeKeys) {
				try {
					const user = await getOrCreateDeviceUser("Device User");
					const sign = await createDeviceSigner(user.name);
					await engine.registerBridgeKey(
						{ id: key.id, authorityId: key.authorityId, label: key.label, key: key.key },
						sign,
					);
				} catch {
					// Already provisioned, or provisioning failed for another reason — the
					// per-document insert below reports the real outcome either way.
				}
			}

			for (const doc of staged) {
				try {
					// The documented intake pattern (see this file's header): the already-resolved
					// Signature crosses unchanged, never a callback — this app never holds and must
					// never hold a requester's (or bridge's) private key.
					await engine.submitRegistrationRequest(doc.init, doc.requesterKey, doc.signature);
					imported += 1;
				} catch {
					errorItemIds.push(doc.requestId);
				}
			}

			return { syncedAt, imported, pending: 0, errorItemIds };
		},
	};

	registerSyncBinding(handle);
}
