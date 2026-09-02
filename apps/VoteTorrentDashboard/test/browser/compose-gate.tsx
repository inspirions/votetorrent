/**
 * compose-gate.tsx — Task 2's page driver: the composed-shell gate that
 * closes the coverage hole named in `50-VERIFICATION.md`'s CR-01 finding.
 *
 * Every other tier-1/2/3 rung in this suite mounts a control or a grid
 * directly, wired by hand from a harness-supplied scope array. None of them
 * ever mount the top-level shell component the real application entry point
 * (`src/main.tsx`) actually renders — so a wiring defect between that shell
 * and the control beneath it (CR-01: the officer's real scopes arriving
 * asynchronously, after the control's state was already seeded from an
 * empty array) shipped green through every one of them.
 *
 * This page closes that hole by importing `../../src/screens/DashboardShell`
 * BY RELATIVE PATH and mounting it directly with `createRoot` — the same way
 * `src/main.tsx` does. It supplies no scope set of its own. Every scope this
 * page ever observes travelled the real path: a fake bootstrap transport
 * (Task 2's `<read_first>` fixture convention) redeems a code, `redeemAndBootstrap`
 * commits a verified snapshot, the shell attaches the database, reads the
 * officer's granted scopes, and re-seeds the preview state's real-scope
 * baseline once that read resolves. This page asserts what the DOM shows
 * after that path runs to completion, with NO interaction of any kind — no
 * click, no checkbox toggle, no reveal press.
 *
 * `?phase=` is `compose-seed` | `compose-verify`. `&officer=none` (verify
 * only) is the deliberate inertness inversion described below.
 *
 * `compose-seed` seeds a network whose officer holds the founding nine
 * scopes (the fixture envelope's own default holds only one; this page
 * grants all nine so the headline "nine populated panels" claim has
 * something to observe) and confirms a registry entry exists before ending.
 * It mounts nothing.
 *
 * `compose-verify` is a genuinely fresh page load. It seeds NOTHING: it
 * asserts up front that a registry entry for this network already exists,
 * and fails loudly rather than silently re-seeding if it does not — a
 * broken seed page must never be masked by a compensating verify page. It
 * then mounts the shell, waits for the DOM to settle via a bounded
 * `requestAnimationFrame` poll (never a fixed sleep, and this page never
 * calls a location-reload primitive — freshness comes from a brand-new
 * driven page, not an in-page re-navigation), and asserts, with zero
 * interaction: nine populated panel sections, zero panels in the
 * access-denied state, the real-answer badge, the D-16 advisory disclosure,
 * and that the reveal toggle sits in its default (not-pressed) state — so
 * the panel count above was measured un-revealed, i.e. genuinely visible.
 *
 * `&officer=none` rewrites the just-seeded registry entry's officer id
 * (through the production registry API, never by touching storage
 * directly) to an id that owns no Officer row, then runs the IDENTICAL
 * assertion set. The database genuinely grants that id nothing, so the
 * nine-panel assertion must FAIL — this is Task 3's `--prove-blank`
 * inertness control, proving this rung can discriminate rather than
 * passing regardless of what the database actually answered.
 *
 * `compose-refusal` (52-12 / D-25) drives THREE real submissions -- one per
 * redemption status the service can refuse with (`unknown`, `used`,
 * `expired`) -- through the REAL `Bootstrap` form in ONE page load, and
 * measures the `[role="alert"]` each one rendered. It asserts every observed
 * heading and body against `t()` of that status's copy key, never a literal,
 * then compares the three CROSS-status: two families that converged would pass
 * every per-status rung and fail only here. `&conflate=1` drives the SAME
 * status three times so that distinctness rung MUST fail, which is what
 * `run-headless.mjs --prove-conflated` inverts around -- an always-green rung
 * proves nothing.
 *
 * WHAT THIS TIER CANNOT SEE -- READ BEFORE QUOTING A GREEN RUN AS EVIDENCE:
 * `compose-gate.html` loads NO stylesheet. It has no `app.css` link, so every
 * `var(--...)` in this app resolves to the empty string and this gate is blind
 * to ALL styling: colour, spacing, layout, focus rings, contrast, the lot. A
 * green run here is evidence about TEXT CONTENT and STATE, and is not evidence
 * that any screen looks right.
 *
 * Separately and specifically: `src/screens/Bootstrap.tsx` shipped with no
 * `className` anywhere and no `bootstrap.css`, so the refusal copy above landed
 * on unstyled native controls -- a real, adjacent defect that survived until
 * live UAT reported it, because NO rung in this file could detect it. It now
 * carries both, but nothing here changed: this page still loads no stylesheet,
 * so `compose-refusal` passing is not evidence that the screen is styled, and
 * would not have been evidence that it was not.
 *
 * Reproduces the sibling gates' `rung()` / readout convention under ITS OWN
 * distinct names, `window.__COMPOSE_GATE__` / `window.__COMPOSE_GATE_DONE__`,
 * so this gate can never be confused with the others. Every step renders
 * with `textContent` only, never as raw markup — nothing derived from the
 * database reaches the DOM unescaped. Every rendered-copy comparison goes
 * through the frozen copy table's own `t()`, never a literal, so a copy
 * change cannot silently break this gate. This page is test-only and must
 * never reach the production Vite build (see `run-headless.mjs`'s dist scan
 * and this repo's `assert:no-polyfills` step).
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildSnapshot } from '@votetorrent/vote-engine/bootstrap';
import type { IBootstrapTransport, SnapshotRow, SnapshotTables } from '@votetorrent/vote-engine/bootstrap';
import { BOOTSTRAP_OUTCOME_CODES, redeemAndBootstrap } from '../../src/lifecycle/bootstrap.js';
import { deleteNetworkDb } from '../../src/db/open-db.js';
import { findNetwork, listNetworks, removeNetwork, upsertNetwork } from '../../src/db/networks-registry.js';
import { CAPABILITIES, SCOPE_CODES } from '../../src/auth/capabilities.js';
import { t } from '@votetorrent/ui-web';
import { Bootstrap } from '../../src/screens/Bootstrap.js';
import type { AlreadyBootstrappedContext } from '../../src/screens/Bootstrap.js';
import { DashboardShell } from '../../src/screens/DashboardShell.js';
import { createSingleFlightTransport } from '../../src/lifecycle/officer-swap.js';
import { buildFixtureEnvelope, makeFakeTransport, withExtraUserRow } from '../fixtures/bootstrap-envelope.js';
import { PreviewAsProvider, PreviewAsControl } from '../../src/screens/PreviewAsControl.js';
import { PanelGrid } from '../../src/screens/PanelGrid.js';
import type { ScopeCode } from '../../src/auth/capabilities.js';

/** @type {any} */
const win = window as unknown as Record<string, unknown>;

/** A bearer secret this page alone uses -- distinct from every sibling gate's, so a shared browser context never confuses two fixtures. */
const SECRET = 'e'.repeat(40);
/** A network hash distinct from every sibling gate's fixture, so this page's registry/IndexedDB state can never collide with theirs inside the same persistent browser context `run-headless.mjs` drives all page loads through. */
const COMPOSE_NETWORK_HASH = 'compose-gate-network';
/** An id that owns no `Officer` row in the seeded database -- `&officer=none`'s deliberate inertness inversion. */
const NO_SUCH_OFFICER = 'compose-gate-no-such-officer';

// --- compose-swap (Task 3 / D-14): distinct secrets and officer ids, so this
// leg's fixtures never collide with compose-seed's or each other's. ---
/** The founding officer's own id, from the shared fixture's base tables. */
const FOUNDING_OFFICER_ID = 'u1';
/** A confirmed swap's incoming officer. */
const OFFICER_2_ID = 'compose-gate-officer-2';
/** A THIRD officer, used only for the cancel rung -- never confirmed. */
const OFFICER_3_ID = 'compose-gate-officer-3';
/** Distinct from `SECRET` and from every sibling gate's own secret. */
const SECRET_SWAP = 'f'.repeat(40);
/** Distinct from `SECRET_SWAP` -- the cancel rung's own code is never redeemed twice, and must never be confused with the confirmed swap's. */
const SECRET_CANCEL = 'c'.repeat(40);

// --- compose-refusal (52-12 / D-25): three refusal statuses driven through the
// REAL Bootstrap form in ONE page load. Three DISTINCT secrets, one per
// status, following this file's rule that no two legs (and here, no two rungs)
// share a secret: `makeFakeTransport` is single-use by default, so a shared
// secret would turn the second rung's intended status into `used` and quietly
// manufacture a passing distinctness check out of a broken one. ---
/** `unknown` -- the service holds no record under this code. */
const SECRET_REFUSE_UNKNOWN = '1'.repeat(40);
/** `used` -- the record exists and its single use is spent. */
const SECRET_REFUSE_USED = '2'.repeat(40);
/** `expired` -- the record exists, its span has passed. */
const SECRET_REFUSE_EXPIRED = '3'.repeat(40);
/** `&conflate=1`'s three codes: three DISTINCT secrets all mapped to the SAME
 * status, so the inversion changes only the INPUT -- never the product code and
 * never an assertion -- and `singleUse` cannot interfere. */
const SECRET_CONFLATE_A = '4'.repeat(40);
const SECRET_CONFLATE_B = '5'.repeat(40);
const SECRET_CONFLATE_C = '6'.repeat(40);

const LOG: Array<{ t: string; ms: number; category: string; message: string }> = [];
const t0 = performance.now();
function log(category: string, message: string) {
	LOG.push({ t: new Date().toISOString(), ms: +(performance.now() - t0).toFixed(1), category, message });
}

const params = new URLSearchParams(location.search);
const PHASE = params.get('phase') ?? 'compose-seed';
const OFFICER_NONE = params.get('officer') === 'none';
/** `&conflate=1` (52-12): drive the SAME status three times, so the
 * distinctness rung MUST fail. `run-headless.mjs --prove-conflated` inverts the
 * verdict around it -- an always-green distinctness rung is itself a failure. */
const CONFLATE = params.get('conflate') === '1';

const stepsEl = document.getElementById('steps');
const steps: Array<{ name: string; el: HTMLElement; ok: boolean }> = [];

/** Renders every step with `textContent` only -- see the file header's discipline note. */
async function rung(name: string, fn: () => Promise<string>): Promise<{ ok: boolean; value?: string }> {
	const el = document.createElement('div');
	el.textContent = name;
	stepsEl?.appendChild(el);
	try {
		const value = await fn();
		el.className = 'step ok';
		el.textContent = `[ok] ${name} ${value}`;
		steps.push({ name, el, ok: true });
		log('pass', name);
		return { ok: true, value };
	} catch (err) {
		const message = String((err as { message?: unknown })?.message ?? err);
		el.className = 'step fail';
		el.textContent = `[fail] ${name} ${message}`;
		steps.push({ name, el, ok: false });
		log('fail', `${name}: ${message}`);
		return { ok: false };
	}
}

/**
 * The fixture envelope, rebuilt with an Officer row holding all nine scope
 * codes (the shared fixture's own default holds only one) and a `Network`
 * row rewritten to this page's own network hash -- rebuilt through
 * `buildSnapshot` so manifest/digest/schemaHash stay internally consistent,
 * mirroring `shell-gate.js`'s own `secondEnvelope()` pattern.
 *
 * `userId` defaults to the base fixture's own `FOUNDING_OFFICER_ID` -- the
 * original, unparameterized behaviour compose-seed still relies on -- and is
 * overridden by the compose-swap leg (Task 3) to produce a legitimately
 * DIFFERENT officer for the SAME network, which is what makes
 * `classifyRedemption` return `officer-swap` rather than
 * `same-officer-refresh`.
 *
 * @param {string} [userId]
 */
