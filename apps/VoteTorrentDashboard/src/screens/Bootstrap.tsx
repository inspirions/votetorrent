import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { t } from '../i18n/copy.js';
import { BOOTSTRAP_PHASES, copyKeysForOutcome, redeemAndBootstrap } from '../lifecycle/bootstrap.js';
import type { RedeemAndBootstrapResult } from '../lifecycle/bootstrap.js';
import { createRestBootstrapTransport } from '../transport/bootstrap-transport-client.js';
import { createSingleFlightTransport } from '../lifecycle/officer-swap.js';
import type { SingleFlightTransport } from '../lifecycle/officer-swap.js';
import type { IBootstrapTransport } from '@votetorrent/vote-engine/bootstrap';

/** The context handed to `onAlreadyBootstrapped` when a code redeems cleanly
 * (D-05/D-13 verified) for a network this browser already holds. It carries
 * the SAME single-flight transport instance whose cache already holds the
 * verified envelope from the classify call above -- a caller (`DashboardShell`)
 * replays it to recover that envelope and classify it, without spending the
 * single-use code a second time. `networkHash` is included for convenience
 * (bootstrap.js's `already-bootstrapped` outcome names it), but the envelope
 * itself -- and therefore the officer identity `classifyRedemption` needs --
 * is only recoverable through a replay of `transport`. */
export interface AlreadyBootstrappedContext {
	networkHash?: string;
	pastedCode: string;
	transport: SingleFlightTransport;
	reset: () => void;
}

/**
 * Bootstrap.tsx -- UI-SPEC Screens & States row 1: idle, submitting,
 * verifying, applying schema, seeding, success, plus the invalid-code and
 * transport-unreachable error states.
 *
 * Hand entry only: this screen has no optical-capture input method of any
 * kind, and no dependency anywhere in this repo to build one on. Entry is by
 * hand, and by hand only.
 *
 * WHERE THE ENDPOINT BASE URL COMES FROM, AND WHY NOT A BUILD-TIME ENV VAR:
 * 50-04's `assert:no-polyfills` gate (T-50-04-02) fails the build on ANY
 * read of a build-time-injected env value anywhere under `src/`, because
 * Vite bakes such a value into the PUBLIC bundle at build time -- this app
 * has no server, no session and no secret to hold, so nothing may be baked
 * in that way. `bootstrap-transport-client.js` already documents the same
 * discipline from the other direction (it never reads that mechanism at
 * all). The bootstrap REST endpoint is therefore assumed to be served from
 * THIS DASHBOARD'S OWN ORIGIN -- `window.location.origin` -- a runtime
 * read, never a build-time one, and the only zero-configuration answer that
 * respects the gate. A real multi-origin deployment story is future work,
 * not decided by this plan.
 *
 * `createTransport` (below) is an INJECTION POINT ONLY -- for tests and the
 * composed browser gate to drive this real screen without a live endpoint.
 * It changes nothing about where a production build gets its base URL from
 * (still `window.location.origin`, read only when `createTransport` is
 * absent) and introduces no build-time env read of its own.
 */
const BOOTSTRAP_BASE_URL = window.location.origin;

type ScreenState =
	| { kind: 'idle' }
	| { kind: 'in-flight'; phase: string }
	| { kind: 'error'; outcome: string; reason?: string }
	| { kind: 'ok' };

export interface BootstrapProps {
	/** Called exactly once, with the `ok` result, after a successful
	 * bootstrap. Optional -- omitting it keeps today's placeholder landing
	 * state. */
	onComplete?: (result: Extract<RedeemAndBootstrapResult, { outcome: 'ok' }>) => void;
	/** Called instead of routing to the generic error state when a code
	 * redeems cleanly for a network this browser already holds. Carries the
	 * SAME single-flight transport instance whose cache already holds the
	 * verified envelope, so a caller can classify and, on confirmation,
	 * replace -- without the single-use code being spent a second time.
	 * Optional -- omitting it leaves the existing `already-bootstrapped`
	 * error state exactly as it was. */
	onAlreadyBootstrapped?: (context: AlreadyBootstrappedContext) => void;
	/** Injection point for tests and the composed browser gate. Defaults to
	 * `createRestBootstrapTransport({ baseUrl: window.location.origin })`. */
	createTransport?: () => IBootstrapTransport;
}

