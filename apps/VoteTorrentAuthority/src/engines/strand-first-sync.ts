/**
 * First-sync gate helper — treats cadre-core's retryable `StrandAwaitingFirstSyncError`
 * as "still syncing", not a failure to open the network.
 *
 * D-03: pairs with `rn-db-factory.ts` — this file imports ONLY types from
 * `@serfab/cadre-core` (see the `import type` below), so it stays safe to import from
 * jest suites that never load the real (ESM-only) cadre-core package.
 *
 * Class-identity detection (name marker, not `instanceof`): each app resolves exactly
 * one cadre-core copy in production, so `instanceof StrandAwaitingFirstSyncError` would
 * be sound there. It is NOT safe in this repo's jest setup — `rn-db-factory.ts` imports
 * only TYPES from cadre-core, and suites that exercise it either load no cadre-core at
 * all or a virtual empty mock (`jest.mock('@serfab/cadre-core', () => ({}), { virtual:
 * true })`), where the imported class value is `undefined` and `err instanceof undefined`
 * THROWS a TypeError on every error path — breaking the "any other error rejects
 * unchanged" contract. A value import would also pull the real ESM cadre-core/libp2p
 * graph into those suites just to check an error's prototype chain. Detection therefore
 * uses the explicit name marker the class constructor sets
 * (`this.name = 'StrandAwaitingFirstSyncError'`, `dist/strand-first-sync-gate.js:154` —
 * a string-literal assignment, so it survives Hermes/minification) PLUS a `strandId`
 * match against the strand actually being opened — a gate error for a DIFFERENT strand
 * (or any error missing the marker) is treated as a genuine failure, unchanged.
 *
 * Indefinite wait, bounded by cancellation (not a retry cap): the error means "not yet
 * reachable", and the strand stays launched and keeps probing on its own — a bounded
 * retry count would just re-create this bug after N * (cadre's own ~300s timeout),
 * since the existing "Try Again" affordance already only re-waits once more. The wait
 * loops on `node.whenStrandWritable(strandId)` — each call is itself a cadre-bounded
 * wait — and NEVER re-calls `addStrand`. `MIN_FIRST_SYNC_RETRY_INTERVAL_MS` floors the
 * loop so a caller-configured tiny `timeoutMs` cannot hot-loop (worst case 12 calls/min).
 * The whole wait ends the moment the caller's AbortSignal fires (node change, network
 * switch / Start Fresh, provider unmount) — see `waitForStrandWritable` below.
 */
import type { StrandAwaitingFirstSyncError, StrandInstance } from '@serfab/cadre-core';

/** Hot-loop floor: never re-attempt `whenStrandWritable` sooner than this after a gate rejection. */
export const MIN_FIRST_SYNC_RETRY_INTERVAL_MS = 5000;

/**
 * True iff `error` is cadre-core's `StrandAwaitingFirstSyncError` FOR the strand being
 * opened (name-marker detection — see the module doc comment for why not `instanceof`).
 * When `strandId` is omitted, only the name marker is checked.
 */
export function isStrandAwaitingFirstSyncError(
	error: unknown,
	strandId?: string,
): error is StrandAwaitingFirstSyncError {
	if (!(error instanceof Error) || error.name !== 'StrandAwaitingFirstSyncError') {
		return false;
	}
	if (strandId === undefined) {
		return true;
	}
	return (error as { strandId?: unknown }).strandId === strandId;
}

/** Thrown by `waitForStrandWritable` when its AbortSignal fires before the strand became writable. */
export class StrandWaitCancelledError extends Error {
	readonly strandId: string;

	constructor(strandId: string) {
		super(`Strand wait cancelled for ${strandId}`);
		this.name = 'StrandWaitCancelledError';
		this.strandId = strandId;
	}
}

/** Minimal seam `waitForStrandWritable` needs from a CadreNode — satisfied structurally. */
export interface StrandWritableHost {
	whenStrandWritable(strandId: string, options?: { timeoutMs?: number }): Promise<StrandInstance>;
}

/** Rejects/resolves `promise` when `signal` aborts; always removes the listener it adds. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, strandId: string): Promise<T> {
	if (!signal) {
		return promise;
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			// `{ once: true }` already detaches this from the EventTarget once it fires,
			// but call removeEventListener explicitly too — the contract is "no listener
			// left behind", not "relying on an implementation detail of once".
			signal.removeEventListener('abort', onAbort);
			reject(new StrandWaitCancelledError(strandId));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener('abort', onAbort);
				reject(err);
			},
		);
	});
}

/** Abortable sleep — resolves after `ms`, or rejects with StrandWaitCancelledError on abort. */
function abortableSleep(ms: number, signal: AbortSignal | undefined, strandId: string): Promise<void> {
	if (ms <= 0) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new StrandWaitCancelledError(strandId));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			reject(new StrandWaitCancelledError(strandId));
		}
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Waits for `strandId` to become writable, looping on `node.whenStrandWritable` — NEVER
 * re-calls `addStrand` (see the module doc comment). Resolves with the writable
 * `StrandInstance`. Rejects with `StrandWaitCancelledError` if `signal` aborts (before
 * the first attempt, or while an attempt is pending). Rejects unchanged with any error
 * from `whenStrandWritable` that is NOT the first-sync gate error.
 */
export async function waitForStrandWritable(
	node: StrandWritableHost,
	strandId: string,
	options?: { signal?: AbortSignal; minRetryIntervalMs?: number },
): Promise<StrandInstance> {
	const signal = options?.signal;
	const minRetryIntervalMs = options?.minRetryIntervalMs ?? MIN_FIRST_SYNC_RETRY_INTERVAL_MS;

	if (signal?.aborted) {
		throw new StrandWaitCancelledError(strandId);
	}

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const attemptStart = Date.now();
		const raw = node.whenStrandWritable(strandId);
		// An orphaned attempt (we moved on after cancellation) must never surface as an
		// unhandled rejection — attach a no-op catch to the RAW promise, independent of
		// whatever raceAbort does with it.
		raw.catch(() => undefined);

		try {
			// eslint-disable-next-line no-await-in-loop
			return await raceAbort(raw, signal, strandId);
		} catch (err) {
			if (err instanceof StrandWaitCancelledError) {
				throw err;
			}
			if (!isStrandAwaitingFirstSyncError(err, strandId)) {
				throw err;
			}
			const elapsed = Date.now() - attemptStart;
			// eslint-disable-next-line no-await-in-loop
			await abortableSleep(Math.max(0, minRetryIntervalMs - elapsed), signal, strandId);
			// loop — never re-calls addStrand, only whenStrandWritable.
		}
	}
}