function composeEnvelope(userId: string = FOUNDING_OFFICER_ID) {
	const base = buildFixtureEnvelope();
	const userRows: readonly SnapshotRow[] = base.tables.User ?? [];
	const officerRows: readonly SnapshotRow[] = base.tables.Officer ?? [];
	const networkRows: readonly SnapshotRow[] = base.tables.Network ?? [];
	const tables: SnapshotTables = {
		...base.tables,
		User: userRows.map((row) => ({ ...row, Id: userId })),
		Officer: officerRows.map((row) => ({ ...row, UserId: userId, Scopes: JSON.stringify(SCOPE_CODES) })),
		Network: networkRows.map((row) => ({ ...row, Hash: COMPOSE_NETWORK_HASH })),
	};
	return buildSnapshot({ networkHash: COMPOSE_NETWORK_HASH, tables, generatedAt: base.generatedAt });
}

/**
 * A bounded `requestAnimationFrame` poll -- NEVER a fixed sleep -- that
 * resolves as soon as at least one `.panel` section exists in the document,
 * or once `maxFrames` have elapsed. Reaching the cap with zero panels is not
 * itself asserted as a failure here; it is exactly the CR-01 signature, and
 * the caller's own assertions decide, reporting the observed count either
 * way.
 */
function settleUntilPanels(maxFrames: number): Promise<number> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			const count = document.querySelectorAll('.panel').length;
			if (count > 0 || frames >= maxFrames) {
				resolve(count);
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

async function runComposeSeed() {
	await rung(
		'1 · delete any prior compose-gate database, row-count record and registry entry for a clean slate -- and clear EVERY OTHER registry entry too',
		async () => {
			await deleteNetworkDb(COMPOSE_NETWORK_HASH, { storage: localStorage });
			// `DashboardShell` has no "which network" prop -- it always shows
			// `networks[0]` from the registry, by design (the switcher is how an
			// officer picks a DIFFERENT one). `run-headless.mjs`'s default run
			// shares ONE persistent browser context across every gate's page
			// loads, and one sibling gate's own fixture (shell-gate's
			// `SECOND_HASH` network) is DELIBERATELY never forgotten -- it is
			// the survival half of that gate's own negative control. Left in
			// place, it would sit ahead of this page's network in the registry
			// array and `compose-verify` would silently mount the WRONG
			// network's data. Clearing every other entry here (their
			// underlying IndexedDB data is untouched -- only the small
			// inventory record goes) makes this gate's own network the only,
			// and therefore first, entry, regardless of which other gates ran
			// earlier in the same shared context or in what order.
			for (const entry of listNetworks(localStorage)) {
				removeNetwork(entry.networkHash, localStorage);
			}
			return 'clean slate';
		},
	);

	const envelope = composeEnvelope();
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });

	const bootR = await rung(
		'2 · redeemAndBootstrap against real localStorage -- the shipped restore path, seeding an officer who holds all nine scopes',
		async () => {
			const result = await redeemAndBootstrap({ pastedCode: `${SECRET}.${envelope.digest}`, transport, storage: localStorage });
			if (result.outcome !== 'ok') throw new Error(`expected outcome "ok", got "${result.outcome}"`);
			return 'ok';
		},
	);
	if (!bootR.ok) {
		win.__COMPOSE_GATE__ = { phase: PHASE, passed: steps.filter((s) => s.ok).length, total: steps.length, log: LOG };
		win.__COMPOSE_GATE_DONE__ = true;
		return;
	}

	await rung('3 · a registry entry exists, naming the founding officer', async () => {
		const entry = findNetwork(COMPOSE_NETWORK_HASH, localStorage);
		if (!entry) throw new Error('registry entry missing after redeemAndBootstrap');
		return JSON.stringify({ officerUserId: entry.officerUserId, authorityName: entry.authorityName });
	});

	win.__COMPOSE_GATE__ = {
		phase: PHASE,
		passed: steps.filter((s) => s.ok).length,
		total: steps.length,
		log: LOG,
	};
	win.__COMPOSE_GATE_DONE__ = true;
}

async function runComposeVerify() {
	// A broken seed page must never be silently masked by a compensating
	// verify page -- fail loudly here rather than re-seeding.
	const seedCheck = await rung(
		'1 · a prior compose-seed page load already left a registry entry -- verify, never re-seed here',
		async () => {
			const entry = findNetwork(COMPOSE_NETWORK_HASH, localStorage);
			if (!entry) {
				throw new Error('no registry entry for the compose-gate network -- compose-seed must run first, on its own page load');
			}
			return JSON.stringify(entry);
		},
	);

	if (OFFICER_NONE && seedCheck.ok) {
		await rung('1b · &officer=none: rewrite the active entry to an officer id the database grants nothing', async () => {
			const entry = findNetwork(COMPOSE_NETWORK_HASH, localStorage);
			if (!entry) throw new Error('no registry entry to rewrite');
			upsertNetwork({ ...entry, officerUserId: NO_SUCH_OFFICER }, localStorage);
			return `officerUserId -> ${NO_SUCH_OFFICER}`;
		});
	}

	const container = document.getElementById('root');
	let observedPanelCount = 0;
	let badgeText = '';
	let badgeClass = '';
	let disclosurePresent = false;
	let revealAriaPressed: string | null = null;
	const perCapability: Array<{ id: string; framePresent: boolean; bodyPresent: boolean; titleMatches: boolean }> = [];

	if (container) {
		const root = createRoot(container);
		await rung('2 · mount the production DashboardShell -- no scope set supplied by this page', async () => {
			root.render(
				<StrictMode>
					<DashboardShell onRedeemAnother={() => {}} />
				</StrictMode>,
			);
			return 'mounted';
		});

		await rung('3 · settle: a bounded rAF poll until at least one panel section renders, or the frame cap is reached', async () => {
			observedPanelCount = await settleUntilPanels(180);
			return `panels observed: ${observedPanelCount}`;
		});

		await rung('A · panel count equals the full capability set, measured un-revealed', async () => {
			const count = document.querySelectorAll('.panel').length;
			if (count !== CAPABILITIES.length) {
				throw new Error(`expected ${CAPABILITIES.length} panels, observed ${count} -- panels: ${count}`);
			}
			return `panels: ${count}`;
		});

		await rung('B · every capability has a titled, populated panel section', async () => {
			for (const capability of CAPABILITIES) {
				const frame = document.getElementById(`panel-${capability.id}`);
				const framePresent = frame != null;
				const h3 = frame?.querySelector('h3.panel-title');
				const titleMatches = h3?.textContent === t(capability.titleKey);
				const bodyPresent = frame?.querySelector('.panel-body') != null;
				perCapability.push({ id: capability.id, framePresent, bodyPresent, titleMatches });
				if (!framePresent || !titleMatches || !bodyPresent) {
					throw new Error(
						`capability "${capability.id}": framePresent=${framePresent} titleMatches=${titleMatches} bodyPresent=${bodyPresent}`,
					);
				}
			}
			return `${perCapability.length}/${CAPABILITIES.length} capabilities matched`;
		});

		await rung('C · zero access-denied panel sections in the un-revealed state', async () => {
			const denied = document.querySelectorAll('.panel--denied').length;
			if (denied !== 0) throw new Error(`expected 0 denied panel sections, observed ${denied}`);
			return `denied: ${denied}`;
		});

		await rung('D · the scope-gate badge reads the real, database-given answer', async () => {
			const badge = document.querySelector('.pv-badge');
			badgeText = badge?.textContent ?? '';
			badgeClass = badge?.className ?? '';
			if (badgeText !== t('gate.badgeReal')) {
				throw new Error(`badge text "${badgeText}", expected the value of t('gate.badgeReal')`);
			}
			if (!badgeClass.includes('pv-badge--real')) {
				throw new Error(`badge class "${badgeClass}" is missing the real-answer modifier class`);
			}
			return `${badgeText} (${badgeClass})`;
		});

		await rung('E · the D-16 advisory disclosure is present', async () => {
			const disclosure = document.querySelector('.pv-disclosure');
			disclosurePresent = disclosure?.textContent === t('gate.advisoryDisclosure');
			if (!disclosurePresent) {
				throw new Error(`disclosure text "${disclosure?.textContent}", expected the value of t('gate.advisoryDisclosure')`);
			}
			return 'present';
		});

		await rung('F · the reveal toggle is in its default, not-pressed state -- A-C were measured un-revealed', async () => {
			const toggle = document.querySelector('.sh-reveal-toggle');
			revealAriaPressed = toggle?.getAttribute('aria-pressed') ?? null;
			if (revealAriaPressed !== 'false') {
				throw new Error(`reveal toggle aria-pressed="${revealAriaPressed}", expected "false"`);
			}
			return `aria-pressed="${revealAriaPressed}"`;
		});
	} else {
		await rung('2 · #root element not found', async () => {
			throw new Error('compose-gate.html is missing #root');
		});
	}

	const entry = findNetwork(COMPOSE_NETWORK_HASH, localStorage);

	win.__COMPOSE_GATE__ = {
		phase: PHASE,
		officerNone: OFFICER_NONE,
		passed: steps.filter((s) => s.ok).length,
		total: steps.length,
		panels: observedPanelCount,
		perCapability,
		badgeText,
		badgeClass,
		disclosurePresent,
		revealAriaPressed,
		officerUserId: entry?.officerUserId,
		log: LOG,
	};
	win.__COMPOSE_GATE_DONE__ = true;
}

// ---------------------------------------------------------------------------
// compose-swap (Task 3 / D-14, single-use armed by Task 4 / CR-02): a real
// browser drives a different officer's code through the REAL Bootstrap form,
// sees the confirmation, confirms it, and observes the dashboard come back
// under the new officer -- then raises the dialog a second time with a THIRD
// officer's code and declines it.
//
// Both fake transports this leg arms rely on `makeFakeTransport`'s
// SINGLE-USE-BY-DEFAULT semantics (50-20/D-14): a secret's `ok` result can be
// consumed by the wire exactly once, mirroring the real backend. This leg
// asserts that property directly -- dedicated rungs assert the confirmed
// swap's code (`SECRET_SWAP`) reaches the transport's `redeem` exactly once,
// both right after classification and again after the confirm dialog
// resolves (proving the confirm pass replays the single-flight cache rather
// than redeeming a second time), and the cancel leg's code (`SECRET_CANCEL`)
// is asserted spent at most once too. Without this, the leg could report a
// green D-14 end-to-end proof while structurally being unable to see a
// double-spend regression -- see `bootstrap-envelope.js`'s own header.
// ---------------------------------------------------------------------------

/**
 * Bounded `requestAnimationFrame` poll for an element matching `selector` --
 * NEVER a fixed sleep, matching `settleUntilPanels`'s own discipline.
 */
