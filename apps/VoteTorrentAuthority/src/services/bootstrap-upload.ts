/**
 * bootstrap-upload.ts — the REAL sealed-payload uploader.
 *
 * `mintDashboardSignInCode` takes its uploader INJECTED: it derives the key
 * split, seals the snapshot and hands the wrapper to a
 * `BootstrapSealedUploader`, persisting nothing until that uploader
 * acknowledges. `dashboard-signin-code.ts` therefore holds no base URL, no
 * bearer token and no `fetch` call at all. This module is the production
 * implementation of that injected seam, and the only place in the authority
 * app that performs the encrypted push at mint.
 *
 * THE DEV-ONLY TARGET, AND WHY IT HAS NO DEFAULT.
 * `DEV_BOOTSTRAP_UPLOAD_BASE_URL` and `DEV_BOOTSTRAP_UPLOAD_TOKEN` below both
 * ship strictly `undefined`. A hardcoded default host would turn every build
 * into a live outbound client aimed at whatever address happened to be typed
 * in when the file was last edited — this project has already shipped exactly
 * that once, on a sibling dev constant, and reverted it. So two INDEPENDENT
 * conditions gate every outbound call, and they are deliberately not
 * collapsed into one: `__DEV__` is the BUILD-time condition (a release build
 * sends nothing, whatever the constants say, because the bundler replaces
 * `__DEV__` with a literal `false`), and a configured target is the
 * SESSION-time condition (a dev build with nothing configured also sends
 * nothing). Collapsing them would mean a one-line edit to a constant could
 * re-arm a shipped build.
 *
 * FAIL-CLOSED, BECAUSE THE ALTERNATIVE IS AN UNREDEEMABLE CODE. An
 * unconfigured target, an unreachable service, or any answer that is not the
 * service's acknowledgement produces a VISIBLE refusal that propagates all
 * the way to the officer's screen. It must never degrade into a silent
 * fallback: minting without an uploader takes the filesystem-binding path
 * instead, which persists a payload locally and hands the officer a code no
 * browser can ever redeem. A refusal the officer can read is strictly better
 * than a code that will fail in front of them.
 *
 * THE REASON VOCABULARY IS SERVICE-AUTHORED AND CLOSED. The five members of
 * `BOOTSTRAP_UPLOAD_FAILURE_REASONS` are the only classifications that exist,
 * they are assigned HERE from the response status, and not one of them is
 * ever derived from a response body. The failure reason travels back to the
 * caller on the HANDLE, not on the thrown error: the mint catches an uploader
 * rejection and rethrows a fresh error with a fixed message and deliberately
 * no `cause`, because a `cause` is exactly the vector by which a raw upstream
 * message reaches a log line or a crash report. Reading the reason off the
 * handle keeps that boundary intact.
 *
 * WHAT THIS MODULE MAY LOG: an error CLASS and a closed-set reason token.
 * Never a caught error's message, never a response body, never the URL, and
 * never the operator token. `requestJson` in the browser-side transport keeps
 * the mirror-image rule in the read direction, and for the same reason: the
 * request body here carries an authority's whole database as ciphertext and
 * the header carries an operator credential.
 */

import type { BootstrapSealedUploader, BootstrapUploadRequest } from "./dashboard-signin-code";

// -------------------------------------------------------------------------
// The D-27 dev-time target. NO DEFAULT.
//
// A device-proof session sets these two values before the app cold-starts and
// reverts BOTH to `undefined` before anything is committed; a normal checkout
// leaves them unset and generating a code then refuses visibly rather than
// producing a code that cannot be redeemed. The device leg runs
// `adb reverse tcp:PORT tcp:PORT`, so the value a session sets is a loopback
// origin as seen FROM THE PHONE, not the host's LAN address.
//
// The spec asserts both are strictly `undefined` and that this file contains
// no host literal anywhere in code, so a forgotten revert fails the suite
// rather than shipping.
// -------------------------------------------------------------------------

/** No default — see the block above. */
export const DEV_BOOTSTRAP_UPLOAD_BASE_URL: string | undefined = undefined;

/** No default — see the block above. The operator credential the service was
 * configured with; it is read once into an `authorization` header and appears
 * in no log line, no error message and no response handling. */
export const DEV_BOOTSTRAP_UPLOAD_TOKEN: string | undefined = undefined;

/** The shipped upload route. One route, one method. */
const UPLOAD_PATH = "/bootstrap/uploads";

