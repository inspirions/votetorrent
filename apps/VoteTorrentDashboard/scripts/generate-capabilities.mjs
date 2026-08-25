#!/usr/bin/env node
/**
 * generate-capabilities.mjs — mechanically derives the dashboard's capability
 * matrix from `packages/vote-core/schema/votetorrent.qsql`, the sole authority
 * on what scopes exist and where they are enforced.
 *
 * Ported from `.planning/spikes/077-scope-capability-matrix/extract-matrix.mjs`
 * (the `.Scope = '<code>'` site matcher, the backwards constraint-name walk,
 * the `check on insert, update` ops parser, and the `view Scope as(...);`
 * closed-set read). The markdown-printing tail is discarded; this file emits
 * `src/auth/capabilities.js` instead.
 *
 * Two exports plus a CLI tail:
 *   - `extractFromSchema(schemaText)` — the ported extraction logic.
 *   - `generateSource(schemaText)` — merges the extraction with the
 *     PRESENTATION map (below) and returns the complete text of
 *     `src/auth/capabilities.js`.
 *
 * `generateSource` THROWS, naming the code, if the schema declares a scope
 * absent from PRESENTATION, or PRESENTATION names a scope absent from the
 * schema. That is the generation-time half of "a tenth scope fails loudly";
 * `test/node/capabilities.test.mjs`'s staleness check is the commit-time half.
 *
 * Run: `node scripts/generate-capabilities.mjs` (or
 * `yarn workspace votetorrent-dashboard capabilities:generate`) from anywhere
 * — the schema path is resolved from `import.meta.url`, never cwd.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Three levels up from scripts/ (apps/VoteTorrentDashboard/scripts ->
// apps/VoteTorrentDashboard -> apps -> repo root) — never a bare relative
// path that would depend on the caller's cwd.
export const SCHEMA_PATH = path.resolve(
	SCRIPT_DIR,
	'..',
	'..',
	'..',
	'packages',
	'vote-core',
	'schema',
	'votetorrent.qsql',
);
export const OUTPUT_PATH = path.resolve(SCRIPT_DIR, '..', 'src', 'auth', 'capabilities.js');

/**
 * The presentation metadata the schema cannot supply: `id` (the binding
 * CapabilityId, contract C5), `icon` (UI-SPEC glyph), `group` (nav grouping)
 * and `order` (binding sidebar order, registrations first — 'vrg' is 39% of
 * the authorization surface).
 *
 * @type {Record<string, { id: string, icon: string, group: 'electionOperations' | 'authorityAdministration', order: number }>}
 */
export const PRESENTATION = {
	vrg: { id: 'registrations', icon: '👥', group: 'electionOperations', order: 1 },
	mel: { id: 'elections', icon: '🗳', group: 'electionOperations', order: 2 },
	ceb: { id: 'ballotsQuestions', icon: '📋', group: 'electionOperations', order: 3 },
	rn: { id: 'networkSettings', icon: '🌐', group: 'authorityAdministration', order: 4 },
	uai: { id: 'authorityProfile', icon: '🏛', group: 'authorityAdministration', order: 5 },
	cap: { id: 'authorityPeers', icon: '🖧', group: 'authorityAdministration', order: 6 },
	rad: { id: 'administrationOfficers', icon: '⚖️', group: 'authorityAdministration', order: 7 },
	ik: { id: 'keyholders', icon: '🔑', group: 'authorityAdministration', order: 8 },
	iad: { id: 'inviteAuthorities', icon: '🤝', group: 'authorityAdministration', order: 9 },
};

/**
 * `rad`'s enforcement count is a known undercount: its real site uses
 * `json_each(O.Scopes) ... value = 'rad'` inside `Admin.OfficerRequired`
 * (votetorrent.qsql), an idiom the `.Scope = '<code>'` extractor below cannot
 * see. Recorded as data so nobody later "corrects" the number without reading
 * this note. Never rendered as UI copy — developer-facing only.
 *
 * @type {Record<string, string>}
 */
const SITE_COUNT_CAVEAT = {
	rad: "This site count reflects only the `AdminSigning.Scope = 'rad'` idiom this generator's `.Scope = '<code>'` pattern can match. The real enforcement site for 'rad' uses a different idiom, `json_each(O.Scopes) where value = 'rad'` inside `Admin.OfficerRequired`, which this extractor cannot see. Treat this number as an undercount, not the true site count.",
};

/**
 * Ported spike-077 extraction: walk the schema text line by line, tracking
 * the enclosing table/assertion/view, matching `.Scope = '<code>'` sites,
 * walking backwards to the enclosing `constraint <name> check` name, parsing
 * the `check on insert, update (...)` ops list, and reading the closed scope
 * set declared by `view Scope as ... ;`.
 *
 * @param {string} schemaText
 * @returns {{ declared: { code: string, name: string }[], sitesByScope: Map<string, { table: string, constraint: string | null, ops: string[] }[]> }}
 */
