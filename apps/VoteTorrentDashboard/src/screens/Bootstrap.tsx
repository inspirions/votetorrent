import { useState } from 'react';
import type { FormEvent } from 'react';
import { t } from '../i18n/copy.js';
import { BOOTSTRAP_PHASES, copyKeysForOutcome, redeemAndBootstrap } from '../lifecycle/bootstrap.js';
import { createRestBootstrapTransport } from '../transport/bootstrap-transport-client.js';

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
 */
const BOOTSTRAP_BASE_URL = window.location.origin;

type ScreenState =
	| { kind: 'idle' }
	| { kind: 'in-flight'; phase: string }
	| { kind: 'error'; outcome: string; reason?: string }
	| { kind: 'ok' };

export function Bootstrap() {
	const [pastedCode, setPastedCode] = useState('');
	const [state, setState] = useState<ScreenState>({ kind: 'idle' });

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
		let transport;
		try {
			transport = createRestBootstrapTransport({ baseUrl: BOOTSTRAP_BASE_URL });
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
			{state.kind === 'in-flight' ? <p aria-live="polite">{state.phase}</p> : null}
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
