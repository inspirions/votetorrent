/**
 * keyholder-dkg-driver.ts — Phase 62 Plan 26 (D-19, D-16). Pull-only DKG driver and the exhaustive
 * DkgPhase-to-row-state mapping.
 *
 * Three points:
 *  1. Pull-on-focus only: `driveKeyholderDkg` is a plain async function with no scheduler of its
 *     own. `KeyholderScreen` calls it from `useFocusEffect`, which already fires on first open.
 *  2. Prompt budget: a focus with nothing due for the local keyholder prompts ZERO times. The gate
 *     in step 4 below runs BEFORE `advanceDkg` is ever called, and `getDkgStatus` never prompts
 *     (62-17). `advanceDkg` itself plans before it ever touches the vault, so a call that turns out
 *     to have nothing to do also prompts zero times — this driver's own gate is an additional,
 *     cheaper short-circuit, not a substitute for that guarantee.
 *  3. D-16: this module never reconstructs a group secret or the joint election key. Each device's
 *     `advanceDkg` call leaves only ITS OWN round secret / share in ITS OWN vault.
 */

import type { KeyholderDkgStatus, DkgActionTaken, IKeyholderDkgEngine } from '@votetorrent/vote-core';
import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import { getKeyholderIdentity, keyholderSigningKeyAlias, createKeyholderSigner } from '../../engines/keyholder-identity';
import type { KeyVaultStorage } from '../../engines/key-vault';

export type KeyholderDkgRowState = 'loading' | 'pending' | 'inProgress' | 'complete' | 'complaint' | 'failed';

/**
 * Exhaustive mapping. `null` (no status read yet, or the read failed) is 'loading'. A
 * self-disqualified keyholder is always 'failed', in every phase — never 'complaint': a
 * disqualified keyholder will not be part of any future restart, so promising "Generation will
 * restart" would mislead them specifically. The terminal `failed` phase has NO UI-SPEC copy; see
 * `KeyholderDkgStatusRow`'s own header for the interim variant this maps to, and the open
 * question recorded in the SUMMARY (a dedicated catalog key is 62-10-owned).
 */
export function keyholderDkgRowState(status: KeyholderDkgStatus | null): KeyholderDkgRowState {
	if (status === null) return 'loading';
	if (status.self?.isDisqualified) return 'failed';
	switch (status.phase) {
		case 'not-started':
		case 'blocked':
			return 'pending';
		case 'in-progress':
			return 'inProgress';
		case 'restarting':
			return 'complaint';
		case 'complete':
			return 'complete';
		case 'failed':
			return 'failed';
		default: {
			const _exhaustive: never = status.phase;
			return _exhaustive;
		}
	}
}

export interface KeyholderDkgDriverDeps {
	getEngine: <T>(engineName: string) => Promise<T>;
	vault: IKeyVault;
	storage?: KeyVaultStorage;
}

export interface KeyholderDkgDriverOutcome {
	status: KeyholderDkgStatus | null;
	advanced: boolean;
	actions: DkgActionTaken[];
	error?: { code: string; authDenied: boolean; message: string };
}

function codeOf(err: unknown): string {
	const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
	return typeof code === 'string' ? code : 'unknown';
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Never throws. Drives at most ONE `advanceDkg` call per invocation — `KeyholderScreen` calls
 * this again on the next focus, which is the entire "loop" (D-19: no scheduler).
 */
export async function driveKeyholderDkg(
	deps: KeyholderDkgDriverDeps,
	electionId: string,
	keyholderUserId: string | undefined
): Promise<KeyholderDkgDriverOutcome> {
	let status: KeyholderDkgStatus | null = null;
	try {
		const dkg = await deps.getEngine<IKeyholderDkgEngine>('keyholderDkg');

		const identity = keyholderUserId !== undefined ? await getKeyholderIdentity(keyholderUserId, deps.storage) : undefined;
		const local = identity !== undefined && (await deps.vault.hasSecret(keyholderSigningKeyAlias(identity.userId)));

		status = await dkg.getDkgStatus(electionId, local ? identity!.userId : undefined);

		const due =
			local &&
			(status.phase === 'not-started' || status.phase === 'in-progress' || status.phase === 'restarting') &&
			status.self?.isParticipant === true &&
			status.self?.isDisqualified !== true;

		if (!due) {
			return { status, advanced: false, actions: [] };
		}

		try {
			const signer = createKeyholderSigner({ vault: deps.vault }, identity!);
			const result = await dkg.advanceDkg(electionId, signer);
			return { status: result.status, advanced: true, actions: result.actions };
		} catch (advanceErr) {
			// advanceDkg (or building its signer) failed AFTER a successful getDkgStatus read —
			// keep the pre-advance status rather than discarding it to null.
			const code = codeOf(advanceErr);
			return {
				status,
				advanced: false,
				actions: [],
				error: { code, authDenied: code === 'auth-denied', message: messageOf(advanceErr) },
			};
		}
	} catch (err) {
		// getEngine or getDkgStatus itself failed — no reliable status to report.
		const code = codeOf(err);
		return { status: null, advanced: false, actions: [], error: { code, authDenied: code === 'auth-denied', message: messageOf(err) } };
	}
}
