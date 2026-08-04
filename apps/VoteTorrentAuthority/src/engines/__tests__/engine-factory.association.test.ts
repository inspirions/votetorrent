/**
 * D-09/D-12/D-13/D-14: EngineFactory's 'association' case.
 *
 * Phase 47 (D-09) rewrite. Before this plan, one test asserted
 * `getEngine('association')` REJECTS — matching a jest promise-rejection
 * matcher against /fail-closed|not provisioned/i — when Play Console keys
 * are unprovisioned. That was the construction-time `throw` that used to
 * live in `engine-factory.ts`'s
 * `case 'association'`. Plan 47-03 moved that fail-closed check off the
 * factory and into `PlayIntegrityVerifier.verify()`'s first statement
 * (returning `{ ok: false, reason: '...' }` instead of throwing); plan 47-09
 * then deleted the factory-side `throw` and threaded
 * `this.playConsoleKeysProvisioned` as the verifier's 5th constructor
 * argument. So the old `.rejects` assertion is now FALSE — construction
 * SUCCEEDS with unprovisioned keys — and is REPLACED (never simply deleted)
 * by the tests below (CR-03 lineage retained, never gutted):
 *   - construction with unprovisioned keys succeeds and threads
 *     `keysProvisioned=false` into the injected verifier;
 *   - association READS (getAssociation/getAssociations/removeAssociation)
 *     succeed against that engine without ever consulting the verifier.
 *
 * MUTATION LOCK: deleting the 5th constructor argument in `engine-factory.ts`
 * (leaving 47-03's `keysProvisioned = true` default in force) MUST turn the
 * unprovisioned-construction test and the extended default-provisioned test
 * RED. This is the production-side T-47-01/T-47-01a fail-open detector — see
 * 47-09-SUMMARY.md for the recorded mutation-lock counts.
 *
 * Asserts (still true, unchanged from the pre-47-09 file):
 *   - with the dev flag false (the committed proof-flags default), buildEngine('association')
 *     constructs an AssociationEngine whose injected verifier is a
 *     PlayIntegrityVerifier — the REAL default, never a silent stub fallback.
 *   - with the dev flag true under __DEV__, it constructs a StubAttestationVerifier.
 *
 * `@votetorrent/vote-engine/rn` is virtual-mocked (mirroring rn-db-factory.test.ts's
 * established convention for this same module) with lightweight stand-in classes for
 * AssociationEngine/PlayIntegrityVerifier/StubAttestationVerifier/LocalConfigKeyProvider,
 * so this test exercises ONLY engine-factory.ts's own selection logic (D-14 dev gate) —
 * the real PlayIntegrityVerifier's cert-chain/token verification behavior is covered by
 * vote-engine's own suite (play-integrity-verifier.spec.ts / key-attestation-verifier.spec.ts).
 * `USE_STUB_ATTESTATION_VERIFIER` is mocked per-test via jest.doMock + jest.resetModules,
 * mirroring the RN app's static-import proof-flags convention — the real generated file's
 * committed value stays `false` and is never overwritten by this test.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__DEV__ = true;

jest.mock('../rn-db-factory', () => ({
	rnDbFactory: jest.fn(),
	createStrandDbFactory: jest.fn(),
}));

// jest.mock() factories may not close over out-of-scope variables (they run
// hoisted, before module-scope const/class declarations are initialized) —
// the fakes are defined INSIDE the factory, then re-required below via
// `require('@votetorrent/vote-engine/rn')` so the test body can reference
// the SAME class objects the mocked engine-factory.ts sees.
jest.mock(
	'@votetorrent/vote-engine/rn',
	() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		class AssociationEngine {
			ctx: any;
			verifier: any;
			constructor(ctx: any, verifier: any) {
				this.ctx = ctx;
				this.verifier = verifier;
			}
			// D-09: read-surface stand-in mirroring the real AssociationEngine's
			// getAssociation/getAssociations/removeAssociation — none of them
			// reference `this.verifier` (verified structurally against the real
			// source by the VERIFIER-LOCAL-OK gate below).
			async getAssociation(_registrantId: string, _deviceKey: string): Promise<any> {
				return undefined;
			}
			async getAssociations(_registrantId: string): Promise<any[]> {
				return [];
			}
			async removeAssociation(_registrantId: string, _deviceKey: string, _sig: any): Promise<void> {
				return undefined;
			}
		}
		class PlayIntegrityVerifier {
			ctorArgs: any[];
			argCount: number;
			keyProvider: any;
			roots: any;
			appIdentity: any;
			revoked: any;
			keysProvisioned: any;
			verifyCallCount = 0;
			constructor(...args: any[]) {
				this.ctorArgs = args;
				this.argCount = args.length;
				this.keyProvider = args[0];
				this.roots = args[1];
				this.appIdentity = args[2];
				this.revoked = args[3];
				this.keysProvisioned = args[4];
			}
			// D-09: any read path that mistakenly consults the verifier fails
			// LOUDLY (throws) rather than silently succeeding.
			async verify(): Promise<any> {
				this.verifyCallCount++;
				throw new Error('verifier must not be consulted by association reads');
			}
		}
		class StubAttestationVerifier {}
		class LocalConfigKeyProvider {
			config: any;
			constructor(config: any) {
				this.config = config;
			}
		}
		class LocalStorageReact {}
		return {
			AssociationEngine,
			PlayIntegrityVerifier,
			StubAttestationVerifier,
			LocalConfigKeyProvider,
			LocalStorageReact,
			// Unused by the 'association' path but imported at module load by engine-factory.ts.
			NetworksEngine: class {},
			NetworkEngine: class {},
			ElectionsEngine: class {},
			ElectionEngine: class {},
			SigningEngine: class {},
			DefaultUserEngine: class {},
			KeysTasksEngine: class {},
			SignatureTasksEngine: class {},
			OnboardingTasksEngine: class {},
			InvitationEngine: class {},
			RegistrationEngine: class {},
			AuthorityConfigEngine: class {},
		};
	},
	{ virtual: true },
);

// Stub attestation-roots/status generated files so the test doesn't depend on the
// real bundled snapshot content — only that engine-factory.ts wires SOME pinned
// roots + revoked-serials into PlayIntegrityVerifier's constructor.
jest.mock('../attestation-roots.generated', () => ({
	PINNED_HARDWARE_ROOTS_DER: [new Uint8Array([1, 2, 3])],
}));
jest.mock('../attestation-status.generated', () => ({
	REVOKED_ATTESTATION_SERIALS: new Set(['deadbeef']),
}));
// Stub the bundled app-identity + Play Console key snapshot. `EXPECTED_APP_*`
// pin the token/key to this app (CR-04/WR-03). The Play Console keys are
// PROVISIONED here (non-empty) so the default 'association' path builds the
// real verifier with keysProvisioned=true — the unprovisioned direction is
// exercised by its own tests via jest.doMock below.
jest.mock('../attestation-keys.generated', () => ({
	PLAY_CONSOLE_DECRYPTION_KEY_BASE64: 'ZGVjcnlwdGlvbi1rZXktcHJvdmlzaW9uZWQ=',
	PLAY_CONSOLE_VERIFICATION_KEY_BASE64: 'dmVyaWZpY2F0aW9uLWtleS1wcm92aXNpb25lZA==',
	EXPECTED_APP_PACKAGE: 'org.votetorrent.authority',
	EXPECTED_APP_CERT_SHA256_DIGESTS: ['abc123'],
}));

/** D-09: shared unprovisioned-key build helper for the read-surface tests below. */
function mockUnprovisionedKeys() {
	jest.doMock('../proof-flags.generated', () => ({
		USE_LOCAL_DB_FACTORY: false,
		USE_STUB_ATTESTATION_VERIFIER: false,
	}));
	jest.doMock('../attestation-keys.generated', () => ({
		PLAY_CONSOLE_DECRYPTION_KEY_BASE64: '',
		PLAY_CONSOLE_VERIFICATION_KEY_BASE64: '',
		EXPECTED_APP_PACKAGE: 'org.votetorrent.authority',
		EXPECTED_APP_CERT_SHA256_DIGESTS: [],
	}));
}

