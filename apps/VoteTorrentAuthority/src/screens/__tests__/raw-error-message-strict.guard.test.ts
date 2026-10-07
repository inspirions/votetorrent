/**
 * Strict guard: the approval, invitation, ballot, election and add-network screens never render
 * a caught error's message, with no allowance for a fallback after a helper (the wider guard in
 * raw-error-message-guard.test.ts permits those; these files do not use them).
 *
 * Every pattern is assembled from pieces so this file cannot match itself (checked by G-3).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..', '..');

/** Files held to the strict rule, relative to src. */
export const STRICT_FILES: readonly string[] = [
	'screens/registration/RegistrationRequestApprovalScreen.tsx',
	'screens/admin/AdministratorInvitationScreen.tsx',
	'screens/authorities/AuthorityInvitationScreen.tsx',
	'screens/keyholder/KeyholderInvitationScreen.tsx',
	'screens/ballots/EditBallotScreen.tsx',
	'screens/elections/ElectionDetailsScreen.tsx',
	'screens/networks/AddNetworkScreen.tsx',
];

const CAUGHT = '(?:err|error|e|cause)';
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
	{ name: 'error-or-string ternary', re: new RegExp(['instanceof Error', ' \\? ', '[A-Za-z_.]+', '\\.mess', 'age'].join('')) },
	{ name: 'String() of a caught error in a setter', re: new RegExp(['\\bset[A-Za-z]*\\(.*', 'Str', 'ing\\(', CAUGHT, '\\)'].join('')) },
	{ name: 'message of a caught error in a setter', re: new RegExp(['\\bset[A-Za-z]*\\(.*\\b', CAUGHT, '\\.mess', 'age'].join('')) },
	{ name: 'request id in a template literal', re: new RegExp(['`.*request', 'Id', '='].join('')) },
];

/** Allowed: the signing-error hook's own already-translated outcome. */
const ALLOWED = ['out', 'come.mess', 'age'].join('');

function isComment(trimmed: string): boolean {
	return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

export function scanSource(source: string): string[] {
	const hits: string[] = [];
	for (const [i, line] of source.split('\n').entries()) {
		const t = line.trim();
		if (isComment(t)) continue;
		const probe = t.split(ALLOWED).join('');
		for (const p of PATTERNS) if (p.re.test(probe)) hits.push(`${i + 1}: [${p.name}] ${t}`);
	}
	return hits;
}

describe('strict raw error message guard', () => {
	it('G-1 no strict file renders an error message', () => {
		const violations: string[] = [];
		for (const rel of STRICT_FILES) {
			const abs = path.join(SRC, rel);
			expect(fs.existsSync(abs)).toBe(true);
			for (const h of scanSource(fs.readFileSync(abs, 'utf8'))) {
				violations.push(`${rel}:${h}`);
			}
		}
		expect(violations).toEqual([]);
	});

	it('G-2 the scan fails on a re-added raw render (negative control, scratch copy)', () => {
		const original = fs.readFileSync(path.join(SRC, STRICT_FILES[1]), 'utf8');
		const bad = ['setErrorMessage(err instanceof Error ? err.mess', 'age : Str', 'ing(err));'].join('');
		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-guard-'));
		const scratch = path.join(scratchDir, 'Scratch.tsx');
		try {
			fs.writeFileSync(scratch, original + '\n' + bad + '\n');
			expect(scanSource(fs.readFileSync(scratch, 'utf8')).length).toBeGreaterThan(0);
			fs.writeFileSync(scratch, original + '\nsetErrorMessage(' + ['out', 'come.mess', 'age'].join('') + ' ?? t("x"));\n');
			expect(scanSource(fs.readFileSync(scratch, 'utf8'))).toEqual([]);
		} finally {
			fs.rmSync(scratchDir, { recursive: true, force: true });
		}
	});

	it('G-3 the guard source itself matches nothing', () => {
		expect(scanSource(fs.readFileSync(__filename, 'utf8'))).toEqual([]);
	});
});