/** Mirrors the browser-side transport's own default. An upload that hangs
 * would otherwise freeze the ceremony indefinitely, with the officer holding
 * a phone that has already raised a biometric and exported a database. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** The one fixed prefix every log line from this module carries. It names the
 * module and nothing else: no URL, no token, no status line. */
const LOG_PREFIX = "bootstrap-upload: the sealed payload upload was refused;";

/**
 * The closed classification set. Exported as a `const` tuple so the spec, the
 * copy map and this module all assert against the same literals rather than
 * three hand-copied lists that can drift apart.
 */
export const BOOTSTRAP_UPLOAD_FAILURE_REASONS = [
	"not-configured",
	"unauthorized",
	"too-large",
	"refused",
	"unreachable",
] as const;

export type BootstrapUploadFailureReason = (typeof BOOTSTRAP_UPLOAD_FAILURE_REASONS)[number];

/**
 * The rejection this module throws. The `reason` is the ONLY detail that ever
 * leaves here, the message is a fixed prefix plus that same token, and there
 * is deliberately no `cause` — for the identical reason the mint attaches
 * none.
 */
export class BootstrapUploadError extends Error {
	readonly reason: BootstrapUploadFailureReason;

	constructor(reason: BootstrapUploadFailureReason) {
		super(`bootstrap-upload: the upload did not complete (${reason})`);
		this.name = "BootstrapUploadError";
		this.reason = reason;
		// Babel's class transform can lose the prototype chain when extending a
		// built-in; restoring it keeps `instanceof` honest for any future caller.
		Object.setPrototypeOf(this, BootstrapUploadError.prototype);
	}
}

/** The uploader plus its per-attempt classification. */
export interface BootstrapUploadHandle {
	/** Handed to `mintDashboardSignInCode` as its `uploader` option. */
	upload: BootstrapSealedUploader;
	/** The classification of the MOST RECENT attempt on this handle, or
	 * `undefined` if that attempt succeeded or none has been made. */
	lastFailureReason(): BootstrapUploadFailureReason | undefined;
}

/** Overrides exist for the spec only. They CANNOT re-enable a release build:
 * the `__DEV__` check lives inside the upload path itself and is not
 * overridable by anything a caller can pass. */
export interface BootstrapUploadOverrides {
	baseUrl?: string;
	token?: string;
	timeoutMs?: number;
}