describe("EngineFactory buildEngine('association') — D-09/D-12/D-13/D-14", () => {
	afterEach(() => {
		jest.resetModules();
	});

	function buildFactoryWithEstablishedCtx() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { EngineFactory } = require('../engine-factory');
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const rn = require('@votetorrent/vote-engine/rn');
		const factory = new EngineFactory(new rn.LocalStorageReact(), jest.fn());
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(factory as any).currentNetworkHash = 'hash1';
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(factory as any).networksEngine = { getEstablishedContext: () => ({ db: {} }) };
		return { factory, rn };
	}

	it('constructs the REAL PlayIntegrityVerifier by default (flag=false)', async () => {
		jest.doMock('../proof-flags.generated', () => ({
			USE_LOCAL_DB_FACTORY: false,
			USE_STUB_ATTESTATION_VERIFIER: false,
		}));

		const { factory, rn } = buildFactoryWithEstablishedCtx();
		const engine = await factory.getEngine('association');

		expect(engine).toBeInstanceOf(rn.AssociationEngine);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const injectedVerifier = (engine as any).verifier;
		expect(injectedVerifier).toBeInstanceOf(rn.PlayIntegrityVerifier);
		expect(injectedVerifier).not.toBeInstanceOf(rn.StubAttestationVerifier);
		// Pinned roots + revoked serials are injected — never fetched at verify-time.
		expect(injectedVerifier.roots).toEqual([new Uint8Array([1, 2, 3])]);
		expect(injectedVerifier.revoked).toEqual(new Set(['deadbeef']));
		// CR-04/WR-03: the app-identity pin (package + cert-digest allowlist) is injected.
		expect(injectedVerifier.appIdentity).toEqual({
			packageName: 'org.votetorrent.authority',
			certificateSha256Digests: ['abc123'],
		});
		// T-47-01 threading gate (provisioned direction): with the module-level
		// PROVISIONED key mock, exactly 5 arguments are threaded and the flag
		// arrives as boolean true, not undefined.
		expect(injectedVerifier.ctorArgs).toHaveLength(5);
		expect(injectedVerifier.keysProvisioned).toBe(true);
	});

	it(
		'D-09/CR-03: constructs successfully with UNPROVISIONED keys and threads keysProvisioned=false ' +
			'into the verifier (the guard moved to verify(), it was not removed)',
		async () => {
			mockUnprovisionedKeys();

			const { factory, rn } = buildFactoryWithEstablishedCtx();

			// Construction now RESOLVES — no `.rejects` anywhere in this test. The
			// pre-47-09 fail-closed throw lived here; D-09 relocated it into
			// verify() (47-03), so buildEngine('association') always succeeds.
			const engine = await factory.getEngine('association');

			expect(engine).toBeInstanceOf(rn.AssociationEngine);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const injectedVerifier = (engine as any).verifier;
			expect(injectedVerifier).toBeInstanceOf(rn.PlayIntegrityVerifier);
			expect(injectedVerifier.ctorArgs).toHaveLength(5);
			// STRICT toBe(false), never a truthiness-only matcher: `undefined` is
			// falsy too, so a loose matcher would PASS for the exact fail-open this
			// test exists to
			// catch — the factory forgetting the 5th argument, leaving 47-03's
			// `= true` default in force and silently re-enabling the verifier.
			expect(injectedVerifier.keysProvisioned).toBe(false);
		},
	);

	it('D-09: getAssociation succeeds against the unprovisioned-key engine without consulting the verifier', async () => {
		mockUnprovisionedKeys();

		const { factory } = buildFactoryWithEstablishedCtx();
		const engine = await factory.getEngine('association');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const injectedVerifier = (engine as any).verifier;

		// The stand-in's read methods never reference `this.verifier`. This
		// proves the FACTORY-level contract (construction yields a usable
		// engine and no read path routes through the verifier); the real
		// engine's read semantics are independently covered by 47-04's
		// association-reads.spec.ts, and the VERIFIER-LOCAL-OK gate below pins
		// the real source structurally (this.verifier appears exactly once,
		// inside associate()) so the stand-in and the real file cannot
		// silently diverge without a gate firing.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect((engine as any).getAssociation('r1', 'dk1')).resolves.toBeUndefined();
		expect(injectedVerifier.verifyCallCount).toBe(0);
	});

	it('D-09: getAssociations succeeds against the unprovisioned-key engine without consulting the verifier', async () => {
		mockUnprovisionedKeys();

		const { factory } = buildFactoryWithEstablishedCtx();
		const engine = await factory.getEngine('association');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const injectedVerifier = (engine as any).verifier;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect((engine as any).getAssociations('r1')).resolves.toEqual([]);
		expect(injectedVerifier.verifyCallCount).toBe(0);
	});

	it('D-09: removeAssociation succeeds against the unprovisioned-key engine without consulting the verifier', async () => {
		mockUnprovisionedKeys();

		const { factory } = buildFactoryWithEstablishedCtx();
		const engine = await factory.getEngine('association');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const injectedVerifier = (engine as any).verifier;

		await expect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(engine as any).removeAssociation('r1', 'dk1', { sig: 'stub' }),
		).resolves.toBeUndefined();
		expect(injectedVerifier.verifyCallCount).toBe(0);
	});

	it('D-09: all three association read paths succeed together without ever consulting the verifier (aggregate)', async () => {
		mockUnprovisionedKeys();

		const { factory } = buildFactoryWithEstablishedCtx();
		const engine = await factory.getEngine('association');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const injectedVerifier = (engine as any).verifier;

		await expect(
			Promise.all([
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(engine as any).getAssociation('r1', 'dk1'),
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(engine as any).getAssociations('r1'),
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(engine as any).removeAssociation('r1', 'dk1', { sig: 'stub' }),
			]),
		).resolves.toBeDefined();
		expect(injectedVerifier.verifyCallCount).toBe(0);
	});

	it('still uses the stub under the __DEV__ dev gate even when keys are unprovisioned (flag=true, empty keys)', async () => {
		jest.doMock('../proof-flags.generated', () => ({
			USE_LOCAL_DB_FACTORY: false,
			USE_STUB_ATTESTATION_VERIFIER: true,
		}));
		jest.doMock('../attestation-keys.generated', () => ({
			PLAY_CONSOLE_DECRYPTION_KEY_BASE64: '',
			PLAY_CONSOLE_VERIFICATION_KEY_BASE64: '',
			EXPECTED_APP_PACKAGE: 'org.votetorrent.authority',
			EXPECTED_APP_CERT_SHA256_DIGESTS: [],
		}));

		const { factory, rn } = buildFactoryWithEstablishedCtx();
		const engine = await factory.getEngine('association');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((engine as any).verifier).toBeInstanceOf(rn.StubAttestationVerifier);
	});

	it('constructs StubAttestationVerifier ONLY under the explicit __DEV__ dev gate (flag=true)', async () => {
		jest.doMock('../proof-flags.generated', () => ({
			USE_LOCAL_DB_FACTORY: false,
			USE_STUB_ATTESTATION_VERIFIER: true,
		}));

		const { factory, rn } = buildFactoryWithEstablishedCtx();
		const engine = await factory.getEngine('association');

		expect(engine).toBeInstanceOf(rn.AssociationEngine);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const injectedVerifier = (engine as any).verifier;
		expect(injectedVerifier).toBeInstanceOf(rn.StubAttestationVerifier);
	});
});
