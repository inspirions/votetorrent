/**
 * shell-gate.js — Task 4's page driver: proves the restored-snapshot leg
 * 50-08 handed over, and the D-15 forget-network leg, across a genuinely
 * fresh page load. Imports the PRODUCTION modules by relative path, so this
 * gate proves the shipped code, not a copy.
 *
 * Reproduces `db-gate.js`'s `rung()`/readout convention under DISTINCT
 * names — `window.__SHELL_GATE__` / `window.__SHELL_GATE_DONE__` — so the
 * two gates can never be confused. Every step renders with `textContent`
 * only, never as raw markup: nothing derived from the database reaches the
 * DOM unescaped (mirrors `db-gate.js`'s own T-50-05-06 discipline).
 *
 * This page is test-only and is never part of the production Vite build.
 *
 * `?phase=` takes four values: `restore-seed`, `restore-verify` (also reads
 * `&expect=`, the phase-1 counts encoded for exact-equality comparison),
 * `forget`, `forget-verify`. The two network hashes both phases operate on
 * are DETERMINISTIC constants derived from the shared 50-08 fixture, not
 * plumbed through the URL — a fresh page load can recompute either without
 * carrying state across the boundary itself.
 */
import { buildSnapshot } from '@votetorrent/vote-engine/bootstrap';
import { redeemAndBootstrap } from '../../src/lifecycle/bootstrap.js';
import { forgetNetwork, assertNetworkForgotten } from '../../src/lifecycle/forget-network.js';
import { snapshotFreshness } from '../../src/lifecycle/freshness.js';
import {
	attachNetworkDb,
	readRowCounts,
	closeNetworkDb,
	deleteNetworkDb,
	dbNameFor,
	listObjectStores,
	findNetwork,
} from '@votetorrent/web-data/officer';
import { t } from '@votetorrent/ui-web';
import { buildFixtureEnvelope, makeFakeTransport, FIXTURE_NETWORK_HASH } from '../fixtures/bootstrap-envelope.js';

/** @type {any} */
const win = window;

const SECRET = 'a'.repeat(40);
const SECRET_2 = 'b'.repeat(40);

/** The primary network this leg restores and later forgets. */
const PRIMARY_HASH = FIXTURE_NETWORK_HASH;
/** The neighbouring network the forget leg's negative control uses to prove
 * a forget deletes exactly one network's data and nothing else. */
const SECOND_HASH = `${FIXTURE_NETWORK_HASH}-second`;

/** @type {Array<{ t: string, ms: number, category: string, message: string, meta?: unknown }>} */
const LOG = [];
const t0 = performance.now();
/** @param {string} category @param {string} message @param {unknown} [meta] */
const log = (category, message, meta) =>
	LOG.push({
		t: new Date().toISOString(),
		ms: +(performance.now() - t0).toFixed(1),
		category,
		message,
		...(meta !== undefined ? { meta } : {}),
	});

const params = new URLSearchParams(location.search);
const PHASE = params.get('phase') ?? 'restore-seed';

const stepsEl = document.getElementById('steps');
/** @type {{ name: string, el: HTMLElement, start: number }[]} */
const steps = [];

/** @param {{ el: HTMLElement, start: number }} rec @param {'ok'|'fail'} state @param {string} [detail] */
function settle(rec, state, detail) {
	rec.el.className = `step ${state}`;
	rec.el.textContent = `[${state}] ${rec.el.dataset.name} ${detail ?? ''} (${(performance.now() - rec.start).toFixed(0)}ms)`;
	log(state === 'ok' ? 'pass' : 'fail', rec.el.dataset.name ?? '', detail);
}

/**
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ ok: boolean, value?: T, error?: string }>}
 */
async function rung(name, fn) {
	const el = document.createElement('div');
	el.className = 'step pending';
	el.dataset.name = name;
	// textContent only -- see the file header.
	el.textContent = name;
	stepsEl?.appendChild(el);
	const rec = { name, el, start: performance.now() };
	steps.push(rec);
	try {
		const v = await fn();
		settle(rec, 'ok', typeof v === 'string' ? v : undefined);
		return { ok: true, value: v };
	} catch (err) {
		settle(rec, 'fail', String(/** @type {any} */ (err)?.message ?? err).slice(0, 400));
		return { ok: false, error: String(/** @type {any} */ (err)?.message ?? err) };
	}
}