export function extractFromSchema(schemaText) {
	const lines = schemaText.split('\n');

	/** @type {{ table: string, line: number, scope: string, constraint: string | null, ops: string[] }[]} */
	const sites = [];
	/** @type {string | null} */
	let cur = null;
	lines.forEach((l, i) => {
		const m = l.match(/^\t(table|assertion|view)\s+(\w+)/);
		if (m) cur = m[2];
		for (const x of l.matchAll(/\.Scope\s*=\s*'([a-z]+)'/g)) {
			if (cur) sites.push({ table: cur, line: i + 1, scope: x[1], constraint: null, ops: [] });
		}
	});

	// Attach the enclosing constraint name by walking backwards.
	for (const s of sites) {
		for (let j = s.line - 1; j >= 0; j--) {
			const c = lines[j].match(/constraint\s+(\w+)\s+check/);
			if (c) {
				s.constraint = c[1];
				break;
			}
			if (/^\t(table|assertion)\s/.test(lines[j])) break;
		}
	}

	// Which ops does each constraint govern? `check on insert, update` etc.
	/** @param {number} line @returns {string[]} */
	const opsFor = (line) => {
		for (let j = line - 1; j >= 0; j--) {
			const c = lines[j].match(/constraint\s+\w+\s+check(\s+on\s+([a-z,\s]+?))?\s*\(/);
			if (c) {
				return (c[2] ?? 'insert, update, delete')
					.split(',')
					.map((t) => t.trim())
					.filter(Boolean);
			}
			if (/^\t(table|assertion)\s/.test(lines[j])) break;
		}
		return [];
	};
	for (const s of sites) s.ops = opsFor(s.line);

	// The closed scope set, read from `view Scope`.
	const viewMatch = schemaText.match(/view Scope as([\s\S]*?);/);
	if (!viewMatch) {
		throw new Error('extractFromSchema: could not find "view Scope as ... ;" in the schema text');
	}
	const viewBlock = viewMatch[1];
	const declared = [...viewBlock.matchAll(/select '([a-z]+)' as Code, '([^']+)' as Name/g)].map(
		(m) => ({ code: m[1], name: m[2] }),
	);

	/** @type {Map<string, { table: string, constraint: string | null, ops: string[] }[]>} */
	const sitesByScope = new Map(declared.map((d) => [d.code, []]));
	for (const s of sites) {
		if (!sitesByScope.has(s.scope)) sitesByScope.set(s.scope, []);
		sitesByScope.get(s.scope)?.push({ table: s.table, constraint: s.constraint, ops: s.ops });
	}

	return { declared, sitesByScope };
}