function isUsable(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Whether an upload could be attempted at all. The `__DEV__` check runs FIRST
 * and lexically, before either constant is read: the build-time condition and
 * the session-time condition are independent, and a shipped build must answer
 * `false` here regardless of what any constant holds.
 *
 * The screen calls this BEFORE the ceremony so an officer never spends a
 * biometric and a whole-database export on an attempt that provably cannot
 * succeed. The upload path keeps its own identical refusal as the second
 * layer — the screen is a courtesy, not the enforcement point.
 */
export function isBootstrapUploadConfigured(overrides?: BootstrapUploadOverrides): boolean {
	if (!__DEV__) return false;
	const baseUrl = overrides?.baseUrl ?? DEV_BOOTSTRAP_UPLOAD_BASE_URL;
	const token = overrides?.token ?? DEV_BOOTSTRAP_UPLOAD_TOKEN;
	return isUsable(baseUrl) && isUsable(token);
}

/**
 * The reason-to-copy-key map. Returns i18n KEYS, never sentences — that is
 * what keeps every officer-facing string in the translation table where the
 * copy assertions can see it, in both languages.
 *
 * The switch is exhaustive with no `default` branch, so widening the reason
 * union without adding a key is a compile error rather than a silently
 * swallowed value.
 *
 * `refused` and `unreachable` share the generic upload key ON PURPOSE: from
 * the officer's side the two are the same situation — no new code was
 * created, check the sign-in service is running and try again. The three
 * reasons whose remedies genuinely differ each get their own copy.
 */
export function uploadFailureCopyKey(reason: BootstrapUploadFailureReason): string {
	switch (reason) {
		case "not-configured":
			return "dashboardSignInCodeUploadNotConfigured";
		case "unauthorized":
			return "dashboardSignInCodeUploadRefused";
		case "too-large":
			return "dashboardSignInCodeUploadTooLarge";
		case "refused":
			return "dashboardSignInCodeUploadFailed";
		case "unreachable":
			return "dashboardSignInCodeUploadFailed";
	}
}

/** `{ ok: true }` and nothing looser. A `200` from a captive portal or a
 * misconfigured proxy is NOT an acknowledgement, and treating it as one would
 * render a code the browser 404s on — the exact broken state the whole
 * push-at-mint sequence exists to end. */
function isAcknowledgement(body: unknown): boolean {
	return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
}

/**
 * Builds an uploader bound to one attempt-classification slot.
 *
 * The handle is created per generate attempt by the screen, so the reason it
 * reports can only ever describe the attempt the screen is currently handling.
 */
export function createBootstrapUploadHandle(overrides?: BootstrapUploadOverrides): BootstrapUploadHandle {
	let lastReason: BootstrapUploadFailureReason | undefined;

	/** Records the classification, emits the ONE log line this attempt is
	 * allowed, and returns the error to throw. On the unreachable path the
	 * caught error's CLASS is appended — never its message. */
	function refuse(reason: BootstrapUploadFailureReason, caught?: unknown): BootstrapUploadError {
		lastReason = reason;
		if (caught === undefined) {
			// eslint-disable-next-line no-console
			console.warn(LOG_PREFIX, reason);
		} else {
			// eslint-disable-next-line no-console
			console.warn(LOG_PREFIX, reason, caught instanceof Error ? caught.name : typeof caught);
		}
		return new BootstrapUploadError(reason);
	}

	const upload: BootstrapSealedUploader = async (request: BootstrapUploadRequest): Promise<void> => {
		// Cleared FIRST, so a stale reason from a prior attempt on this handle
		// is structurally impossible rather than merely unlikely.
		lastReason = undefined;

		const baseUrl = overrides?.baseUrl ?? DEV_BOOTSTRAP_UPLOAD_BASE_URL;
		const token = overrides?.token ?? DEV_BOOTSTRAP_UPLOAD_TOKEN;
		// The build-time condition first, then the session-time condition, and
		// a refusal BEFORE any network call: an unconfigured target must never
		// produce a request.
		if (!__DEV__ || !isUsable(baseUrl) || !isUsable(token)) {
			throw refuse("not-configured");
		}

		// AN EXPLICIT LITERAL, NEVER A SPREAD OF THE CALLER'S OBJECT. This is
		// the last place a stray field could carry the minted secret or the
		// `contentKey` off the device, and the split between the lookup half
		// (which the service sees) and the content half (which never leaves
		// the phone) is the entire basis of the sealing. `sealed` is projected
		// the same way for the same reason. The upload endpoint enforces the
		// mirror-image closed key set on its own side.
		const body = JSON.stringify({
			lookupId: request.lookupId,
			expiresAt: request.expiresAt,
			sealed: {
				v: request.sealed.v,
				nonce: request.sealed.nonce,
				ciphertext: request.sealed.ciphertext,
			},
			// Conditional spread so the key is ABSENT, not present-and-undefined,
			// when there is no prior code to retire.
			...(request.revokeLookupId !== undefined ? { revokeLookupId: request.revokeLookupId } : {}),
		});

		// An explicit controller plus a timer, cleared in a `finally`.
		// `AbortSignal.timeout` is deliberately NOT used: its only appearance
		// in this repo sits on a code path the phone never executes, so it is
		// unproven on this runtime, and the device tier is the only tier that
		// could ever observe the gap.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), overrides?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		const url = `${baseUrl.replace(/\/+$/, "")}${UPLOAD_PATH}`;

		let response: { status: number; json: () => Promise<unknown> };
		try {
			// Called at the call site, never destructured into a local binding:
			// an unbound `fetch` was a real, browser-proven defect in this
			// project's dashboard half and no Node spec could see it.
			response = (await globalThis.fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body,
				signal: controller.signal,
			})) as unknown as { status: number; json: () => Promise<unknown> };
		} catch (error) {
			throw refuse("unreachable", error);
		} finally {
			clearTimeout(timer);
		}

		// Each refusal below rejects WITHOUT READING THE RESPONSE BODY AT ALL.
		// A body read is how a service's error prose reaches a phone log, and
		// the classification is already complete from the status alone.
		if (response.status === 401) throw refuse("unauthorized");
		if (response.status === 413) throw refuse("too-large");
		if (response.status !== 200) throw refuse("refused");

		let acknowledgement: unknown;
		try {
			acknowledgement = await response.json();
		} catch {
			throw refuse("refused");
		}
		if (!isAcknowledgement(acknowledgement)) throw refuse("refused");

		// Resolved, with `lastReason` still `undefined`: the service has the
		// ciphertext, and only now may a code be shown to anyone.
	};

	return {
		upload,
		lastFailureReason: () => lastReason,
	};
}