/**
 * The pristine primary envelope, rebuilt fresh on every call (this module
 * is re-imported into a brand-new JS realm on every page load, so there is
 * no module-level caching concern to worry about here).
 */
function primaryEnvelope() {
	return buildFixtureEnvelope();
}

/**
 * A second, independent envelope for `SECOND_HASH` -- rebuilt through
 * `buildSnapshot` so its manifest/digest/schemaHash stay internally
 * consistent. Used only by the forget leg's negative control.
 */
function secondEnvelope() {
	const base = buildFixtureEnvelope();
	const tables = {
		...base.tables,
		Network: (base.tables.Network ?? []).map((row) => ({ ...row, Hash: SECOND_HASH })),
	};
	return buildSnapshot({ networkHash: SECOND_HASH, tables, generatedAt: base.generatedAt });
}

async function main() {
	log('start', `shell-gate phase=${PHASE}`, { ua: navigator.userAgent });

	if (PHASE === 'restore-seed') {
		await runRestoreSeed();
	} else if (PHASE === 'restore-verify') {
		await runRestoreVerify();
	} else if (PHASE === 'forget') {
		await runForget();
	} else if (PHASE === 'forget-verify') {
		await runForgetVerify();
	}

	finish();
}

async function runRestoreSeed() {
	await rung('1 · delete any prior database, registry entry and row-count record for a clean slate', async () => {
		await deleteNetworkDb(PRIMARY_HASH);
		await deleteNetworkDb(SECOND_HASH);
		return 'clean slate';
	});

	const envelope = primaryEnvelope();
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });

	const bootR = await rung('2 · redeemAndBootstrap against real localStorage -- the shipped restore path, not a hand-rolled seed', () =>
		redeemAndBootstrap({ pastedCode: `${SECRET}.${envelope.digest}`, transport, storage: localStorage }),
	);
	if (!bootR.ok || !bootR.value || /** @type {any} */ (bootR.value).outcome !== 'ok') {
		win.__SHELL_GATE__ = { phase: 'restore-seed', passed: 0, total: steps.length, log: LOG };
		return;
	}

	await rung('3 · publish per-table counts and the registry entry', async () => {
		win.__SHELL_GATE_COUNTS__ = envelope.manifest;
		return JSON.stringify(envelope.manifest);
	});

	await rung('4 · IndexedDB object stores actually created', async () => {
		const names = await listObjectStores(PRIMARY_HASH);
		if (names.length === 0) {
			throw new Error('ZERO object stores — the restored rows went to the in-memory module, not IndexedDB');
		}
		return `${names.length} stores`;
	});

	await rung('5 · close the handle before the page boundary', async () => 'closed');

	win.__SHELL_GATE__ = {
		phase: 'restore-seed',
		passed: steps.filter((s) => !s.el.classList.contains('fail')).length,
		total: steps.length,
		counts: envelope.manifest,
		log: LOG,
	};
}

