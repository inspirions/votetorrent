/**
 * source-scan.mjs — the one scanning engine every gate in 54-08 shares.
 *
 * WHY IT IS A LIBRARY AND NOT FOUR NEAR-COPIES. Four gates in this package need
 * the same four primitives: strip comments, walk a source tree, extract module
 * specifiers, split a select list. Written four times they drift, and a drifted
 * matcher is how a gate quietly stops covering the thing it names. Written once,
 * a fix to the stripper fixes every gate, and every gate's positive control is
 * simultaneously a control for the others.
 *
 * THIS FILE IMPORTS `node:test` NOWHERE, deliberately. The package's test glob is
 * `test/*.test.mjs`; this module sits at `test/lib/` and is neither collected as a
 * suite nor named like one, so it can never be mistaken for a gate that passed.
 *
 * PROVENANCE / SCOPE. Test-and-script tooling only, in the same sense
 * `scripts/lib/source-paths.mjs` declares for itself: never imported by any `src/`
 * module, never reaching a production bundle. It reads bytes out of the working
 * tree and never writes them.
 *
 * REJECTED DEPENDENCY, recorded so it is not "restored" later: spike 090's
 * `closure.mjs` is NOT used by anything here (54-RESEARCH Pitfall 5). It follows
 * only relative specifiers and records a bare workspace specifier such as
 * `@votetorrent/web-data/public` as external — which is precisely the edge these
 * gates must cross — and it is a frozen historical spike record, so coupling a
 * product gate to it would make a historical artifact load-bearing.
 *
 * Deps: node:fs and node:path only.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Extensions a table name, a module specifier or a SQL string could be written
 * in as CODE. Every one of these is scanned.
 * @type {ReadonlyArray<string>}
 */
export const CODE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

/**
 * Extensions a source scan may skip. Enumerated rather than implied by "not in
 * CODE_EXTENSIONS", so that a file type nobody thought about lands in `unknown`
 * and forces a decision instead of being silently skipped.
 *
 * EVERY ENTRY IS A DECISION, and the decision is always the same one: a file of
 * this type cannot reference a schema table as CODE, cannot declare a module
 * specifier, and cannot carry a SQL string a guard would need to read. The raster
 * image types are here because `apps/VoteTorrentAuthority/src/assets/images/`
 * holds three of them and rule C2 walks every product `src` root; skipping them
 * is correct, but it must be recorded here rather than implied by a catch-all.
 * A new type is NOT added to this list to make a red gate green — it is added
 * only after answering "could a table name be written in this file as code?".
 * @type {ReadonlyArray<string>}
 */
export const NON_CODE_EXTENSIONS = Object.freeze([
	'.css',
	'.html',
	'.md',
	'.json',
	'.svg',
	'.snap',
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.ico',
]);

/** Directory names never walked. */
const SKIP_DIRS = Object.freeze(['node_modules', 'dist', 'dist-gate', '.git']);

/** Thrown when a scan root holds a file whose extension is in neither list. */
export class UnknownExtensionError extends Error {
	/** @param {ReadonlyArray<string>} files */
	constructor(files) {
		super(
			`UnknownExtensionError: ${files.length} file(s) under a scan root have an extension in ` +
				`neither CODE_EXTENSIONS nor NON_CODE_EXTENSIONS, so the scan does not know whether to ` +
				`read them: ${files.join(', ')}. Classify the extension in source-scan.mjs deliberately; ` +
				`do NOT let it default to skipped.`,
		);
		this.name = 'UnknownExtensionError';
	}
}

/**
 * Partition a file list into what a scan reads, what it may skip, and what it
 * does not recognise.
 *
 * THE `unknown` BUCKET IS THE POINT. It closes the quietest inertness hole a
 * source scan has: someone adds a `.cts`, a `.vue` or an `.astro` under a scan
 * root, the scan silently stops covering that file, and the gate stays green
 * while its coverage shrinks. Callers MUST fail on a non-empty `unknown` rather
 * than logging it.
 *
 * @param {ReadonlyArray<string>} files
 * @returns {{ scanned: string[], skipped: string[], unknown: string[] }}
 */
