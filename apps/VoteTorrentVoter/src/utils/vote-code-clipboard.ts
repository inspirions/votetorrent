/**
 * @format
 *
 * vote-code-clipboard.ts: the app's ONLY reference to the clipboard package.
 *
 * D-17: a vote code is copied only on an explicit tap. The caller shows the warning beside the
 * button, and there is no share sheet.
 *
 * The require is lazy on purpose. The package calls `TurboModuleRegistry.getEnforcing("RNCClipboard")`
 * at module load, and the navigation tree eagerly imports every screen. A top-level import would
 * red-box app start on any binary without the native module (a debug APK built before it was
 * linked, or an iOS build before `pod install`). With the lazy require only the copy action
 * fails, and it fails gracefully.
 */

export type VoteCodeCopyResult = 'copied' | 'unavailable';

const VOTE_CODE_RE = /^[0-9a-f]{64}$/;

export function copyVoteCode(nonce: string): VoteCodeCopyResult {
	if (typeof nonce !== 'string' || !VOTE_CODE_RE.test(nonce)) {
		throw new TypeError('vote code must be 64 lowercase hex characters');
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const clipboard = require('@react-native-clipboard/clipboard') as {
			default: {setString(content: string): void};
		};
		clipboard.default.setString(nonce);
		return 'copied';
	} catch {
		return 'unavailable';
	}
}