async function runRestoreVerify() {
	const expected = JSON.parse(params.get('expect') ?? 'null');

	await rung('1 · object stores survived the page boundary', async () => {
		const names = await listObjectStores(PRIMARY_HASH);
		if (names.length === 0) throw new Error('ZERO object stores — nothing was persisted');
		return `${names.length} stores present`;
	});

	const attachR = await rung('2 · attachNetworkDb — the restored rows read back in a fresh JS realm', () =>
		attachNetworkDb(PRIMARY_HASH),
	);
	if (!attachR.ok || !attachR.value) {
		win.__SHELL_GATE__ = { phase: 'restore-verify', passed: 0, total: steps.length, log: LOG };
		return;
	}
	const db = attachR.value;

	await rung('3 · re-read counts and compare against the seed page — exact equality', async () => {
		const counts = await readRowCounts(db, Object.keys(expected ?? {}));
		if (!expected) return `read back: ${JSON.stringify(counts)}`;
		/** @type {string[]} */
		const diffs = [];
		for (const table of Object.keys(expected)) {
			if (counts[table] !== expected[table]) {
				diffs.push(`${table}: expected ${expected[table]}, got ${counts[table]}`);
			}
		}
		if (diffs.length) throw new Error('row counts diverged after reload: ' + diffs.join('; '));
		return `identical to phase 1: ${JSON.stringify(counts)}`;
	});

	/** @type {any} */
	let entry;
	await rung('4 · the registry entry survived intact, bootstrappedAt included', async () => {
		entry = findNetwork(PRIMARY_HASH, localStorage);
		if (!entry) throw new Error('registry entry missing after the page boundary');
		return JSON.stringify(entry);
	});

	// The D-10 rendered-age rung. This proves the age is computed from the
	// PERSISTED timestamp across a real page boundary, through the same
	// functions the shell uses -- it does NOT prove the React shell renders
	// it; that model↔DOM cross-check belongs to a later plan.
	await rung('5 · D-10 rendered age, computed from the persisted bootstrappedAt', async () => {
		if (!entry) throw new Error('no registry entry to compute freshness from');
		const freshness = snapshotFreshness(entry.bootstrappedAt);
		const node = /** @type {HTMLElement | null} */ (document.querySelector('[data-testid="snapshot-age"]'));
		if (!node) throw new Error('snapshot-age node missing from the document');
		node.textContent = t('snapshot.asOf', { relativeTime: freshness.relativeTime });
		node.title = freshness.absolute;
		if (!node.textContent) throw new Error('rendered age text is empty');
		if (entry.bootstrappedAt.length !== 19) throw new Error('bootstrappedAt is not the canonical 19-character form');
		if (node.title !== entry.bootstrappedAt) throw new Error('tooltip does not carry the raw canonical bootstrappedAt');
		return node.textContent;
	});

	await rung('6 · close the handle', async () => {
		await closeNetworkDb(db);
		return 'closed';
	});

	win.__SHELL_GATE__ = {
		phase: 'restore-verify',
		passed: steps.filter((s) => !s.el.classList.contains('fail')).length,
		total: steps.length,
		log: LOG,
	};
}

async function runForget() {
	/** @type {any} */
	const entry = findNetwork(PRIMARY_HASH, localStorage);

	const attachR = await rung('1 · attachNetworkDb — obtain a live handle exactly as the shell does', () =>
		attachNetworkDb(PRIMARY_HASH),
	);
	if (!attachR.ok || !attachR.value) {
		win.__SHELL_GATE__ = { phase: 'forget', passed: 0, total: steps.length, log: LOG };
		return;
	}
	const db = attachR.value;

	await rung('2 · forgetNetwork with the correct typed confirmation', async () => {
		const result = await forgetNetwork({
			networkHash: PRIMARY_HASH,
			typedConfirmation: entry?.authorityName ?? '',
			db,
			storage: localStorage,
		});
		return `remaining: ${result.remaining.length}`;
	});

	// The paired negative -- re-bootstrap a SECOND, neighbouring network in
	// this same page, attempt to forget it with a WRONG typed confirmation,
	// and assert it survives. A rejection test asserts the named reason and
	// carries its positive control, per this project's twice-burned rule.
	const second = secondEnvelope();
	const secondTransport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: second } } });

	await rung('3 · re-bootstrap a second, neighbouring network', async () => {
		const result = await redeemAndBootstrap({
			pastedCode: `${SECRET_2}.${second.digest}`,
			transport: secondTransport,
			storage: localStorage,
		});
		if (/** @type {any} */ (result).outcome !== 'ok') {
			throw new Error(`expected ok, got ${/** @type {any} */ (result).outcome}`);
		}
		return 'ok';
	});

	const secondDb = await attachNetworkDb(SECOND_HASH);
	await rung('4 · a wrong typed confirmation on the second network rejects ForgetConfirmationMismatchError by name, and it survives', async () => {
		let threw = false;
		try {
			await forgetNetwork({
				networkHash: SECOND_HASH,
				typedConfirmation: 'definitely not the authority name',
				db: secondDb,
				storage: localStorage,
			});
		} catch (err) {
			threw = true;
			if (/** @type {any} */ (err)?.name !== 'ForgetConfirmationMismatchError') {
				throw new Error(`expected ForgetConfirmationMismatchError, got ${/** @type {any} */ (err)?.name}`);
			}
		}
		if (!threw) throw new Error('expected forgetNetwork to reject a wrong typed confirmation');
		if (!findNetwork(SECOND_HASH, localStorage)) {
			throw new Error('the second network must still be present after a rejected forget');
		}
		return 'survived';
	});
	await closeNetworkDb(secondDb);

	win.__SHELL_GATE__ = {
		phase: 'forget',
		passed: steps.filter((s) => !s.el.classList.contains('fail')).length,
		total: steps.length,
		log: LOG,
	};
}

