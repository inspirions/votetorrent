/**
 * no-qr-affordance.test.mjs — the D-03 automated-absence gate.
 *
 * D-03: "Sign-in is by a code the authority app hands over. QR-based login is
 * later." Until this test existed, that absence was asserted ONLY in a source
 * comment (`DashboardSignInCodeScreen.tsx:5-6`) -- nothing failed if someone
 * added a QR/camera affordance. This scans the two real sign-in surfaces:
 *
 *   1. `apps/VoteTorrentDashboard/src/screens/Bootstrap.tsx` -- the dashboard's
 *      own code-entry screen.
 *   2. Every `.tsx` file directly under
 *      `apps/VoteTorrentAuthority/src/screens/dashboard/` (excluding its own
 *      `__tests__/`) -- the producer-side dashboard screens, currently just
 *      `DashboardSignInCodeScreen.tsx`.
 *
 * SELF-TRIPPING TRAP: `DashboardSignInCodeScreen.tsx`'s own header comment
 * (lines 5-6) names "QR" and "camera" verbatim, documenting the absence this
 * test now enforces. A naive scan of the raw source would fail on its own
 * documentation. Comments are stripped FIRST, using the exact `stripComments`
 * idiom already established by `preview-scopes.test.mjs` / `lint-copy.mjs` /
 * `assert-no-node-polyfills.mjs`, so prose ABOUT the absence is never read as
 * a violation of it.
 *
 * Runs its own positive control FIRST (house style shared with
 * `scripts/lint-copy.mjs` and `scripts/assert-no-node-polyfills.mjs`): a
 * matcher that cannot detect a planted QR/camera sentinel proves nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = path.resolve(__dirname, '..', '..');
const AUTHORITY_DASHBOARD_DIR = path.resolve(DASHBOARD_ROOT, '..', 'VoteTorrentAuthority', 'src', 'screens', 'dashboard');

/** Same idiom as `preview-scopes.test.mjs` / `lint-copy.mjs` /
 * `assert-no-node-polyfills.mjs` -- drop whole-line comments so prose ABOUT a
 * banned affordance is never read as the affordance itself.
 * @param {string} source @returns {string} */
function stripComments(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

/** Any QR/camera/barcode affordance -- an import of a known camera/scanner
 * package, a component name, a permission call, or the bare words
 * "QR code" / "barcode" / "camera" themselves (case-insensitive; these
 * screens have no legitimate reason to mention any of them outside prose). */
const QR_CAMERA_AFFORDANCE_RE =
	/\b(qr[\s-]?code|qrcode|bar[\s-]?code|camera|expo-camera|expo-barcode-scanner|react-native-camera|react-native-vision-camera|BarCodeScanner|CameraView|useCameraDevice|requestCameraPermission)\b/i;

// ---------------------------------------------------------------------------
// 1. Positive control -- the matcher must be able to detect a planted
//    affordance BEFORE it is trusted to scan real files.
// ---------------------------------------------------------------------------
const SENTINEL_FIXTURES = [
	'import { CameraView } from "expo-camera";',
	'import BarCodeScanner from "expo-barcode-scanner";',
	'const perm = await requestCameraPermission();',
	'<button onClick={openQrScanner}>Scan QR code</button>',
];

test('positive control: the QR/camera matcher fires on a planted sentinel', () => {
	for (const fixture of SENTINEL_FIXTURES) {
		assert.match(fixture, QR_CAMERA_AFFORDANCE_RE, `matcher is inert against: ${fixture}`);
	}
});

test('inertness control: the matcher does not fire on ordinary code that mentions neither word', () => {
	const benign = [
		'const [pastedCode, setPastedCode] = useState("");',
		'await handleSubmit(pastedCode);',
		'return <input type="text" value={pastedCode} onChange={onChange} />;',
	].join('\n');
	assert.doesNotMatch(benign, QR_CAMERA_AFFORDANCE_RE, 'matcher is indiscriminate');
});

// ---------------------------------------------------------------------------
// 2. The self-tripping trap, proven explicitly: the RAW (un-stripped) source
//    of DashboardSignInCodeScreen.tsx DOES match (it names "QR" and "camera"
//    in its own header comment) -- and after stripComments(), it does not.
//    This is the exact discipline the gap calls out: a check that cannot
//    fail is worth nothing, and a check that trips on its own documentation
//    is worse than no check.
// ---------------------------------------------------------------------------
const SIGN_IN_CODE_SCREEN_PATH = path.join(AUTHORITY_DASHBOARD_DIR, 'DashboardSignInCodeScreen.tsx');
const SIGN_IN_CODE_SCREEN_RAW = readFileSync(SIGN_IN_CODE_SCREEN_PATH, 'utf8');

test('the self-tripping trap: the raw source DOES mention QR/camera (in its own D-03 comment)', () => {
	assert.match(
		SIGN_IN_CODE_SCREEN_RAW,
		QR_CAMERA_AFFORDANCE_RE,
		'expected the raw source to contain its own documented D-03 comment naming QR/camera',
	);
});

test('...but the comment-stripped source does not -- comments must be dropped before scanning', () => {
	assert.doesNotMatch(
		stripComments(SIGN_IN_CODE_SCREEN_RAW),
		QR_CAMERA_AFFORDANCE_RE,
		'the D-03 documentation comment leaked past stripComments()',
	);
});

// ---------------------------------------------------------------------------
// 3. The real gate: scan both sign-in surfaces, comments stripped, and fail
//    if a QR/camera/barcode affordance appears anywhere in the actual code.
// ---------------------------------------------------------------------------
const BOOTSTRAP_SCREEN_PATH = path.join(DASHBOARD_ROOT, 'src', 'screens', 'Bootstrap.tsx');

/** @returns {Array<{ name: string; path: string; source: string }>} */
function collectSignInSurfaceFiles() {
	/** @type {Array<{ name: string; path: string; source: string }>} */
	const files = [{ name: 'Bootstrap.tsx (dashboard)', path: BOOTSTRAP_SCREEN_PATH, source: readFileSync(BOOTSTRAP_SCREEN_PATH, 'utf8') }];

	for (const entry of readdirSync(AUTHORITY_DASHBOARD_DIR, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.tsx')) continue;
		const full = path.join(AUTHORITY_DASHBOARD_DIR, entry.name);
		files.push({ name: `${entry.name} (authority dashboard)`, path: full, source: readFileSync(full, 'utf8') });
	}
	return files;
}

test('neither the dashboard sign-in surface nor any authority dashboard screen carries a QR/camera/barcode affordance (D-03)', () => {
	const files = collectSignInSurfaceFiles();
	assert.ok(files.length >= 2, `expected at least 2 sign-in surface files, found ${files.length}`);

	const offenders = files
		.map((f) => ({ ...f, stripped: stripComments(f.source) }))
		.filter((f) => QR_CAMERA_AFFORDANCE_RE.test(f.stripped))
		.map((f) => f.name);

	assert.deepEqual(
		offenders,
		[],
		`these sign-in surface files carry a QR/camera/barcode affordance in real code (not a comment): ${offenders.join(', ')}`,
	);
});
