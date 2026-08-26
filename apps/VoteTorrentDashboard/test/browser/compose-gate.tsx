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
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildSnapshot } from '@votetorrent/vote-engine/bootstrap';
import type { IBootstrapTransport, SnapshotRow, SnapshotTables } from '@votetorrent/vote-engine/bootstrap';
import { redeemAndBootstrap } from '../../src/lifecycle/bootstrap.js';
import { deleteNetworkDb } from '../../src/db/open-db.js';
import { findNetwork, listNetworks, removeNetwork, upsertNetwork } from '../../src/db/networks-registry.js';
import { CAPABILITIES, SCOPE_CODES } from '../../src/auth/capabilities.js';
import { t } from '../../src/i18n/copy.js';
import { Bootstrap } from '../../src/screens/Bootstrap.js';
import type { AlreadyBootstrappedContext } from '../../src/screens/Bootstrap.js';
import { DashboardShell } from '../../src/screens/DashboardShell.js';
import { buildFixtureEnvelope, makeFakeTransport } from '../fixtures/bootstrap-envelope.js';

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

const LOG: Array<{ t: string; ms: number; category: string; message: string }> = [];
const t0 = performance.now();
function log(category: string, message: string) {
	LOG.push({ t: new Date().toISOString(), ms: +(performance.now() - t0).toFixed(1), category, message });
}

const params = new URLSearchParams(location.search);
const PHASE = params.get('phase') ?? 'compose-seed';
const OFFICER_NONE = params.get('officer') === 'none';

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
