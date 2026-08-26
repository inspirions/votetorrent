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
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { buildSnapshot } from '@votetorrent/vote-engine/bootstrap';
import type { SnapshotRow, SnapshotTables } from '@votetorrent/vote-engine/bootstrap';
import { redeemAndBootstrap } from '../../src/lifecycle/bootstrap.js';
import { deleteNetworkDb } from '../../src/db/open-db.js';
import { findNetwork, listNetworks, removeNetwork, upsertNetwork } from '../../src/db/networks-registry.js';
import { CAPABILITIES, SCOPE_CODES } from '../../src/auth/capabilities.js';
import { t } from '../../src/i18n/copy.js';
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
 */
function composeEnvelope() {
	const base = buildFixtureEnvelope();
	const officerRows: readonly SnapshotRow[] = base.tables.Officer ?? [];
	const networkRows: readonly SnapshotRow[] = base.tables.Network ?? [];
	const tables: SnapshotTables = {
		...base.tables,
		Officer: officerRows.map((row) => ({ ...row, Scopes: JSON.stringify(SCOPE_CODES) })),
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

async function main() {
	log('start', `compose-gate phase=${PHASE} officer=${OFFICER_NONE ? 'none' : 'real'}`);
	if (PHASE === 'compose-seed') {
		await runComposeSeed();
	} else if (PHASE === 'compose-verify') {
		await runComposeVerify();
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