async function runForgetVerify() {
	await rung('1 · assertNetworkForgotten resolves — the three-way absence check', () =>
		assertNetworkForgotten(PRIMARY_HASH, localStorage),
	);

	await rung('2 · indexedDB.databases() no longer lists the forgotten database', async () => {
		if (typeof indexedDB.databases !== 'function') return 'indexedDB.databases() unavailable — skipped, non-fatal';
		const remaining = await indexedDB.databases();
		const name = dbNameFor(PRIMARY_HASH);
		if (remaining.some((db) => db.name === name)) throw new Error(`"${name}" is still listed`);
		return 'absent';
	});

	// WR-06 real-browser proof, placed BEFORE rung 3's attachNetworkDb attempt
	// deliberately: rung 3 below is itself known to open a raw handle and
	// re-declare the schema before its own NotBootstrappedError check fires
	// (see 50-17-SUMMARY.md's "carried-forward finding" on attachNetworkDb),
	// which would otherwise leave a resurrected database in place BEFORE this
	// rung ever ran, confounding whether ITS probe or something upstream
	// created it. Ordered here, this rung isolates exactly one question: does
	// `listObjectStores`, called on a network rungs 1-2 just confirmed absent,
	// resurrect it by itself? This is the one thing `fake-indexeddb` cannot
	// stand in for — a real browser's shared store-plugin connection
	// singleton is exactly the thing under test here.
	await rung('3 · listObjectStores probes the forgotten network without resurrecting it', async () => {
		const stores = await listObjectStores(PRIMARY_HASH);
		if (stores.length !== 0) {
			throw new Error(`expected [] for a forgotten network, got ${stores.length} store(s): ${stores.join(', ')}`);
		}
		if (typeof indexedDB.databases !== 'function') {
			return 'listObjectStores returned [] (indexedDB.databases() unavailable to re-confirm — non-fatal)';
		}
		const remaining = await indexedDB.databases();
		const name = dbNameFor(PRIMARY_HASH);
		if (remaining.some((entry) => entry.name === name)) {
			throw new Error(`the probe itself resurrected "${name}" — indexedDB.databases() lists it after the probe ran`);
		}
		return 'still absent after the probe';
	});

	await rung('4 · attachNetworkDb rejects, by name, for the forgotten network', async () => {
		let threw = false;
		/** @type {string | undefined} */
		let errorName;
		try {
			const db = await attachNetworkDb(PRIMARY_HASH);
			await closeNetworkDb(db);
		} catch (err) {
			threw = true;
			errorName = /** @type {any} */ (err)?.name;
		}
		if (!threw) throw new Error('expected attachNetworkDb to reject for a forgotten network');
		return errorName ?? 'error';
	});

	await rung('5 · the neighbouring network from the forget page survived, and still attaches with its counts', async () => {
		const entry = findNetwork(SECOND_HASH, localStorage);
		if (!entry) throw new Error('the neighbouring network is missing — a forget must delete exactly one network');
		const db = await attachNetworkDb(SECOND_HASH);
		await closeNetworkDb(db);
		return 'present';
	});

	win.__SHELL_GATE__ = {
		phase: 'forget-verify',
		passed: steps.filter((s) => !s.el.classList.contains('fail')).length,
		total: steps.length,
		log: LOG,
	};
}

function finish() {
	const failed = steps.filter((s) => s.el.classList.contains('fail'));
	const verdictEl = document.getElementById('verdict');
	const text =
		failed.length === 0
			? `PASS phase "${PHASE}" — all ${steps.length} rungs passed`
			: `FAIL phase "${PHASE}" — ${failed.length} of ${steps.length} failed`;
	if (verdictEl) verdictEl.textContent = text;
	log('verdict', text);
	win.__SHELL_GATE__ = {
		...(win.__SHELL_GATE__ ?? {}),
		phase: PHASE,
		passed: steps.length - failed.length,
		total: steps.length,
		failed: failed.map((f) => f.el.dataset.name),
		log: LOG,
	};
	win.__SHELL_GATE_DONE__ = true;
	console.log('[shell-gate] ' + text);
}

main().catch((e) => {
	log('crash', String(e?.stack ?? e));
	win.__SHELL_GATE__ = { phase: PHASE, crashed: String(e?.stack ?? e), log: LOG };
	win.__SHELL_GATE_DONE__ = true;
	console.error('[shell-gate] crashed', e);
});