/** @param {string} str @returns {string} */
function esc(str) {
	return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * @param {{ id: string, scope: string, schemaName: string, tier: 1 | 2, sites: number, tables: string[], siteCountCaveat: string | null, icon: string, group: string, order: number, titleKey: string, emptyKey: string }} c
 * @returns {string}
 */
function renderEntry(c) {
	const tablesLiteral =
		c.tables.length === 0 ? '[]' : `[${c.tables.map((t) => `'${esc(t)}'`).join(', ')}]`;
	const caveatLiteral = c.siteCountCaveat === null ? 'null' : `'${esc(c.siteCountCaveat)}'`;
	return (
		`\tObject.freeze({\n` +
		`\t\tid: '${c.id}',\n` +
		`\t\tscope: '${c.scope}',\n` +
		`\t\tschemaName: '${esc(c.schemaName)}',\n` +
		`\t\ttier: ${c.tier},\n` +
		`\t\tsites: ${c.sites},\n` +
		`\t\ttables: ${tablesLiteral},\n` +
		`\t\tsiteCountCaveat: ${caveatLiteral},\n` +
		`\t\ticon: '${c.icon}',\n` +
		`\t\tgroup: '${c.group}',\n` +
		`\t\torder: ${c.order},\n` +
		`\t\ttitleKey: '${c.titleKey}',\n` +
		`\t\temptyKey: '${c.emptyKey}',\n` +
		`\t})`
	);
}

/**
 * Merge the schema extraction with `PRESENTATION` and return the complete
 * text of `src/auth/capabilities.js`. Throws, naming the code, on any
 * mismatch between the schema's declared scope set and `PRESENTATION`'s keys.
 *
 * @param {string} schemaText
 * @returns {string}
 */
export function generateSource(schemaText) {
	const { declared, sitesByScope } = extractFromSchema(schemaText);

	const declaredCodes = new Set(declared.map((d) => d.code));
	const presentationCodes = new Set(Object.keys(PRESENTATION));

	for (const code of declaredCodes) {
		if (!presentationCodes.has(code)) {
			throw new Error(
				`generateSource: schema declares scope '${code}' with no entry in the PRESENTATION map — add one to scripts/generate-capabilities.mjs before regenerating`,
			);
		}
	}
	for (const code of presentationCodes) {
		if (!declaredCodes.has(code)) {
			throw new Error(
				`generateSource: the PRESENTATION map names scope '${code}', which the schema's view Scope no longer declares — remove it from scripts/generate-capabilities.mjs before regenerating`,
			);
		}
	}

	const declaredByCode = new Map(declared.map((d) => [d.code, d]));

	const capabilities = declared
		.map((d) => {
			const pres = PRESENTATION[d.code];
			const sites = sitesByScope.get(d.code) ?? [];
			const tables = [...new Set(sites.map((s) => s.table))].sort();
			return {
				id: pres.id,
				scope: d.code,
				schemaName: declaredByCode.get(d.code)?.name ?? '',
				tier: /** @type {1 | 2} */ (sites.length > 0 ? 1 : 2),
				sites: sites.length,
				tables,
				siteCountCaveat: SITE_COUNT_CAVEAT[d.code] ?? null,
				icon: pres.icon,
				group: pres.group,
				order: pres.order,
				titleKey: `panels.${pres.id}.title`,
				emptyKey: `panels.${pres.id}.empty`,
			};
		})
		.sort((a, b) => a.order - b.order);

	const scopeCodeUnion = declared.map((d) => `'${d.code}'`).join('|');
	const capabilityIdUnion = capabilities.map((c) => `'${c.id}'`).join('|');
	const scopeCodesArray = declared.map((d) => `\t'${d.code}',`).join('\n');
	const capabilitiesBody = capabilities.map(renderEntry).join(',\n');

	return `/**
 * AUTO-GENERATED by scripts/generate-capabilities.mjs from
 * packages/vote-core/schema/votetorrent.qsql — do not hand-edit. Run
 * \`yarn workspace votetorrent-dashboard capabilities:generate\` after any
 * change to \`view Scope\` or a \`.Scope = '<code>'\` enforcement site, then
 * commit the result. test/node/capabilities.test.mjs's staleness check fails
 * the build if this file ever drifts from a fresh generation.
 *
 * \`tier\` is derived, not typed: \`sites > 0 ? 1 : 2\`. Tier 2 means the scope
 * has ZERO schema enforcement sites and is checked entirely in TypeScript by
 * \`context.Is*Valid\` booleans inside authority-engine.ts — a client that
 * talks to the raw Quereus Database handle instead of going through
 * vote-engine loses that enforcement silently. 'keyholders' ('ik') and
 * 'inviteAuthorities' ('iad') are the two tier-2 capabilities below.
 */

/** @typedef {${scopeCodeUnion}} ScopeCode */

/** @typedef {${capabilityIdUnion}} CapabilityId */

/**
 * @typedef {object} Capability
 * @property {CapabilityId} id
 * @property {ScopeCode} scope
 * @property {string} schemaName
 * @property {1 | 2} tier
 * @property {number} sites
 * @property {string[]} tables
 * @property {string | null} siteCountCaveat
 * @property {string} icon
 * @property {'electionOperations' | 'authorityAdministration'} group
 * @property {number} order
 * @property {string} titleKey
 * @property {string} emptyKey
 */

/** @type {ReadonlyArray<Capability>} */
export const CAPABILITIES = Object.freeze([
${capabilitiesBody}
]);

/**
 * @typedef {object} PanelGroup
 * @property {'electionOperations' | 'authorityAdministration'} id
 * @property {string} titleKey
 */

/** @type {ReadonlyArray<PanelGroup>} */
export const PANEL_GROUPS = Object.freeze([
	Object.freeze({ id: 'electionOperations', titleKey: 'nav.groupElectionOperations' }),
	Object.freeze({ id: 'authorityAdministration', titleKey: 'nav.groupAuthorityAdministration' }),
]);

/** @type {ReadonlyArray<ScopeCode>} */
export const SCOPE_CODES = Object.freeze([
${scopeCodesArray}
]);
`;
}

// CLI tail — write src/auth/capabilities.js from the live schema.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const schemaText = readFileSync(SCHEMA_PATH, 'utf8');
	const source = generateSource(schemaText);
	writeFileSync(OUTPUT_PATH, source, 'utf8');
	process.stdout.write(`[generate-capabilities] wrote ${OUTPUT_PATH}\n`);
}