export function partitionByExtension(files) {
	/** @type {{ scanned: string[], skipped: string[], unknown: string[] }} */
	const out = { scanned: [], skipped: [], unknown: [] };
	for (const file of files) {
		const ext = path.extname(file).toLowerCase();
		if (CODE_EXTENSIONS.includes(ext)) out.scanned.push(file);
		else if (NON_CODE_EXTENSIONS.includes(ext)) out.skipped.push(file);
		else out.unknown.push(file);
	}
	return out;
}

/**
 * Remove every comment from JavaScript/TypeScript/JSX source, preserving line
 * count and line positions so a reported line number is true to the file.
 *
 * DELIBERATELY STRONGER than the whole-line stripper the repo's other scans use
 * (`assert-no-node-polyfills.mjs`, `election-shell.test.mjs`). Those drop a line
 * that STARTS with `//`, `*` or `/*`. 54-06's read modules explain D-14, D-19
 * and D-22 in prose, and some of that prose sits on the same line as code; a
 * whole-line stripper would leave those explanations visible to a matcher and
 * report the module's own reasoning as a violation.
 *
 * Removes:
 *   - block comments, including multi-line and the JSX brace-wrapped block form
 *   - whole-line `//` comments
 *   - TRAILING `//` comments that follow code on the same line
 *
 * Preserves: a `//` sequence inside a string literal. `https://…` inside a
 * quoted string is the case that actually occurs, and truncating there would
 * delete real code. The line scanner therefore tracks single-quote,
 * double-quote and backtick state with backslash escaping.
 *
 * ACCEPTED LIMITATION, stated so nobody discovers it as a surprise: string state
 * is LINE-LOCAL. A template literal that spans lines is scanned as ordinary code
 * on its continuation lines, so a `//` sequence inside a multi-line template
 * WOULD be stripped. This is accepted because SQL templates contain no `//`, and
 * 54-08's Task 1 planted-violation control plants its violation INSIDE a
 * multi-line template precisely to prove the stripper does not swallow real
 * template content. A regex literal containing `//` is the same accepted class.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
	/** @type {string[]} */
	const out = [];
	let inBlock = false;
	for (const line of source.split('\n')) {
		let buf = '';
		let i = 0;
		/** @type {string | null} */
		let quote = null;
		while (i < line.length) {
			const c = line[i];
			const c2 = i + 1 < line.length ? line[i + 1] : '';
			if (inBlock) {
				if (c === '*' && c2 === '/') {
					inBlock = false;
					i += 2;
					continue;
				}
				i += 1;
				continue;
			}
			if (quote !== null) {
				if (c === '\\') {
					buf += c + c2;
					i += 2;
					continue;
				}
				if (c === quote) {
					quote = null;
					buf += c;
					i += 1;
					continue;
				}
				buf += c;
				i += 1;
				continue;
			}
			if (c === '/' && c2 === '*') {
				inBlock = true;
				i += 2;
				continue;
			}
			if (c === '/' && c2 === '/') break; // rest of the line is a comment
			if (c === "'" || c === '"' || c === '`') {
				quote = c;
				buf += c;
				i += 1;
				continue;
			}
			buf += c;
			i += 1;
		}
		out.push(buf);
	}
	return out.join('\n');
}

/**
 * Every file under `root`, recursively, as absolute paths, sorted for a
 * deterministic report. Skips `node_modules`, `dist`, `dist-gate`, any
 * `dist-mutant-*` and `.git`.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function walkSourceFiles(root) {
	/** @type {string[]} */
	const found = [];
	/** @param {string} dir */
	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (SKIP_DIRS.includes(entry.name) || entry.name.startsWith('dist-mutant-')) continue;
				walk(path.join(dir, entry.name));
			} else if (entry.isFile()) {
				found.push(path.join(dir, entry.name));
			}
		}
	}
	if (!statSync(root).isDirectory()) throw new Error(`walkSourceFiles: not a directory: ${root}`);
	walk(root);
	return found.sort();
}