function waitForElement<T extends Element>(selector: string, maxFrames: number): Promise<T> {
	return new Promise((resolve, reject) => {
		let frames = 0;
		function tick() {
			frames += 1;
			const el = document.querySelector<T>(selector);
			if (el) {
				resolve(el);
				return;
			}
			if (frames >= maxFrames) {
				reject(new Error(`waitForElement: "${selector}" not found within ${maxFrames} frames`));
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

/**
 * Bounded `requestAnimationFrame` poll that RESOLVES either way -- `true` if
 * `predicate` became true, `false` if the whole budget was burned without it.
 *
 * `waitUntil` below is for assertions whose passing case is "this happened".
 * This one is for the opposite shape: assertions whose passing case is "this
 * NEVER happened", where burning the full budget IS the evidence and a
 * rejection would be nonsense. Round 3's CR-02 rung needs exactly this, and
 * needs it badly: the second, unguarded `handleConfirmSwap` invocation is
 * queued BEHIND the first on the per-network FIFO lock, so it cannot even
 * begin until the first completes -- and the first writes the registry from
 * INSIDE `redeemAndBootstrap`, well before its own lock task settles. A rung
 * that waited only for the registry to name the incoming officer therefore
 * read the wire-call count BEFORE the second invocation had run at all, and
 * reported one call no matter what. That version of this rung was measured
 * green against a deliberately unguarded `handleConfirmSwap`; it was inert,
 * and this helper is why it no longer is.
 */
function waitForOrTimeout(predicate: () => boolean, maxFrames: number): Promise<boolean> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (predicate()) {
				resolve(true);
				return;
			}
			if (frames >= maxFrames) {
				resolve(false);
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

/** Bounded `requestAnimationFrame` poll for an arbitrary predicate. */
function waitUntil(predicate: () => boolean, maxFrames: number, label: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (predicate()) {
				resolve();
				return;
			}
			if (frames >= maxFrames) {
				reject(new Error(`waitUntil: "${label}" not satisfied within ${maxFrames} frames`));
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

/**
 * The SWAP dialog specifically, never the forget dialog -- `DashboardShell`
 * always renders both `<dialog className="sh-dialog">` elements in the SAME
 * fixed JSX order (forget, then swap), so index `[1]` is stable across
 * renders.
 */
function waitForSwapDialogOpen(maxFrames: number): Promise<HTMLDialogElement> {
	return new Promise((resolve, reject) => {
		let frames = 0;
		function tick() {
			frames += 1;
			const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog.sh-dialog');
			const swapDialog = dialogs[1];
			if (swapDialog?.hasAttribute('open')) {
				resolve(swapDialog);
				return;
			}
			if (frames >= maxFrames) {
				reject(new Error('waitForSwapDialogOpen: the swap confirm dialog did not open'));
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

/**
 * The fake transport `Bootstrap`'s `createTransport` prop returns for the
 * CURRENT submission -- reassigned before each of this leg's two form
 * submissions, so each carries its own envelope/secret pair without a second
 * `Bootstrap` instance or prop-drilled transport.
 */
let activeFakeTransport: IBootstrapTransport | null = null;
function harnessCreateTransport(): IBootstrapTransport {
	if (!activeFakeTransport) {
		throw new Error('compose-swap harness: no active fake transport armed for this submission');
	}
	return activeFakeTransport;
}

/**
 * Wired exactly like `src/main.tsx`'s own `App` -- `Bootstrap`'s
 * `onAlreadyBootstrapped` hands the swap context to `DashboardShell` via
 * `pendingSwapContext`, and `onSwapContextConsumed` clears it once
 * classified. Starts on `'shell'`: compose-seed already bootstrapped the
 * network this leg drives every swap against.
 */
function ComposeSwapApp() {
	const [view, setView] = useState<'bootstrap' | 'shell'>('shell');
	const [swapContext, setSwapContext] = useState<AlreadyBootstrappedContext | null>(null);

	function handleRedeemAnother() {
		setSwapContext(null);
		setView('bootstrap');
	}

	if (view === 'bootstrap') {
		return (
			<Bootstrap
				createTransport={harnessCreateTransport}
				onComplete={() => setView('shell')}
				onAlreadyBootstrapped={(context) => {
					setSwapContext(context);
					setView('shell');
				}}
			/>
		);
	}

	return (
		<DashboardShell
			onRedeemAnother={handleRedeemAnother}
			pendingSwapContext={swapContext}
			onSwapContextConsumed={() => setSwapContext(null)}
		/>
	);
}

/**
 * Sets the pasted-code input's value the way React's controlled input
 * actually observes a change -- through the native `HTMLInputElement.value`
 * setter, bypassing React's own tracked-value shadowing, then dispatches a
 * real `input` event so `onChange` fires.
 */
function typeIntoCodeInput(input: HTMLInputElement, value: string) {
	const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
	nativeSetter?.call(input, value);
	input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Open the switcher and choose "+ Redeem another code" -- the real UI path
 * to the code-entry screen, never a direct `onRedeemAnother()` call. Waits
 * for the row to actually render after the click (React's state update is
 * not guaranteed to have committed by the time `.click()` returns). */
async function openRedeemAnother() {
	const switcherButton = document.querySelector<HTMLButtonElement>('.sh-switcher-button');
	if (!switcherButton) throw new Error('switcher button not found');
	switcherButton.click();
	const redeemAnother = await waitForElement<HTMLButtonElement>('.sh-switcher-redeem', 300);
	redeemAnother.click();
}

async function runComposeSwap() {
	await rung(
		'1 · a prior compose-seed page load already left a registry entry for the founding officer -- verify, never re-seed here',
		async () => {
			const entry = findNetwork(COMPOSE_NETWORK_HASH, localStorage);
			if (!entry) {
				throw new Error('no registry entry for the compose-gate network -- compose-seed must run first, on its own page load');
			}
			if (entry.officerUserId !== FOUNDING_OFFICER_ID) {
				throw new Error(
					`expected the founding officer "${FOUNDING_OFFICER_ID}", found "${entry.officerUserId}" -- a prior page in this run may have already swapped it`,
				);
			}
			return JSON.stringify(entry);
		},
	);

	const container = document.getElementById('root');
	if (!container) {
		await rung('2 · #root element not found', async () => {
			throw new Error('compose-gate.html is missing #root');
		});
		win.__COMPOSE_GATE__ = { phase: PHASE, passed: steps.filter((s) => s.ok).length, total: steps.length, log: LOG };
		win.__COMPOSE_GATE_DONE__ = true;
		return;
	}

	const root = createRoot(container);
	await rung('2 · mount the harness -- Bootstrap and DashboardShell wired exactly like main.tsx, starting on the already-bootstrapped shell', async () => {
		// Wrapped in StrictMode, matching every sibling mount in this file
		// (CR-04). This leg was previously the ONE rung in this suite mounted
		// WITHOUT StrictMode: it puts a SINGLE page through repeated real
		// unmount/remount cycles of the composed shell (Bootstrap<->shell, once
		// per code entry) against the SAME IndexedDB database, and was observed
		// -- empirically, not assumed -- failing roughly 1 run in 3 with a
		// `MisuseError` under StrictMode's dev-only double-invocation of every
		// effect, while two of the four destructive open/close paths
		// (`forgetNetwork` and both `performOfficerSwap` call sites) still ran
		// OUTSIDE the per-network attach lock. Plan 50-22 brought all four
		// destructive/lifecycle families inside `withNetworkDbLifecycleLock`.
		// StrictMode is restored here, and this leg is required to pass FIVE
		// consecutive `--swap-only` runs (run-headless.mjs) as the behavioural
		// evidence that the lock -- not the removal of StrictMode -- is the
		// fix. A failure here must be reported, never worked around by
		// re-removing StrictMode, adding a retry, or widening a frame budget.
		root.render(
			<StrictMode>
				<ComposeSwapApp />
			</StrictMode>,
		);
		return 'mounted';
	});

	await rung('3 · settle: the founding officer\'s nine panels render before this leg touches anything', async () => {
		const count = await settleUntilPanels(180);
		return `panels observed: ${count}`;
	});

	// ---- Confirmed swap: a SECOND officer's code -------------------------
	const officer2Envelope = composeEnvelope(OFFICER_2_ID);
	// singleUse defaults to true (bootstrap-envelope.js) -- relied on
	// deliberately: the production backend enforces exactly-once redemption,
	// and this leg's new wire-call-count rungs (below) assert that property
	// directly against this double's own `calls` array.
	const swapTransport = makeFakeTransport({
		codeToResult: { [SECRET_SWAP]: { status: 'ok', snapshot: officer2Envelope } },
	});
	activeFakeTransport = swapTransport;

	await rung('4 · open the switcher and choose "+ Redeem another code"', async () => {
		await openRedeemAnother();
		return 'bootstrap screen requested';
	});

	await rung('5 · drive a DIFFERENT officer\'s code through the REAL Bootstrap form', async () => {
		const input = await waitForElement<HTMLInputElement>('#dashboard-signin-code', 60);
		typeIntoCodeInput(input, `${SECRET_SWAP}.${officer2Envelope.digest}`);
		const form = input.closest('form');
		if (!form) throw new Error('bootstrap form not found');
		form.requestSubmit();
		return 'submitted';
	});

	await rung('6 · the replace-and-continue confirmation is raised, naming the authority, through t() -- never a literal', async () => {
		const dialog = await waitForSwapDialogOpen(180);
		const heading = dialog.querySelector('h2')?.textContent;
		if (heading !== t('network.swapConfirmHeading')) {
			throw new Error(`dialog heading "${heading}", expected the value of t('network.swapConfirmHeading')`);
		}
		const body = dialog.querySelector('p')?.textContent;
		const expectedBody = t('network.swapConfirmBody', { authorityName: 'Fixture County Elections' });
		if (body !== expectedBody) {
			throw new Error(`dialog body "${body}", expected "${expectedBody}"`);
		}
		return heading;
	});

	await rung(
		'7 · the wire was reached exactly once for SECRET_SWAP after classification (CR-02) -- the confirm dialog was built from a single-flight cache, not a second redemption',
		async () => {
			const count = swapTransport.calls.filter((code) => code === SECRET_SWAP).length;
			if (count !== 1) {
				throw new Error(`expected exactly 1 call to redeem(SECRET_SWAP) after classification, observed ${count}`);
			}
			return `calls: ${count}`;
		},
	);

	await rung('8 · confirm the swap', async () => {
		const dialog = document.querySelectorAll<HTMLDialogElement>('dialog.sh-dialog')[1];
		const confirmBtn = dialog?.querySelector<HTMLButtonElement>('.sh-dialog-cta--primary');
		if (!confirmBtn) throw new Error('swap confirm button not found');
		confirmBtn.click();
		return 'confirmed';
	});

	await rung('9 · the swap resolves without a DeleteBlockedError -- the registry names the NEW officer', async () => {
		await waitUntil(
			() => findNetwork(COMPOSE_NETWORK_HASH, localStorage)?.officerUserId === OFFICER_2_ID,
			240,
			'registry.officerUserId === OFFICER_2_ID',
		);
		const entry = findNetwork(COMPOSE_NETWORK_HASH, localStorage);
		if (entry?.officerUserId !== OFFICER_2_ID) {
			throw new Error(`officerUserId "${entry?.officerUserId}", expected "${OFFICER_2_ID}"`);
		}
		return JSON.stringify(entry);
	});

	await rung(
		'10 · the wire is STILL reached exactly once for SECRET_SWAP after the confirmed swap -- the confirm pass also replayed rather than redeeming again',
		async () => {
			const count = swapTransport.calls.filter((code) => code === SECRET_SWAP).length;
			if (count !== 1) {
				throw new Error(`expected exactly 1 call to redeem(SECRET_SWAP) after the confirmed swap, observed ${count}`);
			}
			return `calls: ${count}`;
		},
	);

	await rung('11 · the panel grid re-renders for the NEW officer -- nine populated panels, zero denied, the real badge', async () => {
		// A confirmed swap re-attaches through the SAME per-network FIFO lock
		// (withNetworkDbLifecycleLock in DashboardShell.tsx) that also serializes
		// against this leg's own prior mounts -- a generous budget accounts for
		// that queued, full DDL-redeclare re-attach, not just a cheap re-render.
		await settleUntilPanels(900);
		const count = document.querySelectorAll('.panel').length;
		const denied = document.querySelectorAll('.panel--denied').length;
		const badge = document.querySelector('.pv-badge');
		if (count !== CAPABILITIES.length) throw new Error(`expected ${CAPABILITIES.length} panels, observed ${count}`);
		if (denied !== 0) throw new Error(`expected 0 denied panel sections, observed ${denied}`);
		if (badge?.textContent !== t('gate.badgeReal')) {
			throw new Error(`badge text "${badge?.textContent}", expected the value of t('gate.badgeReal')`);
		}
		return `panels: ${count}, badge: ${badge?.textContent}`;
	});

	// ---- Cancel rung: a THIRD officer's code, declined --------------------
	const officer3Envelope = composeEnvelope(OFFICER_3_ID);
	// singleUse defaults to true (bootstrap-envelope.js) -- relied on
	// deliberately, same as the confirmed-swap transport above: a declined
	// swap must not have spent its code more than once either.
	const cancelTransport = makeFakeTransport({
		codeToResult: { [SECRET_CANCEL]: { status: 'ok', snapshot: officer3Envelope } },
	});
	activeFakeTransport = cancelTransport;
	const beforeCancel = findNetwork(COMPOSE_NETWORK_HASH, localStorage);

	await rung('12 · raise the dialog again with a THIRD officer\'s code, then decline it (the native Esc path, never a direct state reset)', async () => {
		await openRedeemAnother();
		const input = await waitForElement<HTMLInputElement>('#dashboard-signin-code', 60);
		typeIntoCodeInput(input, `${SECRET_CANCEL}.${officer3Envelope.digest}`);
		const form = input.closest('form');
		if (!form) throw new Error('bootstrap form not found');
		form.requestSubmit();
		const dialog = await waitForSwapDialogOpen(600);
		// The Esc key fires the native `cancel` event on an open <dialog> --
		// DashboardShell.tsx's own onCancel handler is what this dispatches
		// to, exactly as documented in that file's dialog-dismissal note.
		dialog.dispatchEvent(new Event('cancel'));
		return 'declined';
	});

	await rung('13 · the registry entry and the previously-bootstrapped data are BYTE-IDENTICAL to before the decline', async () => {
		await waitUntil(
			() => document.querySelectorAll<HTMLDialogElement>('dialog.sh-dialog')[1]?.hasAttribute('open') === false,
			300,
			'swap dialog closed after cancel',
		);
		const afterCancel = findNetwork(COMPOSE_NETWORK_HASH, localStorage);
		if (JSON.stringify(afterCancel) !== JSON.stringify(beforeCancel)) {
			throw new Error(
				`registry entry changed after a decline -- before=${JSON.stringify(beforeCancel)} after=${JSON.stringify(afterCancel)}`,
			);
		}
		// The dialog raised in rung 12 belongs to a DashboardShell instance
		// that only just remounted (the Bootstrap<->shell round trip its own
		// already-bootstrapped classification took) -- its own attach is
		// still queued behind the same per-network FIFO lock rung 11 waited
		// out. Settle before reading panel counts, same reason as rung 11.
		await settleUntilPanels(900);
		const count = document.querySelectorAll('.panel').length;
		const denied = document.querySelectorAll('.panel--denied').length;
		if (count !== CAPABILITIES.length || denied !== 0) {
			throw new Error(`previously-bootstrapped data no longer renders after the decline -- panels: ${count}, denied: ${denied}`);
		}
		return 'unchanged';
	});

	await rung(
		'14 · a declined swap did not spend SECRET_CANCEL more than once -- the wire was reached at most once',
		async () => {
			const count = cancelTransport.calls.filter((code) => code === SECRET_CANCEL).length;
			if (count > 1) {
				throw new Error(`expected redeem(SECRET_CANCEL) to be called at most once, observed ${count}`);
			}
			return `calls: ${count}`;
		},
	);

	win.__COMPOSE_GATE__ = {
		phase: PHASE,
		passed: steps.filter((s) => s.ok).length,
		total: steps.length,
		log: LOG,
	};
	win.__COMPOSE_GATE_DONE__ = true;
}

// ---------------------------------------------------------------------------
// compose-preview-race (Task 3 / CR-01, D-18): a real page load that touches
// the "Preview as" control DURING an in-flight attach -- the window neither
// the zero-interaction compose-verify leg above nor the tier-3 matrix
// (synchronous scopes) ever exercises. Runs LAST in the default sequence
// (PHASE 10), after compose-swap, so the registry entry names the
// swapped-in officer -- this phase asserts only that an entry exists, not
// which officer it names.
// ---------------------------------------------------------------------------

/**
 * Task 3's window-sample helper: resolves on the FIRST animation frame that
 * finds at least one checkbox inside `.pv-control`, or once `maxFrames`
 * frames have elapsed with none ever appearing -- NEVER a fixed sleep. The
 * caller decides pass/fail from the returned NodeList (possibly empty) and
 * the frame count it took.
 */
function firstFrameCheckboxes(maxFrames: number): Promise<{ boxes: NodeListOf<HTMLInputElement>; frames: number }> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			const boxes = document.querySelectorAll<HTMLInputElement>('.pv-control input[type="checkbox"]');
			if (boxes.length > 0 || frames >= maxFrames) {
				resolve({ boxes, frames });
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

// ---------------------------------------------------------------------------
// Rungs 9-12 (gap-closure round 4, WR-04/RF-04): a harness-only mount that
// drives the ACTUAL CR-01 sequence, not the one rungs 1-8 above are limited
// to. Rung 7 above toggles a checkbox only AFTER rung 6 has already asserted
// `scopesResolved` (and therefore `realScopes`) has settled to the full nine
// -- so it never exercises `resyncRealScopes`'s touched-baseline-advance
// branch, and restoring the pre-50-19 `if (state.touched) return state;`
// short-circuit leaves rungs 1-8 all green (WR-04, confirmed independently).
//
// `DashboardShell` cannot be driven into the real race window on demand: it
// only ever sets `scopesResolved` true in the SAME state update that supplies
// the resolved `realScopes` (see `DashboardShell.tsx`'s attach effect), so
// nothing outside the component can force "resolved but still empty" through
// that mount. What CAN be driven is the production `PreviewAsProvider` /
// `PreviewAsControl` / `PanelGrid` trio directly -- the exact components
// `DashboardShell` composes, imported unmodified, with THIS harness supplying
// `realScopes` and `scopesResolved` on its own schedule. This is the
// "harness-only prop-drilled variant" WR-04's own fix suggestion names.
//
// The harness forces `scopesResolved={true}` from the very first render,
// with `realScopes: []` -- the one-committed-frame residual race the CR-01
// code review (WR-04's own text) describes: "there is exactly one committed
// frame in which `scopesResolved` is already `true` while `state.realScopes`
// is still `[]`." Rung 10 toggles a scope inside that window. A macrotask
// later (never a fixed assumption -- the poll below waits for an effect this
// harness fires the moment `realScopes` actually changes), the "real" scopes
// arrive late as the full nine. Rung 12 presses Reset and asserts the
// recovered set is the full nine with the real (not simulated) badge -- the
// sequence T-50-19-03's node-level test already proves in isolation, now
// proven through the real React components in a real browser.
// ---------------------------------------------------------------------------

/**
 * @param {ReadonlyArray<ScopeCode>} realScopes
 * @param {boolean} scopesResolved
 */
function PreviewRaceHarness({
	realScopes,
}: {
	realScopes: ReadonlyArray<ScopeCode>;
}) {
	return (
		<PreviewAsProvider realScopes={realScopes} scopesResolved={true}>
			<PreviewAsControl />
			<PanelGrid db={null} revealDenied={false} onToggleReveal={() => {}} />
		</PreviewAsProvider>
	);
}

/**
 * The harness's own root state: `realScopes` starts `[]` and arrives at the
 * full nine on a later macrotask, deliberately AFTER the harness has already
 * rendered with `scopesResolved={true}` -- this is what makes the window
 * observable at all. Sets `window.__PREVIEW_RACE_REAL_ARRIVED__` inside an
 * effect (never during render) the instant `realScopes` actually changes, so
 * the bounded poll below has a real signal to wait on instead of a fixed
 * sleep.
 */
function PreviewRaceHarnessRoot() {
	const [realScopes, setRealScopes] = useState<ScopeCode[]>([]);

	useEffect(() => {
		const id = setTimeout(() => {
			setRealScopes([...SCOPE_CODES] as ScopeCode[]);
		}, 30);
		return () => clearTimeout(id);
		// Runs exactly once -- this harness owns one arrival, not a
		// re-triggerable one.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		if (realScopes.length > 0) {
			win.__PREVIEW_RACE_REAL_ARRIVED__ = true;
		}
	}, [realScopes]);

	return <PreviewRaceHarness realScopes={realScopes} />;
}

/**
 * A bounded poll for the harness's own late-arrival signal -- NEVER a fixed
 * sleep. Resolves as soon as `window.__PREVIEW_RACE_REAL_ARRIVED__` is `true`
 * or `maxFrames` have elapsed with it still unset.
 *
 * `window.__PREVIEW_RACE_REAL_ARRIVED__` is set by `PreviewRaceHarnessRoot`'s
 * OWN effect, in the SAME commit that flows the new `realScopes` prop down
 * to `PreviewAsProvider`. But `PreviewAsProvider`'s downstream reaction --
 * its own effect reading the changed `realScopes` prop, calling
 * `resyncRealScopes` and `setState` -- is a CASCADING update: that `setState`
 * schedules a SECOND render+commit, which is not guaranteed to have flushed
 * to the DOM by the animation frame immediately after the flag becomes
 * visible (measured directly: without this margin, Reset observed the
 * PRE-resync baseline about a third of the time). `EXTRA_SETTLE_FRAMES`
 * bounds a wait for that second commit -- still frame-based, still bounded,
 * never an arbitrary millisecond guess.
 */
const EXTRA_SETTLE_FRAMES = 30;

function waitForRealScopesArrival(maxFrames: number): Promise<{ arrived: boolean; frames: number }> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (win.__PREVIEW_RACE_REAL_ARRIVED__ === true || frames >= maxFrames) {
				resolve({ arrived: win.__PREVIEW_RACE_REAL_ARRIVED__ === true, frames });
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

/** Waits `EXTRA_SETTLE_FRAMES` more animation frames -- see
 * `waitForRealScopesArrival`'s header for why the arrival flag alone is not
 * sufficient proof the cascading resync commit has flushed. */
function waitExtraSettleFrames(): Promise<void> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (frames >= EXTRA_SETTLE_FRAMES) {
				resolve();
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

/**
 * A generic bounded `requestAnimationFrame` poll -- NEVER a fixed sleep --
 * that resolves as soon as `predicate()` is true or `maxFrames` elapse.
 * `settleUntilPanels` and `firstFrameCheckboxes` above are each a fixed
 * instance of this same shape; this generalised version exists because
 * rungs 10 and 12 below each need to wait for a DIFFERENT, one-off DOM
 * condition (an exact panel count, an exact checked-checkbox count) that a
 * single `.click()` does not synchronously guarantee has committed and
 * painted by the very next line -- confirmed directly: a debug instrument
 * placed inside `PreviewAsProvider`'s own render, removed again once this
 * was understood, showed the underlying React state was ALREADY correct
 * (9 recovered scopes) at the moment this file's assertion read stale DOM.
 * Reading a click's resulting DOM state must always be bounded-polled, never
 * assumed synchronous.
 */
function waitUntilTrue(predicate: () => boolean, maxFrames: number): Promise<{ ok: boolean; frames: number }> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (predicate() || frames >= maxFrames) {
				resolve({ ok: predicate(), frames });
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

async function runComposePreviewRace() {
	await rung(
		'1 · a registry entry exists for the compose-gate network -- this phase runs after the swap leg, so it names the swapped-in officer, not the founding one',
		async () => {
			const entry = findNetwork(COMPOSE_NETWORK_HASH, localStorage);
			if (!entry) {
				throw new Error('no registry entry for the compose-gate network -- an earlier phase must seed it first');
			}
			return `officerUserId: ${entry.officerUserId}`;
		},
	);

	const container = document.getElementById('root');
	if (!container) {
		await rung('2 · #root element not found', async () => {
			throw new Error('compose-gate.html is missing #root');
		});
		win.__COMPOSE_GATE__ = { phase: PHASE, passed: steps.filter((s) => s.ok).length, total: steps.length, log: LOG };
		win.__COMPOSE_GATE_DONE__ = true;
		return;
	}

	const root = createRoot(container);
	await rung('2 · mount the production DashboardShell -- no scope set supplied by this page', async () => {
		root.render(
			<StrictMode>
				<DashboardShell onRedeemAnother={() => {}} />
			</StrictMode>,
		);
		return 'mounted';
	});

	let sampledCheckboxCount = 0;
	let sampledDisabledCount = 0;
	await rung(
		'3 · the window sample: on the first animation frame after the mount commits, every checkbox inside .pv-control is disabled',
		async () => {
			const { boxes, frames } = await firstFrameCheckboxes(120);
			sampledCheckboxCount = boxes.length;
			if (sampledCheckboxCount === 0) {
				throw new Error(`no checkboxes found inside .pv-control within ${frames} frames`);
			}
			sampledDisabledCount = Array.from(boxes).filter((box) => box.disabled).length;
			if (sampledDisabledCount !== sampledCheckboxCount) {
				throw new Error(
					`expected all ${sampledCheckboxCount} checkboxes disabled on the sampled frame, observed ${sampledDisabledCount} disabled (frame ${frames})`,
				);
			}
			return `checkboxes: ${sampledCheckboxCount}, disabled: ${sampledDisabledCount} (frame ${frames})`;
		},
	);

	await rung('4 · a click during the window changes nothing -- a disabled input does not toggle', async () => {
		const first = document.querySelector<HTMLInputElement>('.pv-control input[type="checkbox"]');
		if (!first) throw new Error('no checkbox found to click');
		const before = first.checked;
		first.click();
		if (first.checked !== before) {
			throw new Error(`checkbox toggled from ${before} to ${first.checked} despite being disabled`);
		}
		return `checked unchanged: ${before}`;
	});

	let observedPanelCount = 0;
	await rung(
		'5 · settle: a bounded rAF poll until at least one panel section renders, or the frame cap is reached',
		async () => {
			observedPanelCount = await settleUntilPanels(180);
			if (observedPanelCount !== CAPABILITIES.length) {
				throw new Error(`expected ${CAPABILITIES.length} panels after settling, observed ${observedPanelCount}`);
			}
			return `panels: ${observedPanelCount}`;
		},
	);

	await rung(
		'6 · the checkboxes are now ENABLED -- the window re-opened once the scopes resolved (positive control proving rung 3 sampled a real transition)',
		async () => {
			const boxes = document.querySelectorAll<HTMLInputElement>('.pv-control input[type="checkbox"]');
			const enabledCount = Array.from(boxes).filter((box) => !box.disabled).length;
			if (boxes.length === 0 || enabledCount !== boxes.length) {
				throw new Error(`expected all ${boxes.length} checkboxes enabled, observed ${enabledCount} enabled`);
			}
			return `enabled: ${enabledCount}/${boxes.length}`;
		},
	);

	await rung(
		'7 · toggling one checkbox OFF drops the panel count and the badge carries the simulated class -- the preview is genuinely doing something',
		async () => {
			const first = document.querySelector<HTMLInputElement>('.pv-control input[type="checkbox"]');
			if (!first) throw new Error('no checkbox found to toggle');
			first.click();
			await settleUntilPanels(180);
			const count = document.querySelectorAll('.panel').length;
			const badge = document.querySelector('.pv-badge');
			if (count >= CAPABILITIES.length) {
				throw new Error(`expected panel count to drop below ${CAPABILITIES.length}, observed ${count}`);
			}
			if (!badge?.className.includes('pv-badge--sim')) {
				throw new Error(`expected the simulated badge class, observed "${badge?.className}"`);
			}
			return `panels: ${count}, badge: ${badge?.className}`;
		},
	);

	await rung(
		'8 · Reset returns the officer to the full nine-panel set, zero denied, the real badge -- the end-to-end CR-01 assertion',
		async () => {
			const resetBtn = document.querySelector<HTMLButtonElement>('.pv-reset');
			if (!resetBtn) throw new Error('reset button not found');
			resetBtn.click();
			await settleUntilPanels(180);
			const count = document.querySelectorAll('.panel').length;
			const denied = document.querySelectorAll('.panel--denied').length;
			const badge = document.querySelector('.pv-badge');
			if (count !== CAPABILITIES.length) throw new Error(`expected ${CAPABILITIES.length} panels, observed ${count}`);
			if (denied !== 0) throw new Error(`expected 0 denied panel sections, observed ${denied}`);
			if (!badge?.className.includes('pv-badge--real')) {
				throw new Error(`expected the real-answer badge class, observed "${badge?.className}"`);
			}
			return `panels: ${count}, denied: ${denied}, badge: ${badge?.className}`;
		},
	);

	// -------------------------------------------------------------------
	// Rungs 9-12 (gap-closure round 4, WR-04/RF-04): swap the mounted tree
	// for the harness-driven composition (see the header comment above
	// `PreviewRaceHarness`) and drive the ACTUAL CR-01 sequence -- toggle
	// DURING the window, before the real scopes have arrived, let them
	// arrive late, Reset, assert full recovery. This is a SEPARATE mount,
	// replacing DashboardShell's tree in the same #root container -- rungs
	// 1-8 above are complete and unaffected by this swap.
	// -------------------------------------------------------------------

	root.render(
		<StrictMode>
			<PreviewRaceHarnessRoot />
		</StrictMode>,
	);

	await rung(
		'9 · harness mount: the window is forced open (scopesResolved=true) while realScopes is still [] -- checkboxes render enabled and zero panels show',
		async () => {
			const { boxes, frames } = await firstFrameCheckboxes(120);
			if (boxes.length === 0) throw new Error(`no checkboxes found inside .pv-control within ${frames} frames`);
			const disabledCount = Array.from(boxes).filter((box) => box.disabled).length;
			if (disabledCount !== 0) {
				throw new Error(`expected all ${boxes.length} checkboxes ENABLED (scopesResolved forced true), observed ${disabledCount} disabled`);
			}
			const panelCount = document.querySelectorAll('.panel').length;
			if (panelCount !== 0) {
				throw new Error(`expected 0 panels before realScopes arrives, observed ${panelCount}`);
			}
			if (win.__PREVIEW_RACE_REAL_ARRIVED__ === true) {
				throw new Error('realScopes already arrived before this rung sampled -- the race window closed too early to be meaningful');
			}
			return `checkboxes: ${boxes.length}, enabled: ${boxes.length - disabledCount}, panels: ${panelCount} (frame ${frames})`;
		},
	);

	await rung(
		'10 · toggling a checkbox DURING the window (realScopes still []) genuinely previews it -- the touched preview against an empty baseline CR-01 is about',
		async () => {
			const first = document.querySelector<HTMLInputElement>('.pv-control input[type="checkbox"]');
			if (!first) throw new Error('no checkbox found to toggle');
			first.click();
			// Bounded poll, not a synchronous read -- a click's resulting
			// commit is not guaranteed to have painted by the very next line
			// (see waitUntilTrue's header).
			const { ok, frames } = await waitUntilTrue(() => document.querySelectorAll('.panel').length === 1, 180);
			const badge = document.querySelector('.pv-badge');
			const panelCount = document.querySelectorAll('.panel').length;
			if (!ok) {
				throw new Error(`expected exactly 1 panel (the toggled scope) after the toggle within ${frames} frames, observed ${panelCount}`);
			}
			if (!badge?.className.includes('pv-badge--sim')) {
				throw new Error(`expected the simulated badge class after the toggle, observed "${badge?.className}"`);
			}
			return `badge: ${badge?.className}, panels: ${panelCount} (frame ${frames})`;
		},
	);

	await rung(
		'11 · the real scopes arrive LATE, after the toggle -- the touched preview is not yanked out from under the officer, and the baseline advances silently underneath it',
		async () => {
			const { arrived, frames } = await waitForRealScopesArrival(180);
			if (!arrived) throw new Error(`realScopes never arrived within ${frames} frames`);
			// See waitForRealScopesArrival's header: the arrival flag alone does
			// not prove PreviewAsProvider's cascading resync commit has flushed
			// yet -- give it EXTRA_SETTLE_FRAMES more frames before this rung's
			// own assertions (and rung 12's Reset) read the DOM.
			await waitExtraSettleFrames();
			const badge = document.querySelector('.pv-badge');
			const panelCount = document.querySelectorAll('.panel').length;
			if (!badge?.className.includes('pv-badge--sim')) {
				throw new Error(`expected the preview to survive the late arrival (still simulated), observed "${badge?.className}"`);
			}
			if (panelCount !== 1) {
				throw new Error(`expected the preview to still show exactly 1 panel after the late arrival, observed ${panelCount}`);
			}
			return `arrived at frame ${frames}, badge still: ${badge?.className}, panels still: ${panelCount}`;
		},
	);

	await rung(
		'12 · Reset, AFTER the late arrival, recovers the full nine-scope set with the REAL badge -- the end-to-end CR-01 recovery sequence WR-04/RF-04 found untested',
		async () => {
			const resetBtn = document.querySelector<HTMLButtonElement>('.pv-reset');
			if (!resetBtn) throw new Error('reset button not found');
			resetBtn.click();
			// Bounded poll, not a synchronous read -- see waitUntilTrue's header:
			// a debug instrument confirmed the underlying React state recovers to
			// the full nine correctly and immediately, but reading the DOM on the
			// very next line raced the paint and observed stale (pre-Reset) markup.
			const { ok, frames } = await waitUntilTrue(
				() => document.querySelectorAll<HTMLInputElement>('.pv-control input[type="checkbox"]:checked').length === SCOPE_CODES.length,
				180,
			);
			const panelCount = document.querySelectorAll('.panel').length;
			const checkedCount = document.querySelectorAll<HTMLInputElement>('.pv-control input[type="checkbox"]:checked').length;
			const badge = document.querySelector('.pv-badge');
			if (!ok) {
				throw new Error(`expected all ${SCOPE_CODES.length} scopes checked after Reset within ${frames} frames, observed ${checkedCount}`);
			}
			if (panelCount !== CAPABILITIES.length) {
				throw new Error(`expected ${CAPABILITIES.length} panels after Reset, observed ${panelCount}`);
			}
			if (!badge?.className.includes('pv-badge--real')) {
				throw new Error(`expected the real-answer badge class after Reset, observed "${badge?.className}"`);
			}
			return `checked: ${checkedCount}/${SCOPE_CODES.length}, panels: ${panelCount}, badge: ${badge?.className} (frame ${frames})`;
		},
	);

	win.__COMPOSE_GATE__ = {
		phase: PHASE,
		passed: steps.filter((s) => s.ok).length,
		total: steps.length,
		sampledCheckboxCount,
		sampledDisabledCount,
		panels: observedPanelCount,
		log: LOG,
	};
	win.__COMPOSE_GATE_DONE__ = true;
}

// ---------------------------------------------------------------------------
// compose-guards (gap-closure round 3): the two Criticals and the twin Warning
// that round 3 found, all of which are about STATE THAT IS NEVER WRITTEN or a
// HANDLER THAT RUNS TWICE -- properties with no source-text signature, which is
// exactly why roughly thirty tier-1 `assert.match(CODE, /.../)` matchers and
// ten green browser phases all shipped past them. Every rung below drives a
// real state transition on the production `DashboardShell` and reads the answer
// out of the DOM, the real registry, or the fake transport's own honest call
// log -- never out of a source string.
//
// This phase seeds BOTH of its own networks and clears the registry first, so
// it depends on no earlier phase; it runs LAST in the default sequence because
// it ends destructively (it forgets one of its own two networks on purpose).
//
// It reaches `DashboardShell`'s classify seam by supplying `pendingSwapContext`
// DIRECTLY, exactly as `src/main.tsx` does. That is deliberate, not a shortcut:
// PHASE 9 (compose-swap) already proves the Bootstrap -> shell half of that
// handoff end to end through the real form, and driving the form again here
// would REMOUNT `DashboardShell` between legs -- resetting `activeNetworkHash`
// to `networks[0]` and destroying the very cross-network state CR-01 is about.
// The transport handed over is the real `createSingleFlightTransport`, warmed
// with one real `ok` redemption exactly as `redeemAndBootstrap` warms it.
// ---------------------------------------------------------------------------

/** Two networks, so a failure raised on one can be observed NOT to follow the officer to the other. */
const GUARD_NETWORK_A = 'compose-guards-network-a';
const GUARD_NETWORK_B = 'compose-guards-network-b';
/** Distinct authority names -- the topbar and the switcher rows render these, so they are how a rung tells which network is actually active. */
const GUARD_AUTHORITY_A = 'Guard County A';
const GUARD_AUTHORITY_B = 'Guard County B';
/** Four secrets, all distinct from every sibling gate's and from each other; 40 lowercase hex characters, the format `splitSignInCode` requires. */
const GUARD_SECRET_SEED_A = '1'.repeat(40);
const GUARD_SECRET_SEED_B = '2'.repeat(40);
const GUARD_SECRET_INDETERMINATE = '3'.repeat(40);
const GUARD_SECRET_SWAP = '4'.repeat(40);
/** The incoming officer of this phase's confirmed swap. */
const GUARD_OFFICER_2_ID = 'compose-guards-officer-2';

/**
 * A structurally real envelope for `networkHash`, naming `authorityName` and
 * granting `userId` all nine scopes -- rebuilt through `buildSnapshot` so
 * manifest/digest/schemaHash stay internally consistent, same discipline as
 * `composeEnvelope` above. Parameterizing the AUTHORITY NAME is what
 * `composeEnvelope` does not do, and this phase needs two networks a rung can
 * tell apart on screen.
 */
function guardEnvelope(networkHash: string, authorityName: string, userId: string) {
	const base = buildFixtureEnvelope();
	const tables: SnapshotTables = {
		...base.tables,
		Authority: (base.tables.Authority ?? []).map((row: SnapshotRow) => ({ ...row, Name: authorityName })),
		Officer: (base.tables.Officer ?? []).map((row: SnapshotRow) => ({
			...row,
			UserId: userId,
			Scopes: JSON.stringify(SCOPE_CODES),
		})),
		User: (base.tables.User ?? []).map((row: SnapshotRow) => ({ ...row, Id: userId })),
		Network: (base.tables.Network ?? []).map((row: SnapshotRow) => ({ ...row, Hash: networkHash })),
	};
	return buildSnapshot({ networkHash, tables, generatedAt: base.generatedAt });
}

/**
 * The seam a rung uses to hand `DashboardShell` a swap context, wired exactly
 * like `main.tsx`'s own `pendingSwapContext` prop. Assigned from an effect (not
 * a render body) so StrictMode's setup/cleanup/setup leaves it correctly set.
 */
let pushGuardSwapContext: ((context: AlreadyBootstrappedContext | null) => void) | null = null;

function GuardsApp() {
	const [swapContext, setSwapContext] = useState<AlreadyBootstrappedContext | null>(null);
	useEffect(() => {
		pushGuardSwapContext = setSwapContext;
		return () => {
			pushGuardSwapContext = null;
		};
	}, []);
	return (
		<DashboardShell
			onRedeemAnother={() => {}}
			pendingSwapContext={swapContext}
			onSwapContextConsumed={() => setSwapContext(null)}
		/>
	);
}

/**
 * Arm ONE swap context: a fresh fake wire transport, wrapped in the REAL
 * single-flight decorator, warmed with exactly one `ok` redemption the way
 * `redeemAndBootstrap` warms it, then handed to the shell. Returns the INNER
 * fake, whose `calls` array is the honest record of how many times the wire was
 * actually reached -- the only place a double-spend is visible.
 */
async function armGuardSwapContext(secret: string, envelope: ReturnType<typeof guardEnvelope>) {
	const inner = makeFakeTransport({ codeToResult: { [secret]: { status: 'ok', snapshot: envelope } } });
	const single = createSingleFlightTransport(inner);
	const first = await single.transport.redeem(secret);
	if (first.status !== 'ok') {
		throw new Error(`arm: expected the fixture transport to return "ok", got "${first.status}"`);
	}
	if (!pushGuardSwapContext) throw new Error('arm: GuardsApp is not mounted');
	pushGuardSwapContext({
		networkHash: envelope.networkHash,
		pastedCode: `${secret}.${envelope.digest}`,
		transport: single.transport,
		reset: single.reset,
	});
	return inner;
}

/**
 * The SWAP-failure banners specifically. `.sh-error-banner` is shared with the
 * attach-failure banner, so a rung that merely counted that class could not
 * tell the two apart -- match on the banner's own heading, through `t()`.
 */
function swapErrorBanners() {
	return Array.from(document.querySelectorAll('.sh-error-banner')).filter(
		(banner) => banner.querySelector('p')?.textContent === t('network.swapErrorHeading'),
	);
}

/** Open the network switcher and choose the row whose name matches -- the real UI path, never a direct state write. */
async function selectNetworkByName(authorityName: string) {
	const switcherButton = document.querySelector<HTMLButtonElement>('.sh-switcher-button');
	if (!switcherButton) throw new Error('switcher button not found');
	switcherButton.click();
	await waitForElement('.sh-switcher-row', 300);
	const row = Array.from(document.querySelectorAll<HTMLButtonElement>('.sh-switcher-row')).find(
		(candidate) => candidate.querySelector('.sh-switcher-row-name')?.textContent === authorityName,
	);
	if (!row) throw new Error(`no switcher row named "${authorityName}"`);
	row.click();
}

async function runComposeGuards() {
	const envelopeA = guardEnvelope(GUARD_NETWORK_A, GUARD_AUTHORITY_A, FOUNDING_OFFICER_ID);
	const envelopeB = guardEnvelope(GUARD_NETWORK_B, GUARD_AUTHORITY_B, FOUNDING_OFFICER_ID);

	await rung('1 · clean slate: delete both guard databases and clear EVERY registry entry -- this phase depends on no earlier one', async () => {
		await deleteNetworkDb(GUARD_NETWORK_A, { storage: localStorage });
		await deleteNetworkDb(GUARD_NETWORK_B, { storage: localStorage });
		for (const entry of listNetworks(localStorage)) {
			removeNetwork(entry.networkHash, localStorage);
		}
		return 'clean slate';
	});

	const seedR = await rung('2 · seed TWO networks through the shipped restore path -- A first, so the shell opens on it', async () => {
		for (const [secret, envelope] of [
			[GUARD_SECRET_SEED_A, envelopeA],
			[GUARD_SECRET_SEED_B, envelopeB],
		] as const) {
			const transport = makeFakeTransport({ codeToResult: { [secret]: { status: 'ok', snapshot: envelope } } });
			// eslint-disable-next-line no-await-in-loop -- the two bootstraps must land in registry order
			const result = await redeemAndBootstrap({ pastedCode: `${secret}.${envelope.digest}`, transport, storage: localStorage });
			if (result.outcome !== 'ok') throw new Error(`seeding ${envelope.networkHash}: expected "ok", got "${result.outcome}"`);
		}
		const names = listNetworks(localStorage).map((entry) => entry.authorityName);
		if (names.length !== 2 || names[0] !== GUARD_AUTHORITY_A) {
			throw new Error(`expected exactly two entries with "${GUARD_AUTHORITY_A}" first, got ${JSON.stringify(names)}`);
		}
		return JSON.stringify(names);
	});

	const container = document.getElementById('root');
	if (!seedR.ok || !container) {
		await rung('3 · cannot mount', async () => {
			throw new Error(container ? 'seeding failed' : 'compose-gate.html is missing #root');
		});
		win.__COMPOSE_GATE__ = { phase: PHASE, passed: steps.filter((s) => s.ok).length, total: steps.length, log: LOG };
		win.__COMPOSE_GATE_DONE__ = true;
		return;
	}

	const root = createRoot(container);
	await rung('3 · mount the production DashboardShell, wired to a pendingSwapContext seam exactly as main.tsx wires it', async () => {
		root.render(
			<StrictMode>
				<GuardsApp />
			</StrictMode>,
		);
		return 'mounted';
	});

	await rung('4 · settle: network A renders its nine panels, and the topbar names A', async () => {
		const count = await settleUntilPanels(300);
		const name = document.querySelector('.sh-authority-name')?.textContent;
		if (count !== CAPABILITIES.length) throw new Error(`expected ${CAPABILITIES.length} panels, observed ${count}`);
		if (name !== GUARD_AUTHORITY_A) throw new Error(`topbar names "${name}", expected "${GUARD_AUTHORITY_A}"`);
		return `panels: ${count}, active: ${name}`;
	});

	// ---- CR-01: a swap failure on network A must not follow the officer to B ----

	await rung(
		'5 · CR-01 precondition: an officer-indeterminate classification for network A replaces A\'s grid with the swap-failure banner',
		async () => {
			await armGuardSwapContext(GUARD_SECRET_INDETERMINATE, withExtraUserRow(envelopeA));
			await waitUntil(() => swapErrorBanners().length === 1, 300, 'the swap-failure banner rendered for network A');
			const panels = document.querySelectorAll('.panel').length;
			if (panels !== 0) throw new Error(`expected the banner to REPLACE the grid, but ${panels} panels are still rendered`);
			return `banners: 1, panels: ${panels}`;
		},
	);

	await rung(
		'6 · CR-01: switch to network B -- B renders its own nine panels and ZERO swap-failure banners (a stale swapError would blank a healthy network)',
		async () => {
			await selectNetworkByName(GUARD_AUTHORITY_B);
			await waitUntil(
				() => document.querySelector('.sh-authority-name')?.textContent === GUARD_AUTHORITY_B,
				300,
				'the topbar names network B',
			);
			await settleUntilPanels(900);
			const panels = document.querySelectorAll('.panel').length;
			const banners = swapErrorBanners().length;
			const denied = document.querySelectorAll('.panel--denied').length;
			if (banners !== 0) {
				throw new Error(
					`network B is rendering ${banners} swap-failure banner(s) raised by network A -- panels: ${panels} (CR-01: swapError was never cleared)`,
				);
			}
			if (panels !== CAPABILITIES.length) throw new Error(`expected ${CAPABILITIES.length} panels for network B, observed ${panels}`);
			if (denied !== 0) throw new Error(`expected 0 denied panel sections, observed ${denied}`);
			return `panels: ${panels}, banners: ${banners}, denied: ${denied}`;
		},
	);

	// ---- CR-02: the swap confirm CTA must spend a single-use code ONCE ----
	// Each leg re-selects the network it needs, so the legs are order-
	// independent and none of them inherits another's end state.

	await rung('7 · switch back to network A -- the confirmed-swap leg drives the network the shell is actually attached to', async () => {
		await selectNetworkByName(GUARD_AUTHORITY_A);
		await waitUntil(
			() => document.querySelector('.sh-authority-name')?.textContent === GUARD_AUTHORITY_A,
			300,
			'the topbar names network A',
		);
		await settleUntilPanels(900);
		return `active: ${document.querySelector('.sh-authority-name')?.textContent}`;
	});

	const swapWire = await armGuardSwapContext(
		GUARD_SECRET_SWAP,
		guardEnvelope(GUARD_NETWORK_A, GUARD_AUTHORITY_A, GUARD_OFFICER_2_ID),
	);

	await rung('8 · a DIFFERENT officer\'s code for network A raises the replace-and-continue confirmation', async () => {
		const dialog = await waitForSwapDialogOpen(600);
		const heading = dialog.querySelector('h2')?.textContent;
		if (heading !== t('network.swapConfirmHeading')) {
			throw new Error(`dialog heading "${heading}", expected the value of t('network.swapConfirmHeading')`);
		}
		const wireCalls = swapWire.calls.filter((code) => code === GUARD_SECRET_SWAP).length;
		if (wireCalls !== 1) throw new Error(`expected 1 wire call to arm the context, observed ${wireCalls}`);
		return `dialog open, wire calls so far: ${wireCalls}`;
	});

	await rung(
		'9 · DOUBLE-CLICK the confirm CTA in one synchronous burst -- exactly what an impatient officer, or a trackpad, produces',
		async () => {
			const dialog = document.querySelectorAll<HTMLDialogElement>('dialog.sh-dialog')[1];
			const cta = dialog?.querySelector<HTMLButtonElement>('.sh-dialog-cta--primary');
			if (!cta) throw new Error('swap confirm button not found');
			// Count what actually DISPATCHED. A rung that clicks twice but only
			// ever dispatches once would be inert without ever saying so -- and
			// `disabled` is exactly the property the fix adds, so this control
			// also records that the SECOND click was refused by the platform
			// rather than by luck.
			let dispatched = 0;
			cta.addEventListener('click', () => { dispatched += 1; }, true);
			cta.click();
			const disabledAfterFirst = cta.disabled;
			cta.click();
			return `dispatched: ${dispatched}, disabled after the first click: ${disabledAfterFirst}`;
		},
	);

	await rung(
		'10 · CR-02: the single-use code reached the wire exactly ONCE across both clicks -- a second redemption is a real double-spend the backend answers "used"',
		async () => {
			const countCalls = () => swapWire.calls.filter((code) => code === GUARD_SECRET_SWAP).length;
			await waitUntil(
				() => findNetwork(GUARD_NETWORK_A, localStorage)?.officerUserId === GUARD_OFFICER_2_ID,
				900,
				'the swap landed and the registry names the incoming officer',
			);
			// THE REGISTRY UPDATE IS NOT A SETTLING POINT for this assertion.
			// `redeemAndBootstrap` writes the registry from inside the FIRST
			// invocation's lock task, so a second, unguarded invocation -- queued
			// behind that task -- has not even started at this moment. Wait for
			// the second wire call SPECIFICALLY, resolving early the instant one
			// lands (fail fast) and otherwise burning the whole budget, which is
			// what makes "exactly one" a measurement rather than a race.
			const secondCallLanded = await waitForOrTimeout(() => countCalls() > 1, 240);
			const wireCalls = countCalls();
			if (secondCallLanded) {
				throw new Error(
					`a SECOND redeem(GUARD_SECRET_SWAP) reached the wire -- the officer's single-use code was spent twice (CR-02); calls: ${wireCalls}`,
				);
			}
			if (wireCalls !== 1) {
				throw new Error(
					`redeem(GUARD_SECRET_SWAP) reached the wire ${wireCalls} times -- the officer's single-use code was spent more than once (CR-02)`,
				);
			}
			return `wire calls: ${wireCalls}`;
		},
	);

	await rung(
		'11 · positive control (NOT a CR-02 discriminator -- measured green in both directions): the guarded swap still LANDED cleanly, nine panels for the incoming officer',
		async () => {
			// HONEST LABEL. This rung was written expecting the second, doomed
			// invocation's `code-refused` to surface as a swap-failure banner, and
			// it does not: `setSwapError` from that invocation is swallowed by the
			// re-attach the FIRST invocation's `setNetworks` triggers, whose reset
			// block now clears `swapError` (CR-01). Measured directly -- with the
			// CR-02 guard deliberately removed this rung still passes while rung 10
			// fails. It is kept as a positive control that the guard did not break
			// the swap it guards, and is NOT counted as evidence for CR-02. Rung 10
			// is the only rung in this phase that discriminates that fix.
			await waitForOrTimeout(() => swapErrorBanners().length > 0, 240);
			await settleUntilPanels(900);
			const panels = document.querySelectorAll('.panel').length;
			const banners = swapErrorBanners().length;
			const denied = document.querySelectorAll('.panel--denied').length;
			if (banners !== 0) throw new Error(`observed ${banners} swap-failure banner(s) after a confirmed swap -- panels: ${panels}`);
			if (panels !== CAPABILITIES.length) throw new Error(`expected ${CAPABILITIES.length} panels, observed ${panels}`);
			if (denied !== 0) throw new Error(`expected 0 denied panel sections, observed ${denied}`);
			return `panels: ${panels}, banners: ${banners}, officer: ${findNetwork(GUARD_NETWORK_A, localStorage)?.officerUserId}`;
		},
	);

	// ---- WR-10: the same missing in-flight guard, on the forget path ----
	// A second `forgetNetwork` for a hash the first invocation already removed
	// throws `UnknownNetworkError` and sets `forgetError` on a dialog the first
	// invocation already closed -- an error state the officer can NEVER see, on
	// a destructive action. Because it is invisible in the DOM by construction,
	// the observable is `handleConfirmForget`'s own `console.error`, which only
	// its `catch` reaches: with the guard, the second invocation never runs and
	// nothing is logged; without it, exactly one failure is logged. That is a
	// real runtime side effect of the second invocation, not a source string.
	const forgetFailures: string[] = [];
	const realConsoleError = console.error;

	await rung('12 · switch to network B and open its forget dialog through the real kebab menu', async () => {
		await selectNetworkByName(GUARD_AUTHORITY_B);
		await waitUntil(
			() => document.querySelector('.sh-authority-name')?.textContent === GUARD_AUTHORITY_B,
			300,
			'the topbar names network B',
		);
		const kebab = document.querySelector<HTMLButtonElement>('.sh-kebab-button');
		if (!kebab) throw new Error('kebab button not found');
		kebab.click();
		const forgetItem = await waitForElement<HTMLButtonElement>('.sh-kebab-item--destructive', 300);
		forgetItem.click();
		const input = await waitForElement<HTMLInputElement>('#sh-forget-confirmation', 300);
		typeIntoCodeInput(input, GUARD_AUTHORITY_B);
		await waitUntil(
			() => document.querySelector<HTMLButtonElement>('.sh-dialog-cta--destructive')?.disabled === false,
			300,
			'the typed confirmation enabled the destructive CTA',
		);
		return `forget dialog armed for ${GUARD_AUTHORITY_B}`;
	});

	await rung('13 · DOUBLE-CLICK the destructive CTA in one synchronous burst', async () => {
		const cta = document.querySelector<HTMLButtonElement>('.sh-dialog-cta--destructive');
		if (!cta) throw new Error('forget confirm button not found');
		console.error = (...args: unknown[]) => {
			if (String(args[0]).startsWith('forgetNetwork failed:')) forgetFailures.push(args.map(String).join(' '));
			realConsoleError(...args);
		};
		let dispatched = 0;
		cta.addEventListener('click', () => { dispatched += 1; }, true);
		cta.click();
		const disabledAfterFirst = cta.disabled;
		cta.click();
		return `dispatched: ${dispatched}, disabled after the first click: ${disabledAfterFirst}`;
	});

	await rung(
		'14 · WR-10: exactly ONE forgetNetwork ran -- network B is gone, network A survives, and no invisible failure was logged for a second, doomed invocation',
		async () => {
			try {
				await waitUntil(() => findNetwork(GUARD_NETWORK_B, localStorage) === undefined, 900, 'network B was forgotten');
				// Same shape as rung 10: the passing case is "a second invocation
				// never ran", so give it its full chance before declaring it absent.
				const secondRan = await waitForOrTimeout(() => forgetFailures.length > 0, 240);
				if (secondRan) {
					throw new Error(
						`a SECOND forgetNetwork invocation ran and failed on a dialog the first had already closed (WR-10): ${forgetFailures.join(' | ')}`,
					);
				}
				if (!findNetwork(GUARD_NETWORK_A, localStorage)) {
					throw new Error('network A was removed too -- a forget reached the wrong network');
				}
				await settleUntilPanels(900);
				const panels = document.querySelectorAll('.panel').length;
				if (panels !== CAPABILITIES.length) {
					throw new Error(`expected network A's ${CAPABILITIES.length} panels after the forget, observed ${panels}`);
				}
				return `remaining: ${listNetworks(localStorage).map((entry) => entry.authorityName).join(',')}, logged failures: ${forgetFailures.length}, panels: ${panels}`;
			} finally {
				console.error = realConsoleError;
			}
		},
	);

	win.__COMPOSE_GATE__ = {
		phase: PHASE,
		passed: steps.filter((s) => s.ok).length,
		total: steps.length,
		log: LOG,
	};
	win.__COMPOSE_GATE_DONE__ = true;
}

// ===========================================================================
// compose-refusal (52-12 / D-25): three real refusals, one page load.
//
// WHY ONE PAGE LOAD AND NOT THREE: a per-status rung passes even when two
// copy families are accidentally identical. Only a CROSS-status comparison can
// see convergence, and that needs all three observations in one place.
//
// WHAT IS REAL HERE: the REAL `Bootstrap` component, the REAL form, the REAL
// `redeemAndBootstrap` -> `copyKeysForOutcome` -> `t()` path. Nothing about the
// copy lookup is re-implemented by the harness; every expected string is
// resolved through the frozen copy table's own `t()`, never a literal, so this
// leg measures WIRING and RENDERING, not the harness's own opinion of the copy.
// ===========================================================================

/**
 * The status each of this leg's three codes is answered with, and the exact
 * text its alert must carry.
 *
 * EVERY expectation is resolved through the frozen copy table's own `t()`,
 * by literal key, at this one place -- never a copied string literal. A copy
 * change therefore moves the expectation with it; a WIRING change (the wrong
 * family selected for a status) still fails, which is the defect this leg
 * exists to catch.
 *
 * `&conflate=1` rewrites the STATUSES only -- never the product code and never
 * an assertion.
 */
function refusalPlan(): ReadonlyArray<{ secret: string; status: 'unknown' | 'used' | 'expired'; expectedHeading: string; expectedBody: string }> {
	const timedOut = {
		status: 'expired' as const,
		expectedHeading: t('bootstrap.errorCodeTimedOutHeading'),
		expectedBody: t('bootstrap.errorCodeTimedOutBody'),
	};
	if (CONFLATE) {
		// The inertness inversion: the SAME status three times, on three
		// distinct secrets so `singleUse` cannot interfere. Rungs 3-5 then
		// assert only that an alert rendered, leaving rung 6 to fail on three
		// identical observations.
		return [
			{ secret: SECRET_CONFLATE_A, ...timedOut },
			{ secret: SECRET_CONFLATE_B, ...timedOut },
			{ secret: SECRET_CONFLATE_C, ...timedOut },
		];
	}
	return [
		{
			secret: SECRET_REFUSE_UNKNOWN,
			status: 'unknown',
			expectedHeading: t('bootstrap.errorCodeNotRecognizedHeading'),
			expectedBody: t('bootstrap.errorCodeNotRecognizedBody'),
		},
		{
			secret: SECRET_REFUSE_USED,
			status: 'used',
			expectedHeading: t('bootstrap.errorCodeAlreadyUsedHeading'),
			expectedBody: t('bootstrap.errorCodeAlreadyUsedBody'),
		},
		{ secret: SECRET_REFUSE_EXPIRED, ...timedOut },
	];
}

async function runComposeRefusal() {
	// The digest half comes from a REAL envelope, so every pasted code
	// satisfies SIGNIN_CODE_PATTERN and reaches the transport. A locally
	// malformed code would exercise INVALID_CODE_KEYS instead and prove nothing
	// whatsoever about the three refusal families.
	const envelope = composeEnvelope();
	const plan = refusalPlan();

	await rung('1 · clean slate: clear EVERY registry entry, so no sibling phase\'s network can route a submission elsewhere', async () => {
		for (const entry of listNetworks(localStorage)) {
			removeNetwork(entry.networkHash, localStorage);
		}
		return `entries remaining: ${listNetworks(localStorage).length}`;
	});

	// ONE transport holding all three codes: a refusal never marks a secret
	// spent (`makeFakeTransport`'s `spent` set is only written for `ok`), and
	// the three secrets are distinct anyway.
	const refusalTransport = makeFakeTransport({
		codeToResult: Object.fromEntries(plan.map((leg) => [leg.secret, { status: leg.status }])),
	});
	activeFakeTransport = refusalTransport;

	const container = document.getElementById('root');
	if (!container) {
		await rung('2 · cannot mount', async () => {
			throw new Error('compose-gate.html is missing #root');
		});
		win.__COMPOSE_GATE__ = { phase: PHASE, passed: steps.filter((s) => s.ok).length, total: steps.length, log: LOG };
		win.__COMPOSE_GATE_DONE__ = true;
		return;
	}

	const root = createRoot(container);
	const mounted = await rung('2 · mount the REAL Bootstrap screen alone (no DashboardShell -- a refusal never commits a network) and confirm the code input rendered', async () => {
		root.render(
			<StrictMode>
				<Bootstrap createTransport={harnessCreateTransport} />
			</StrictMode>,
		);
		const input = await waitForElement<HTMLInputElement>('#dashboard-signin-code', 180);
		return `input present: ${input.id}`;
	});

	/** Observations collected across rungs 3-5, compared cross-status in 6-7. */
	const observed: Array<{ status: string; heading: string; body: string }> = [];

	/**
	 * Drive ONE code through the real form and read back what the alert
	 * actually rendered.
	 *
	 * THE STALE-ALERT TRAP, and why the wait below is explicit: the alert from
	 * the PREVIOUS submission is still in the DOM when the next one starts. A
	 * naive `waitForElement('[role="alert"]')` would resolve instantly against
	 * it and report the previous rung's text as this rung's -- three rungs all
	 * "passing" while measuring one submission. That is precisely how a
	 * three-status distinctness check goes silently inert, so this waits for
	 * the old alert to CLEAR first (the screen drops it on the in-flight
	 * re-render) and only then for a new one to appear. Bounded rAF polls
	 * throughout -- never a fixed sleep.
	 */
	async function driveRefusal(secret: string): Promise<{ heading: string; body: string }> {
		const previousAlert = document.querySelector('[role="alert"]');
		const input = await waitForElement<HTMLInputElement>('#dashboard-signin-code', 180);
		typeIntoCodeInput(input, `${secret}.${envelope.digest}`);
		const form = input.closest('form');
		if (!form) throw new Error('bootstrap form not found');
		form.requestSubmit();

		if (previousAlert) {
			await waitUntil(
				() => !document.contains(previousAlert),
				300,
				'the previous submission\'s alert to clear before reading the next one',
			);
		}
		// A submission that renders NO alert within the bounded poll fails the
		// rung -- an absent element is never a pass.
		const alert = await waitForElement<HTMLElement>('[role="alert"]', 300);
		const heading = alert.querySelector('h2')?.textContent ?? '';
		const body = alert.querySelector('p')?.textContent ?? '';
		if (heading.length === 0 || body.length === 0) {
			throw new Error(`the alert rendered with an empty heading (${JSON.stringify(heading)}) or body (${JSON.stringify(body)})`);
		}
		return { heading, body };
	}

	for (const [index, leg] of plan.entries()) {
		const rungNumber = index + 3;
		// eslint-disable-next-line no-await-in-loop -- the three submissions are strictly sequential through ONE form
		await rung(
			`${rungNumber} · drive the "${leg.status}" code through the REAL Bootstrap form and read the rendered alert`,
			async () => {
				if (!mounted.ok) throw new Error('the screen never mounted -- nothing to drive');
				const { heading, body } = await driveRefusal(leg.secret);
				observed.push({ status: leg.status, heading, body });
				if (CONFLATE) {
					// The inversion asserts only that an alert rendered. Leaving
					// the copy assertion in would fail HERE rather than at the
					// distinctness rung, and would prove nothing about whether
					// that rung can discriminate.
					return `alert observed (conflate mode): ${heading}`;
				}
				if (heading !== leg.expectedHeading) {
					throw new Error(`the "${leg.status}" alert rendered the heading "${heading}", expected the copy table's own "${leg.expectedHeading}"`);
				}
				if (body !== leg.expectedBody) {
					throw new Error(`the "${leg.status}" alert rendered the body "${body}", expected the copy table's own "${leg.expectedBody}"`);
				}
				return heading;
			},
		);
	}

	await rung(
		'6 · DISTINCTNESS across all three: no two statuses rendered the same heading, and no two rendered the same body',
		async () => {
			if (observed.length !== 3) {
				throw new Error(`expected 3 observations, collected ${observed.length} -- an earlier rung did not produce an alert`);
			}
			for (const field of ['heading', 'body'] as const) {
				const seen = new Map<string, string>();
				for (const entry of observed) {
					const value = entry[field];
					const collidedWith = seen.get(value);
					if (collidedWith !== undefined) {
						throw new Error(
							`the "${collidedWith}" and "${entry.status}" refusals rendered the SAME ${field}: "${value}" -- an officer cannot tell the two conditions apart`,
						);
					}
					seen.set(value, entry.status);
				}
				if (seen.size !== 3) {
					throw new Error(`expected 3 distinct ${field}s, observed ${seen.size}`);
				}
			}
			return `3 distinct headings, 3 distinct bodies`;
		},
	);

	await rung(
		'7 · no machine identifier reached the DOM -- asserted on what the browser actually PAINTED, not on what the copy table holds',
		async () => {
			// Derived, never hand-typed: every outcome code (all hyphenated, so
			// no false positives) plus the three refusal statuses. `'ok'` is
			// excluded -- a two-letter substring match fires on ordinary prose.
			const forbidden = [...BOOTSTRAP_OUTCOME_CODES.filter((code) => code !== 'ok'), 'unknown', 'expired', 'used'];
			const fixture = 'the service answered unknown';
			if (!forbidden.some((token) => fixture.includes(token))) {
				throw new Error('matcher is inert -- the positive-control fixture did not trip it');
			}
			for (const entry of observed) {
				for (const value of [entry.heading, entry.body]) {
					for (const token of forbidden) {
						if (value.toLowerCase().includes(token)) {
							throw new Error(`the "${entry.status}" alert painted the machine identifier "${token}": "${value}"`);
						}
					}
				}
			}
			return `${observed.length * 2} rendered strings, none carrying a machine identifier`;
		},
	);

	win.__COMPOSE_GATE__ = {
		phase: PHASE,
		passed: steps.filter((s) => s.ok).length,
		total: steps.length,
		log: LOG,
	};
	win.__COMPOSE_GATE_DONE__ = true;
}

async function main() {
	log('start', `compose-gate phase=${PHASE} officer=${OFFICER_NONE ? 'none' : 'real'}`);
	if (PHASE === 'compose-seed') {
		await runComposeSeed();
	} else if (PHASE === 'compose-verify') {
		await runComposeVerify();
	} else if (PHASE === 'compose-swap') {
		await runComposeSwap();
	} else if (PHASE === 'compose-preview-race') {
		await runComposePreviewRace();
	} else if (PHASE === 'compose-guards') {
		await runComposeGuards();
	} else if (PHASE === 'compose-refusal') {
		await runComposeRefusal();
	} else {
		throw new Error(`compose-gate: unknown phase "${PHASE}"`);
	}
}

main().catch((err) => {
	log('crash', String((err as { stack?: unknown })?.stack ?? err));
	win.__COMPOSE_GATE__ = { phase: PHASE, crashed: String((err as { stack?: unknown })?.stack ?? err), log: LOG };
	win.__COMPOSE_GATE_DONE__ = true;
	// eslint-disable-next-line no-console
	console.error('[compose-gate] crashed', err);
});
