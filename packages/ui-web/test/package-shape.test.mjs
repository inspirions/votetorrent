/**
 * package-shape.test.mjs — the tier-1 proof that `@votetorrent/ui-web`'s four
 * load-bearing shape properties (D-16) are falsifiable, not merely asserted.
 *
 * What each rung catches:
 *   1. Positive control  — proves a bundler-only `.tsx` re-export barrel
 *      genuinely throws `ERR_MODULE_NOT_FOUND` under plain Node. Uses the
 *      `bundler-only-barrel` fixture, not the real (currently empty)
 *      `./components` barrel, so this is measured rather than assumed.
 *   2. Benign control    — proves rung 1's matcher discriminates: the
 *      fixture's plain-JS barrel must resolve fine, or rung 1 would pass on
 *      any mistyped fixture path.
 *   3. The real `.` subpath  — Node-importable with no bundler.
 *   4. The real `./tokens.css` subpath — resolves to a file that exists.
 *   5. Exports map shape — exactly three keys, in the expected order/targets.
 *   6. Peer+dev React pairing — TS2875 guard.
 *   7. Never-hoist-React — root manifest purity, with a positive control that
 *      the right file (and not a mis-resolved one) was read.
 *   8. Barrel / `.tsx` lockstep — a future `.tsx` component added without a
 *      re-export, or a re-export added without its `.tsx` backing, goes red.
 *
 * Two forbidden vacuous shapes, named explicitly so neither creeps back in:
 *   - Do not interpolate a value under test into a test's NAME (turns the
 *     assertion into documentation instead of a check).
 *   - Do not use an always-true disjunct in an assertion's condition (passes
 *     on a completely broken page/module — 090's `docSection.md` names this
 *     exact trap).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');
const FIXTURE_ROOT = path.join(HERE, 'fixtures', 'bundler-only-barrel');
const ROOT_PACKAGE_JSON = path.join(PACKAGE_ROOT, '..', '..', 'package.json');

test('rung 1 (positive control): the fixture bundler-only barrel throws ERR_MODULE_NOT_FOUND under plain Node', async () => {
	const specifier = pathToFileURL(path.join(FIXTURE_ROOT, 'src', 'components.js')).href;
	await assert.rejects(() => import(specifier), /** @param {NodeJS.ErrnoException} err */ (err) => {
		assert.equal(err.code, 'ERR_MODULE_NOT_FOUND');
		return true;
	});
});

test('rung 2 (benign control): the fixture plain-JS barrel resolves fine and exposes its sentinel', async () => {
	const specifier = pathToFileURL(path.join(FIXTURE_ROOT, 'src', 'index.js')).href;
	const mod = await import(specifier);
	assert.equal(mod.FIXTURE_PLAIN_JS_SENTINEL, 'fixture-plain-js-sentinel');
});

test('rung 3: the real `.` subpath of @votetorrent/ui-web is Node-importable with no bundler', async () => {
	const mod = await import('@votetorrent/ui-web');
	assert.equal(typeof mod, 'object');
	assert.notEqual(mod, null);
});

test('rung 4: the real `./tokens.css` subpath resolves to an existing file', () => {
	const resolved = import.meta.resolve('@votetorrent/ui-web/tokens.css');
	const resolvedPath = fileURLToPath(resolved);
	assert.ok(existsSync(resolvedPath), `expected ${resolvedPath} to exist`);
});

test('rung 5: the exports map is exactly four keys, in order, mapping to their expected targets', () => {
	// 53-05 (D-01/D-02) adds `./lifecycle` for election-phase.js, on the
	// plain-JS side of the split (see src/index.js's header for why it is a
	// separate entry rather than a `.` re-export): it does not merge `.` and
	// `./components`, so this rung's other assertions (import via `.`,
	// ERR_MODULE_NOT_FOUND via `./components`, tokens.css resolving) all stay
	// true unchanged -- only the key count and order grow by one.
	const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
	assert.deepEqual(Object.keys(pkg.exports), ['.', './components', './lifecycle', './tokens.css']);
	assert.equal(pkg.exports['.'], './src/index.js');
	assert.equal(pkg.exports['./components'], './src/components.js');
	assert.equal(pkg.exports['./lifecycle'], './src/lifecycle/election-phase.js');
	assert.equal(pkg.exports['./tokens.css'], './src/tokens.css');
});