/** Static `import … from 'x'` and bare side-effect `import 'x'`. */
const STATIC_IMPORT_RE = /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
/** `export … from 'x'` including `export * from 'x'`. */
const EXPORT_FROM_RE = /\bexport\s+(?:type\s+)?[^'";]*?\s+from\s+['"]([^'"]+)['"]/g;
/** `import('x')` with a single string-literal argument. */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
/** `import(` whose argument does NOT begin with a quote — a computed specifier. */
const DYNAMIC_COMPUTED_RE = /\bimport\s*\(\s*(?!['"])[^)]/g;
/** `require('x')`. */
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Every module specifier a file declares, read from COMMENT-STRIPPED source.
 *
 * A computed dynamic import — an `import(` whose argument is not a single string
 * literal — is returned as `{ specifier: null, kind: 'dynamic-computed' }`.
 * Callers must treat that as a FAILURE TO ANALYSE, not as an absence: a gate
 * that silently ignores what it cannot parse is the inert kind, and a computed
 * specifier is exactly the laundering route a boundary rule exists to forbid.
 *
 * @param {string} source - raw source; this function strips comments itself.
 * @returns {Array<{ specifier: string | null, kind: string }>}
 */
export function moduleSpecifiersOf(source) {
	const code = stripComments(source);
	/** @type {Array<{ specifier: string | null, kind: string }>} */
	const found = [];
	/** @param {RegExp} re @param {string} kind */
	const collect = (re, kind) => {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(code)) !== null) found.push({ specifier: m[1], kind });
	};
	collect(STATIC_IMPORT_RE, 'static');
	collect(EXPORT_FROM_RE, 'export-from');
	collect(DYNAMIC_IMPORT_RE, 'dynamic');
	collect(REQUIRE_RE, 'require');
	DYNAMIC_COMPUTED_RE.lastIndex = 0;
	while (DYNAMIC_COMPUTED_RE.exec(code) !== null) found.push({ specifier: null, kind: 'dynamic-computed' });
	return found;
}

/**
 * Split a statement's select list into items, on commas at PARENTHESIS DEPTH 0,
 * so `count(*)` and any function call with arguments survives as one item.
 *
 * Reuses `selectListOf` from `src/classification.js` rather than reimplementing
 * it: one parser, one failure mode. `selectListOf` fails CLOSED (it throws
 * `UnparseableSelectError`), and this function inherits that.
 *
 * @param {string} sql
 * @param {(sql: string) => string} selectListOf - the shipped parser, injected so
 *   this module stays free of a `src/` import.
 * @returns {string[]}
 */
export function selectItemsOf(sql, selectListOf) {
	const list = selectListOf(sql);
	/** @type {string[]} */
	const items = [];
	let depth = 0;
	let buf = '';
	for (const c of list) {
		if (c === '(') depth += 1;
		else if (c === ')') depth -= 1;
		if (c === ',' && depth === 0) {
			items.push(buf.trim());
			buf = '';
			continue;
		}
		buf += c;
	}
	if (buf.trim().length > 0) items.push(buf.trim());
	const nonEmpty = items.filter((i) => i.length > 0);
	if (nonEmpty.length === 0) throw new Error(`selectItemsOf: empty select list parsed from: ${sql.slice(0, 80)}`);
	return nonEmpty;
}

/** Words that put the token after them in a SQL table position. */
const SQL_TABLE_KEYWORDS = Object.freeze(['from', 'join', 'into', 'update']);

/**
 * Walk `roots`, fail on any unrecognised extension, strip comments, and report
 * every occurrence of every name in `names` as a whole word.
 *
 * THE MATCHER IS THE BARE NAME, NOT A SQL-CONTEXT MATCHER, AND THAT IS
 * DELIBERATE. D-05's wording talks about `FROM`/`JOIN`/`INTO`/`UPDATE`; the bare
 * whole-word rule strictly SUBSUMES that wording, and the scan roots are small
 * enough (single-digit file counts) to afford the stricter rule. `sqlContext` is
 * DIAGNOSTIC ENRICHMENT ONLY — a reader of a failure wants to know whether the
 * hit was a query or a stray identifier. The gate fails on ANY occurrence. Do
 * not "restore" the weaker FROM/JOIN-only matcher: a forbidden table name
 * reaching the public source set as a bare identifier is the same leak by a
 * different spelling.
 *
 * @param {{ roots: ReadonlyArray<string>, names: ReadonlyArray<string> }} args
 * @returns {Array<{ file: string, name: string, line: number, text: string, sqlContext: boolean }>}
 */
export function scanForNames({ roots, names }) {
	/** @type {Array<{ file: string, name: string, line: number, text: string, sqlContext: boolean }>} */
	const offenders = [];
	/** @type {string[]} */
	const unknown = [];
	/** @type {string[]} */
	const toScan = [];
	for (const root of roots) {
		const part = partitionByExtension(walkSourceFiles(root));
		unknown.push(...part.unknown);
		toScan.push(...part.scanned);
	}
	if (unknown.length > 0) throw new UnknownExtensionError(unknown);

	const matchers = names.map((name) => /** @type {const} */ ([name, new RegExp(`\\b${name}\\b`)]));
	for (const file of toScan) {
		const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
		for (let i = 0; i < lines.length; i += 1) {
			const text = lines[i];
			if (text.length === 0) continue;
			for (const [name, re] of matchers) {
				if (!re.test(text)) continue;
				const before = text.slice(0, text.search(re)).toLowerCase();
				const sqlContext = SQL_TABLE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\s+$`).test(before));
				offenders.push({ file, name, line: i + 1, text: text.trim(), sqlContext });
			}
		}
	}
	return offenders;
}

/**
 * Same matcher as `scanForNames`, applied to an in-memory string. The controls
 * use this so a matcher fixture and the real scan cannot diverge.
 *
 * @param {string} source
 * @param {ReadonlyArray<string>} names
 * @returns {Array<{ name: string, line: number, text: string, sqlContext: boolean }>}
 */
export function scanSourceForNames(source, names) {
	/** @type {Array<{ name: string, line: number, text: string, sqlContext: boolean }>} */
	const hits = [];
	const lines = stripComments(source).split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		const text = lines[i];
		for (const name of names) {
			const re = new RegExp(`\\b${name}\\b`);
			if (!re.test(text)) continue;
			const before = text.slice(0, text.search(re)).toLowerCase();
			const sqlContext = SQL_TABLE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\s+$`).test(before));
			hits.push({ name, line: i + 1, text: text.trim(), sqlContext });
		}
	}
	return hits;
}

/**
 * Strip `--` line comments from SQL, respecting single-quoted string literals so
 * a `--` inside a literal is preserved. Line count is preserved.
 *
 * @param {string} sql
 * @returns {string}
 */
export function stripSqlComments(sql) {
	/** @type {string[]} */
	const out = [];
	for (const line of sql.split('\n')) {
		let buf = '';
		let i = 0;
		let inString = false;
		while (i < line.length) {
			const c = line[i];
			const c2 = i + 1 < line.length ? line[i + 1] : '';
			if (inString) {
				buf += c;
				if (c === "'") inString = false;
				i += 1;
				continue;
			}
			if (c === "'") {
				inString = true;
				buf += c;
				i += 1;
				continue;
			}
			if (c === '-' && c2 === '-') break;
			buf += c;
			i += 1;
		}
		out.push(buf);
	}
	return out.join('\n');
}