export function Bootstrap({ onComplete, onAlreadyBootstrapped, createTransport }: BootstrapProps = {}) {
	const [pastedCode, setPastedCode] = useState('');
	const [state, setState] = useState<ScreenState>({ kind: 'idle' });
	// Holds the CURRENT attempt's single-flight decorator so the unmount
	// cleanup below can reset() it -- a cancelled or abandoned classification
	// must never leave a redeemable whole-database snapshot sitting in memory.
	const singleFlightRef = useRef<{ reset: () => void } | null>(null);

	useEffect(() => {
		return () => {
			singleFlightRef.current?.reset();
		};
	}, []);

	const submitting = state.kind === 'in-flight';

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting) return;

		setState({ kind: 'in-flight', phase: BOOTSTRAP_PHASES[0] });

		// SCOPED TO THE CONSTRUCTION CALL, DELIBERATELY.
		// `createRestBootstrapTransport` throws synchronously on a missing
		// baseUrl -- treat exactly like an unreachable transport rather than
		// letting the app crash on a misconfigured deployment. Wrapping the
		// whole redemption in this same catch, as an earlier version did, made
		// every LOCAL failure -- a blocked IndexedDB delete, an
		// applyExternalRowChanges failure, an invalid registry entry, a missing
		// row-count record, anything Quereus raises while preparing the
		// database -- report "couldn't reach the authority app" for something
		// that happened entirely inside this browser, AFTER a successful
		// redemption had already burned a single-use code.
		let transport: SingleFlightTransport;
		try {
			const inner = createTransport
				? createTransport()
				: createRestBootstrapTransport({ baseUrl: BOOTSTRAP_BASE_URL });
			// EVERY PATH WRAPS THE TRANSPORT -- the property that lets a
			// classify-then-confirm sequence (D-14) share ONE spent code instead
			// of two: `createSingleFlightTransport` caches only an `ok` result,
			// never a refusal, and never persists it.
			const singleFlight = createSingleFlightTransport(inner);
			singleFlightRef.current = singleFlight;
			transport = singleFlight.transport;
		} catch {
			setState({ kind: 'error', outcome: 'transport-unreachable' });
			return;
		}

		try {
			const result = await redeemAndBootstrap({
				pastedCode,
				transport,
				onPhase: (phase) => setState({ kind: 'in-flight', phase }),
			});
			if (result.outcome === 'ok') {
				setState({ kind: 'ok' });
				onComplete?.(result);
				return;
			}
			if (result.outcome === 'already-bootstrapped' && onAlreadyBootstrapped) {
				// The single-flight cache already holds the verified `ok` result
				// from step 2 above -- `redeemAndBootstrap`'s own registry check
				// (step 4) is what turned that into `already-bootstrapped`, not a
				// refusal from the transport. Handing the SAME transport instance
				// (and its `reset`) to the caller is what lets a confirmed swap
				// replay that cached envelope instead of redeeming the single-use
				// code a second time.
				const singleFlight = singleFlightRef.current;
				onAlreadyBootstrapped({
					networkHash: 'networkHash' in result ? result.networkHash : undefined,
					pastedCode,
					transport,
					reset: singleFlight ? singleFlight.reset : () => {},
				});
				return;
			}
			setState({
				kind: 'error',
				outcome: result.outcome,
				reason: 'reason' in result ? result.reason : undefined,
			});
		} catch (err) {
			// `redeemAndBootstrap` returns an outcome for every EXPECTED
			// refusal, so reaching here means something local went wrong after
			// the code was spent. Report it in the verification family, whose
			// action ("Try another code") is the right one and whose body is
			// true on this screen -- it only ever performs a FIRST bootstrap, so
			// there is no prior copy that could have been replaced. Log the
			// error CLASS only: the message can carry row content, and the
			// snapshot carries registrant information.
			// eslint-disable-next-line no-console
			console.error('redeemAndBootstrap failed after a spent code:', (err as { name?: string })?.name ?? 'Error');
			setState({ kind: 'error', outcome: 'restore-incomplete' });
		}
	}

	if (state.kind === 'ok') {
		return (
			<main>
				<h1>{t('bootstrap.emptyNetworksHeading')}</h1>
				<p>{t('bootstrap.emptyNetworksBody')}</p>
				{/* 50-09 replaces this placeholder with the real network shell. */}
			</main>
		);
	}

	const errorCopy = state.kind === 'error' ? copyKeysForOutcome(state.outcome, state.reason) : undefined;

	return (
		<main>
			<h1>{t('bootstrap.heading')}</h1>
			<form onSubmit={handleSubmit}>
				<label htmlFor="dashboard-signin-code">{t('bootstrap.heading')}</label>
				<input
					id="dashboard-signin-code"
					name="dashboard-signin-code"
					type="text"
					autoComplete="off"
					spellCheck={false}
					inputMode="text"
					value={pastedCode}
					onChange={(event) => setPastedCode(event.target.value)}
					disabled={submitting}
				/>
				<button type="submit" disabled={submitting}>
					{t('bootstrap.cta')}
				</button>
			</form>
			{/* NEVER `{state.phase}`: those are BOOTSTRAP_PHASES' machine
			    identifiers ("applying-schema" and friends), and an aria-live
			    region is the last place a machine identifier belongs. */}
			{state.kind === 'in-flight' ? <p aria-live="polite">{t(`bootstrap.phase.${state.phase}`)}</p> : null}
			{errorCopy ? (
				<div role="alert">
					<h2>{t(errorCopy.headingKey)}</h2>
					<p>{t(errorCopy.bodyKey)}</p>
					<p>{t(errorCopy.ctaKey)}</p>
				</div>
			) : null}
		</main>
	);
}

export default Bootstrap;
