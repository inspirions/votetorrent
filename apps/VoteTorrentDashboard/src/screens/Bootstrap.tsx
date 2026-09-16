import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { t } from '@votetorrent/ui-web';
import { BOOTSTRAP_PHASES, copyKeysForOutcome, redeemAndBootstrap } from '../lifecycle/bootstrap.js';
import type { RedeemAndBootstrapResult } from '../lifecycle/bootstrap.js';
import { createRestBootstrapTransport } from '../transport/bootstrap-transport-client.js';
import { createSingleFlightTransport } from '../lifecycle/officer-swap.js';
import type { SingleFlightTransport } from '../lifecycle/officer-swap.js';
import type { IBootstrapTransport } from '@votetorrent/vote-engine/bootstrap';
import './bootstrap.css';

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
	// `status` is the redemption status the SERVICE answered, and it is present
	// only for `outcome: 'code-refused'` -- the one member of
	// `RedeemAndBootstrapResult` that carries one. It is LOAD-BEARING, not
	// decorative: `copyKeysForOutcome` selects one of three distinct refusal
	// families from it and THROWS if a `code-refused` arrives without it,
	// rather than degrading to the generic invalid-code copy. Dropping this
	// field is how an officer stops being able to tell a typo from a spent code
	// from a stale one.
	| { kind: 'error'; outcome: string; reason?: string; status?: string }
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
	// Guards the unmount reset below (D-14). Set to true IMMEDIATELY BEFORE
	// `onAlreadyBootstrapped` is called: from that point on, the single-flight
	// cache belongs to the caller (DashboardShell), which replays it to
	// recover the verified envelope without spending the single-use code a
	// second time. React commits this component's unmount as part of the SAME
	// transition that mounts DashboardShell, and unmount destructors run
	// BEFORE the newly-mounted tree's effects -- so an unconditional reset()
	// here would null the cache out from under the very caller it was just
	// handed to. An abandoned or cancelled classification -- one that was
	// NEVER handed off -- is still reset on unmount, so a redeemable
	// whole-database snapshot never outlives this screen.
	const handedOffRef = useRef(false);

	useEffect(() => {
		return () => {
			if (!handedOffRef.current) {
				singleFlightRef.current?.reset();
			}
		};
	}, []);

	const submitting = state.kind === 'in-flight';

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting) return;
		// A fresh attempt is always resettable on unmount, even if a PRIOR
		// attempt on this same mounted screen was handed off (which cannot
		// actually happen -- a handoff calls onAlreadyBootstrapped and this
		// component un-mounts -- but a retry after a local failure must not
		// inherit a stale handoff flag).
		handedOffRef.current = false;

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
				// Ordering is the whole point: the callback synchronously triggers
				// main.tsx's state update, so anything AFTER it may already be
				// racing the commit. Set the guard before, not after.
				handedOffRef.current = true;
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
				// Read defensively, exactly as `reason` above is -- an `in`-guard
				// on the discriminated union, never a cast. Only `code-refused`
				// carries a status; every other outcome leaves it undefined,
				// which is what `copyKeysForOutcome` expects of them.
				status: 'status' in result ? result.status : undefined,
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
			<main className="bs-screen">
				<h1 className="bs-title">{t('bootstrap.emptyNetworksHeading')}</h1>
				<p className="bs-empty-body">{t('bootstrap.emptyNetworksBody')}</p>
				{/* 50-09 replaces this placeholder with the real network shell. */}
			</main>
		);
	}

	const errorCopy = state.kind === 'error' ? copyKeysForOutcome(state.outcome, state.reason, state.status) : undefined;

	return (
		<main className="bs-screen">
			<h1 className="bs-title">{t('bootstrap.heading')}</h1>
			<form className="bs-form" onSubmit={handleSubmit}>
				<label className="bs-label" htmlFor="dashboard-signin-code">{t('bootstrap.codeFieldLabel')}</label>
				<input
					className="bs-input"
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
				<button className="bs-cta" type="submit" disabled={submitting}>
					{t('bootstrap.cta')}
				</button>
			</form>
			{/* NEVER `{state.phase}`: those are BOOTSTRAP_PHASES' machine
			    identifiers ("applying-schema" and friends), and an aria-live
			    region is the last place a machine identifier belongs. */}
			{state.kind === 'in-flight' ? (
				<p className="bs-status" aria-live="polite">
					{t(`bootstrap.phase.${state.phase}`)}
				</p>
			) : null}
			{errorCopy ? (
				<div className="bs-alert" role="alert">
					<h2 className="bs-alert-heading">{t(errorCopy.headingKey)}</h2>
					<p className="bs-alert-body">{t(errorCopy.bodyKey)}</p>
					<p className="bs-alert-cta">{t(errorCopy.ctaKey)}</p>
				</div>
			) : null}
		</main>
	);
}

export default Bootstrap;
