/**
 * WR-10 (Phase 47 review): the committed-secret guard on
 * `attestation-keys.generated.ts`.
 *
 * SETUP.md used to tell an operator to base64-encode the Play Console
 * response-encryption and response-verification keys and put them into
 * `apps/VoteTorrentAuthority/src/engines/attestation-keys.generated.ts` — a
 * GIT-TRACKED file — while also saying "NEVER commit the real key values into
 * git". That combination is a known-bad secret-handling shape: a tracked file,
 * edited in place with a real symmetric decryption key, protected by nothing
 * but operator discipline.
 *
 * This project's own history says that discipline fails. `proof-flags.generated.ts`
 * (the very file SETUP.md cited as the pattern to follow) regularly shows up
 * modified in `git status` whenever a run script's EXIT trap does not fire.
 * The same accident here commits a live decryption key.
 *
 * This test is the mechanical control that replaces the discipline: the
 * TRACKED file's key constants must be empty, always. An operator who
 * provisions real keys locally will see this test go red, which is the point —
 * the red test is the signal that the working tree now holds a secret and must
 * not be committed.
 *
 * It reads the file as TEXT rather than importing the constants, so it fails
 * on what is actually on disk (and therefore what `git add` would stage),
 * not on what some build step might have substituted.
 */

import * as fs from 'fs';
import * as path from 'path';

const KEYS_PATH = path.join(__dirname, '../attestation-keys.generated.ts');

/** Every `export const NAME = '...'` string literal in the file, by name. */
function stringConstants(source: string): Record<string, string> {
	const out: Record<string, string> = {};
	const pattern = /export const (\w+)\s*(?::\s*[^=]+)?=\s*'([^']*)'/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source)) !== null) {
		out[match[1]!] = match[2]!;
	}
	return out;
}

describe('WR-10 committed-secret guard: attestation-keys.generated.ts', () => {
	const source = fs.readFileSync(KEYS_PATH, 'utf8');
	const constants = stringConstants(source);

	it('finds the two Play Console key constants (non-vacuity)', () => {
		// If either name disappears, the guard below would pass vacuously.
		expect(Object.keys(constants)).toContain('PLAY_CONSOLE_DECRYPTION_KEY_BASE64');
		expect(Object.keys(constants)).toContain('PLAY_CONSOLE_VERIFICATION_KEY_BASE64');
	});

	it.each(['PLAY_CONSOLE_DECRYPTION_KEY_BASE64', 'PLAY_CONSOLE_VERIFICATION_KEY_BASE64'])(
		'%s is EMPTY in the tracked file — real key material must never be committed',
		(name) => {
			expect(constants[name]).toBe('');
		}
	);

	it('the file carries no base64-looking literal long enough to be a key', () => {
		// Belt-and-suspenders against a real value landing under a DIFFERENT
		// constant name, or being pasted into a comment. A 32-byte AES key is 44
		// base64 characters; the cert digests in this file are 64-char lowercase
		// HEX, which this pattern deliberately does not match (it requires at
		// least one uppercase letter, '+', '/' or '=').
		const suspicious = source.match(/'[A-Za-z0-9+/]*[A-Z+/=][A-Za-z0-9+/]{40,}={0,2}'/g) ?? [];
		expect(suspicious).toEqual([]);
	});
});
