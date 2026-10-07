/**
 * Guard: no Authority screen or component may render a raw engine error text.
 *
 * Scope: src/screens and src/components (non-test). src/engines is out of
 * scope (dev proofs and logging; device-signer's module-resolution error is
 * developer-facing).
 *
 * The scanned pattern is assembled from pieces so this file cannot match it.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..', '..');
const ROOTS = ['screens', 'components'];

const RAW = new RegExp(
	['instanceof Error \\? ', '[A-Za-z_.]+', '\\.message : ', 'String\\('].join(''),
);
const ALLOWED_MARKERS = ['peerUnavailable' + 'Message(', 'outcome.' + 'message ??'];

/** file (relative to src, posix) + trimmed line text -> reason. */
export const EXCEPTIONS: ReadonlyArray<{ file: string; text: string; reason: string }> = [
	{
		file: 'screens/users/DefaultUserScreen.tsx',
		text: 'setErrorMessage(error instanceof Error ? error.message : String(error));',
		reason: 'device-local AsyncStorage save, no engine involved',
	},
	{
		file: 'screens/elections/election-error-messages.ts',
		text: 'const raw = err instanceof Error ? err.message : String(err);',
		reason: 'regex-matched to classify, never rendered',
	},
];

function walk(dir: string, out: string[]): void {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === '__tests__') continue;
			walk(p, out);
		} else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
			out.push(p);
		}
	}
}

export function scan(files: string[], exceptions = EXCEPTIONS) {
	const violations: string[] = [];
	const used = new Set<number>();
	for (const f of files) {
		const rel = path.relative(SRC, f).split(path.sep).join('/');
		for (const [i, line] of fs.readFileSync(f, 'utf8').split('\n').entries()) {
			if (!RAW.test(line)) continue;
			if (ALLOWED_MARKERS.some((m) => line.includes(m))) continue;
			const t = line.trim();
			const idx = exceptions.findIndex((x) => x.file === rel && x.text === t);
			if (idx >= 0) {
				used.add(idx);
				continue;
			}
			violations.push(`${rel}:${i + 1}: ${t}`);
		}
	}
	return { violations, used };
}

function allFiles(): string[] {
	const files: string[] = [];
	for (const r of ROOTS) walk(path.join(SRC, r), files);
	return files;
}

describe('raw error message guard', () => {
	it('scans a non-empty file set', () => {
		expect(allFiles().length).toBeGreaterThan(0);
	});

	it('has no unclassified raw error message site', () => {
		expect(scan(allFiles()).violations).toEqual([]);
	});

	it('has no stale exception', () => {
		const { used } = scan(allFiles());
		const stale = EXCEPTIONS.filter((_, i) => !used.has(i)).map((x) => `${x.file}: ${x.text}`);
		expect(stale).toEqual([]);
		expect(EXCEPTIONS).toHaveLength(3);
		for (const x of EXCEPTIONS) expect(x.reason.length).toBeGreaterThan(0);
	});
});
