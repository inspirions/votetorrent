import type { Signature } from '@votetorrent/vote-core';
import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import { resolveAuthorityKeyVault } from '../../engines/key-vault';

/**
 * officer-intake-key.ts — Phase 62 Plan 21 (D-04).
 *
 * `readOfficerIntakeKeyState`/`enableOfficerEncryptedIntake` — the officer's "enable encrypted
 * intake" registration step. Publishes a self-signed `UserEncryptionKey` row through 62-14's
 * `IntakeEngine.registerOfficerEncryptionKey`; the secret half is held only in the native-wrapped
 * Authority key vault (`key-vault.ts`).
 *
 * There is NO default signer and no `device-signer`/`device-user` import here: `createSigner` is a
 * REQUIRED injected dependency, supplied by the hosting screen from `useApp().resolveDeviceSigner`
 * (`AppProvider.tsx`'s lazy thunk). This keeps this file out of the `createDeviceSigner(` invoker
 * inventory (62-21 adds no new invoker; see `deviceSigningRollout.coverage.test.ts`). Its own doc
 * comments never spell out that literal call text — write "the injected signer factory" instead.
 *
 * No `@votetorrent/vote-engine` VALUE import — types only. Never logs.
 */

export type OfficerIntakeKeyState = 'enabled' | 'not-enabled' | 'unavailable';

export interface OfficerIntakeKeyDeps {
	getEngine: <T>(engineName: string) => Promise<T>;
	vault?: IKeyVault;
	/** REQUIRED — the injected signer factory (never a default, never `device-signer` imported
	 * here). `readOfficerIntakeKeyState` never calls it. */
	createSigner: () => Promise<(digest: Uint8Array) => Promise<Signature>>;
}

/** The minimal local structural type this file needs from `IntakeEngine`. */
interface OfficerIntakeEngine {
	getOfficerEncryptionKeyStatus(authorityId: string, vault: IKeyVault): Promise<{ isIntakeRecipient: boolean }>;
	registerOfficerEncryptionKey(
		authorityId: string,
		vault: IKeyVault,
		sign: (digest: Uint8Array) => Promise<Signature>,
	): Promise<unknown>;
}

function resolveVault(deps: OfficerIntakeKeyDeps): IKeyVault {
	return deps.vault ?? resolveAuthorityKeyVault();
}

/** Never throws — any failure (no engine, no network, a rejected status read) reports `'unavailable'`. */
export async function readOfficerIntakeKeyState(
	deps: OfficerIntakeKeyDeps,
	authorityId: string,
): Promise<OfficerIntakeKeyState> {
	try {
		const intake = await deps.getEngine<OfficerIntakeEngine>('intake');
		const status = await intake.getOfficerEncryptionKeyStatus(authorityId, resolveVault(deps));
		return status.isIntakeRecipient ? 'enabled' : 'not-enabled';
	} catch {
		return 'unavailable';
	}
}

/**
 * Registers the officer's encryption key. A `createSigner()` rejection propagates UNCHANGED (no
 * wrapping, no re-throw of a new Error) so the hosting screen's `useDeviceSigningErrorHandler` can
 * classify it directly. After a successful registration call, re-reads the state; if it is not
 * `'enabled'` (e.g. a newer key from another device of the same officer — 62-14's one-current-key
 * rule), this rejects rather than silently returning a wrong state.
 */
export async function enableOfficerEncryptedIntake(
	deps: OfficerIntakeKeyDeps,
	authorityId: string,
): Promise<OfficerIntakeKeyState> {
	const intake = await deps.getEngine<OfficerIntakeEngine>('intake');
	const vault = resolveVault(deps);
	const sign = await deps.createSigner();
	await intake.registerOfficerEncryptionKey(authorityId, vault, sign);

	const state = await readOfficerIntakeKeyState(deps, authorityId);
	if (state !== 'enabled') {
		throw new Error('encrypted intake is not active for this device');
	}
	return state;
}