test('rung 6: react and react-dom are pinned at exactly 19.0.0 in both peerDependencies and devDependencies (TS2875 guard)', () => {
	const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
	for (const field of ['peerDependencies', 'devDependencies']) {
		for (const dep of ['react', 'react-dom']) {
			assert.equal(
				pkg[field][dep],
				'19.0.0',
				`${field}.${dep} must be exactly 19.0.0 — peer-only fails tsc with TS2875 ` +
					`(the package needs a local React to resolve and typecheck itself)`,
			);
		}
	}
});

test('rung 7: react/react-dom never appear in the root manifest, and @types/react IS present (proves the right file was read)', () => {
	const rootPkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8'));
	const fieldsToCheck = [
		'dependencies',
		'devDependencies',
		'peerDependencies',
		'optionalDependencies',
		'resolutions',
	];
	for (const field of fieldsToCheck) {
		const section = rootPkg[field] ?? {};
		for (const dep of ['react', 'react-dom']) {
			assert.equal(
				dep in section,
				false,
				`root package.json ${field} must never declare "${dep}" — hoisting React to the ` +
					`root builds green and dies at the first hook`,
			);
		}
	}
	// Positive control: prove this rung read the correct file, not a mis-resolved path.
	assert.equal(rootPkg.resolutions?.['@types/react'], '19.2.17');
});

test('rung 8: every ./components/ barrel re-export specifier has a sibling .tsx (never a sibling .js), and the two counts agree', () => {
	// Scoped to `./components/*.js` specifiers only (53-09): components.js
	// also re-exports `packageReactIdentity` from `./react-identity.js`, a
	// genuinely plain-JS module with no .tsx backing and deliberately outside
	// the `./components/` subfolder this rung governs — an unscoped regex
	// would wrongly demand a .tsx sibling for it and wrongly flag the real
	// react-identity.js file as a "literal .js file defeating the
	// ERR_MODULE_NOT_FOUND proof", which it does not participate in (it is
	// plain JS on both the source and the resolved-specifier side by design).
	const componentsSrc = readFileSync(path.join(PACKAGE_ROOT, 'src', 'components.js'), 'utf8');
	const specifierRe = /from\s+['"](\.\/components\/[^'"]+\.js)['"]/g;
	const specifiers = [...componentsSrc.matchAll(specifierRe)].map((m) => m[1]);

	const componentsDir = path.join(PACKAGE_ROOT, 'src', 'components');
	const tsxCount = existsSync(componentsDir)
		? readdirSync(componentsDir).filter((f) => f.endsWith('.tsx')).length
		: 0;

	assert.equal(
		specifiers.length,
		tsxCount,
		'the number of .js re-export specifiers in components.js must equal the number of .tsx ' +
			'files directly under src/components/ — a mismatch means either an unexported component ' +
			'or a re-export missing its .tsx backing',
	);

	for (const specifier of specifiers) {
		const jsPath = path.join(PACKAGE_ROOT, 'src', specifier);
		const tsxPath = jsPath.replace(/\.js$/, '.tsx');
		assert.ok(existsSync(tsxPath), `expected a sibling .tsx for specifier "${specifier}" at ${tsxPath}`);
		assert.ok(
			!existsSync(jsPath),
			`specifier "${specifier}" must resolve ONLY via a bundler's .tsx extension probe — a ` +
				`literal .js file at ${jsPath} would defeat the ERR_MODULE_NOT_FOUND proof`,
		);
	}
});
