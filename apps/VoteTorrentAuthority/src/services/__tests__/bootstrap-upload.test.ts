/**
 * bootstrap-upload.test.ts — the real uploader's wire projection, its closed
 * failure vocabulary, and its dev-only-target release gate.
 *
 * Renderer-free by construction: this suite imports the module under test and
 * the i18n `resources` object and nothing else. It drives a `jest.fn()`
 * assigned to `globalThis.fetch` and restores the original in `afterEach`.
 *
 * ===========================================================================
 * DECLARED BLIND SPOT — read before trusting a single green test in this file.
 * ===========================================================================
 * Every network call here is a `jest.fn()`. This suite proves the SHAPE of
 * what would be sent, the CLASSIFICATION of what comes back, and the SOURCE
 * SHAPE of the release gate. It proves nothing about a real HTTP round trip,
 * nothing about a real rendezvous service, and nothing about Hermes — the
 * device leg owns all three. In particular the `__DEV__` gate is asserted by
 * reading this module's own text off disk; that is a claim about what `git
 * add` would stage and what Metro would bundle, NOT a claim that a release
 * build was ever built and observed to be inert.
 * ===========================================================================
 */

import * as fs from "fs";
import * as path from "path";
import {
	BOOTSTRAP_UPLOAD_FAILURE_REASONS,
	DEV_BOOTSTRAP_UPLOAD_BASE_URL,
	DEV_BOOTSTRAP_UPLOAD_TOKEN,
	createBootstrapUploadHandle,
	isBootstrapUploadConfigured,
	uploadFailureCopyKey,
} from "../bootstrap-upload";
import { resources } from "../../i18n";
import type { BootstrapUploadRequest } from "../dashboard-signin-code";

// ---------------------------------------------------------------------------
// Fixtures. `SECRET_HEX` stands in for the minted secret — the one value that
// must never travel. It appears in NONE of the fields a well-formed request
// carries, so every "the body does not contain it" assertion below would pass
// vacuously on its own; the extra-field control and the recorded mutation
// proof are what make them mean something.
// ---------------------------------------------------------------------------
const SECRET_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SECRET_BYTES = Buffer.from(SECRET_HEX, "hex");
const SECRET_B64 = SECRET_BYTES.toString("base64");
const SECRET_B64URL = SECRET_BYTES.toString("base64url");

const LOOKUP_ID = "lookupIdlookupIdlookupIdlookupIdlookupIdAAA";
const EXPIRES_AT = "2099-01-01T00:00:00";
const NONCE = "bm9uY2UtMTItYnl0ZQ";
const CIPHERTEXT = "Y2lwaGVydGV4dC13aXRoLXRoZS10YWc";

const BASE_URL = "http://service.invalid:9099";
const TOKEN = "operator-token-canary";
const UPLOAD_PATH = "/bootstrap/uploads";

/** The prose a real service would put in a response body. Nothing in this
 * module may ever put it into a log line or an Error. */
const RESPONSE_BODY_CANARY = "the service prose that must never reach a phone log";
/** The message on a thrown `fetch` rejection. Same rule. */
const THROWN_MESSAGE_CANARY = "connect ECONNREFUSED 10.0.2.2:9099";

function makeRequest(overrides?: Partial<BootstrapUploadRequest>): BootstrapUploadRequest {
	return {
		lookupId: LOOKUP_ID,
		expiresAt: EXPIRES_AT,
		sealed: { v: 1, nonce: NONCE, ciphertext: CIPHERTEXT },
		...overrides,
	};
}

interface CapturedInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

interface ResponseDouble {
	reads: { json: number; text: number };
	response: unknown;
}

/** A `Response` stand-in that RECORDS whether its body was read. The 401 and
 * 413 cases assert both counters stay at zero: a body read is precisely how a
 * service's error prose reaches a phone log. */
function makeResponseDouble(status: number, jsonImpl: () => Promise<unknown>): ResponseDouble {
	const reads = { json: 0, text: 0 };
	return {
		reads,
		response: {
			status,
			ok: status >= 200 && status < 300,
			json: async () => {
				reads.json += 1;
				return jsonImpl();
			},
			text: async () => {
				reads.text += 1;
				return RESPONSE_BODY_CANARY;
			},
		},
	};
}

function ackResponse(): ResponseDouble {
	return makeResponseDouble(200, async () => ({ ok: true }));
}

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

/** Every argument every console spy captured, flattened and stringified — the
 * single haystack the non-disclosure negatives search. */
function loggedText(): string {
	return [...warnSpy.mock.calls, ...errorSpy.mock.calls]
		.flat()
		.map((arg) => String(arg))
		.join(" | ");
}

function capturedInit(): CapturedInit {
	expect(fetchMock).toHaveBeenCalledTimes(1);
	return fetchMock.mock.calls[0][1] as CapturedInit;
}

function capturedBody(): string {
	const body = capturedInit().body;
	if (typeof body !== "string") throw new Error("the request carried no serialized string body");
	return body;
}

beforeEach(() => {
	fetchMock = jest.fn(async () => ackResponse().response);
	(globalThis as { fetch: unknown }).fetch = fetchMock;
	warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
	errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	(globalThis as { fetch: unknown }).fetch = realFetch;
	warnSpy.mockRestore();
	errorSpy.mockRestore();
	jest.useRealTimers();
});

describe("bootstrap-upload — the fixtures themselves", () => {
	it("control: the fixture lookupId is 43 base64url characters and expiresAt is 19 characters with no Z", () => {
		expect(LOOKUP_ID).toHaveLength(43);
		expect(LOOKUP_ID).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(EXPIRES_AT).toHaveLength(19);
		expect(EXPIRES_AT).not.toContain("Z");
	});

	it("control: the secret canary appears in no field of a well-formed request", () => {
		const serialized = JSON.stringify(makeRequest());
		expect(serialized).not.toContain(SECRET_HEX);
		expect(serialized).not.toContain(SECRET_B64);
		expect(serialized).not.toContain(SECRET_B64URL);
	});
});

describe("D-03 the serialized body is an explicit projection", () => {
	it("a first mint serializes exactly lookupId, expiresAt and sealed", async () => {
		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN });
		await handle.upload(makeRequest());

		expect(Object.keys(JSON.parse(capturedBody())).sort()).toEqual(["expiresAt", "lookupId", "sealed"]);
	});

	it("a re-mint serializes the same three plus revokeLookupId, and nothing else", async () => {
		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN });
		await handle.upload(makeRequest({ revokeLookupId: "priorLookupIdpriorLookupIdpriorLookupIdAAA" }));

		expect(Object.keys(JSON.parse(capturedBody())).sort()).toEqual([
			"expiresAt",
			"lookupId",
			"revokeLookupId",
			"sealed",
		]);
	});

	it("the sealed wrapper is itself projected to exactly v, nonce and ciphertext", async () => {
		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN });
		await handle.upload(makeRequest());

		const sealed = JSON.parse(capturedBody()).sealed;
		expect(Object.keys(sealed).sort()).toEqual(["ciphertext", "nonce", "v"]);
		expect(sealed).toEqual({ v: 1, nonce: NONCE, ciphertext: CIPHERTEXT });
	});

	it("the serialized body carries the minted secret in NO encoding — hex, base64 and base64url each asserted separately", async () => {
		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN });
		await handle.upload(makeRequest());

		const body = capturedBody();
		expect(body).not.toContain(SECRET_HEX);
		expect(body).not.toContain(SECRET_B64);
		expect(body).not.toContain(SECRET_B64URL);
		expect(body).not.toContain("contentKey");
	});

	it("the projection is a literal, not a spread: an extra own property carrying the secret cannot ride along", async () => {
		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN });
		const contaminated = {
			...makeRequest(),
			contentKey: SECRET_HEX,
			secret: SECRET_B64,
			sealed: { v: 1, nonce: NONCE, ciphertext: CIPHERTEXT, contentKey: SECRET_B64URL },
		} as unknown as BootstrapUploadRequest;

		await handle.upload(contaminated);

		const body = capturedBody();
		// THE LEAK FIRST, THE KEY SET SECOND. A spread regression trips both,
		// but only this ordering makes the failure message name the secret
		// VALUE that escaped rather than merely the shape that changed —
		// the same "assert the property, not the classifier" correction the
		// producer core's own sweep case needed.
		expect(body).not.toContain(SECRET_HEX);
		expect(body).not.toContain(SECRET_B64);
		expect(body).not.toContain(SECRET_B64URL);
		expect(body).not.toContain("contentKey");
		expect(Object.keys(JSON.parse(body)).sort()).toEqual(["expiresAt", "lookupId", "sealed"]);
		expect(Object.keys(JSON.parse(body).sealed).sort()).toEqual(["ciphertext", "nonce", "v"]);
	});

	it("the request reaches the shipped route with a POST, a JSON content-type and a bearer authorization", async () => {
		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN });
		await handle.upload(makeRequest());

		const [url, init] = fetchMock.mock.calls[0] as [string, CapturedInit];
		expect(url.endsWith(UPLOAD_PATH)).toBe(true);
		expect(url).toBe(`${BASE_URL}${UPLOAD_PATH}`);
		expect(init.method).toBe("POST");
		expect(init.headers?.["content-type"]).toBe("application/json");
		expect(init.headers?.authorization).toBe(`Bearer ${TOKEN}`);
	});

	it("a trailing slash on the base URL does not produce a doubled path separator", async () => {
		const handle = createBootstrapUploadHandle({ baseUrl: `${BASE_URL}//`, token: TOKEN });
		await handle.upload(makeRequest());

		expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}${UPLOAD_PATH}`);
	});
});

describe("D-03 the status-to-reason table, each case with its own reason", () => {
	async function attempt(double: ResponseDouble | (() => Promise<never>)) {
		if (typeof double === "function") {
			fetchMock.mockImplementation(double);
		} else {
			fetchMock.mockImplementation(async () => double.response);
		}
		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN });
		let caught: unknown;
		try {
			await handle.upload(makeRequest());
		} catch (error) {
			caught = error;
		}
		return { handle, caught };
	}

	it("the positive control: a 200 carrying the shipped ack resolves and leaves lastFailureReason undefined", async () => {
		const double = ackResponse();
		fetchMock.mockImplementation(async () => double.response);
		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN });

		await expect(handle.upload(makeRequest())).resolves.toBeUndefined();

		expect(handle.lastFailureReason()).toBeUndefined();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("a 200 whose body is not JSON at all classifies as refused — a captive portal is not an acknowledgement", async () => {
		const { handle, caught } = await attempt(
			makeResponseDouble(200, async () => {
				throw new Error("Unexpected token < in JSON at position 0");
			}),
		);

		expect(handle.lastFailureReason()).toBe("refused");
		expect((caught as { reason?: string }).reason).toBe("refused");
	});

	it("a 200 whose JSON body omits the ack member classifies as refused", async () => {
		const { handle, caught } = await attempt(makeResponseDouble(200, async () => ({ accepted: "sure" })));

		expect(handle.lastFailureReason()).toBe("refused");
		expect((caught as { reason?: string }).reason).toBe("refused");
	});

	it("a 401 classifies as unauthorized", async () => {
		const { handle, caught } = await attempt(makeResponseDouble(401, async () => ({ error: "unauthorized" })));

		expect(handle.lastFailureReason()).toBe("unauthorized");
		expect((caught as { reason?: string }).reason).toBe("unauthorized");
	});

	it("a 413 classifies as too-large", async () => {
		const { handle, caught } = await attempt(
			makeResponseDouble(413, async () => ({ error: "upload too large", limitBytes: 512 })),
		);

		expect(handle.lastFailureReason()).toBe("too-large");
		expect((caught as { reason?: string }).reason).toBe("too-large");
	});

	it("a 500 classifies as refused", async () => {
		const { handle } = await attempt(makeResponseDouble(500, async () => ({ error: "internal error" })));

		expect(handle.lastFailureReason()).toBe("refused");
	});

	it("a 404 classifies as refused", async () => {
		const { handle } = await attempt(makeResponseDouble(404, async () => ({ error: "not found" })));

		expect(handle.lastFailureReason()).toBe("refused");
	});

	it("a fetch that throws classifies as unreachable", async () => {
		const { handle, caught } = await attempt(async () => {
			throw new Error(THROWN_MESSAGE_CANARY);
		});

		expect(handle.lastFailureReason()).toBe("unreachable");
		expect((caught as { reason?: string }).reason).toBe("unreachable");
	});

	it("a fetch that rejects with an abort-shaped error classifies as unreachable", async () => {
		const { handle } = await attempt(async () => {
			throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
		});

		expect(handle.lastFailureReason()).toBe("unreachable");
	});

	it("the response body is never read on a 401", async () => {
		const double = makeResponseDouble(401, async () => ({ error: "unauthorized" }));
		await attempt(double);

		expect(double.reads).toEqual({ json: 0, text: 0 });
	});

	it("the response body is never read on a 413", async () => {
		const double = makeResponseDouble(413, async () => ({ error: "upload too large", limitBytes: 512 }));
		await attempt(double);

		expect(double.reads).toEqual({ json: 0, text: 0 });
	});
});

describe("the handle's failure reason is per-attempt, never stale", () => {
	it("a fresh handle reports undefined before any attempt", () => {
		expect(createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN }).lastFailureReason()).toBeUndefined();
	});

	it("a failure then a success on the SAME handle clears the reason", async () => {
		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN });

		fetchMock.mockImplementationOnce(async () => makeResponseDouble(401, async () => ({})).response);
		await expect(handle.upload(makeRequest())).rejects.toBeDefined();
		expect(handle.lastFailureReason()).toBe("unauthorized");

		fetchMock.mockImplementationOnce(async () => ackResponse().response);
		await handle.upload(makeRequest());
		expect(handle.lastFailureReason()).toBeUndefined();
	});
});

describe("nothing leaks into a log line or into the rejected error", () => {
	const CASES: ReadonlyArray<[string, () => Promise<unknown>, string]> = [
		["401", async () => makeResponseDouble(401, async () => ({})).response, "unauthorized"],
		["413", async () => makeResponseDouble(413, async () => ({})).response, "too-large"],
		["500", async () => makeResponseDouble(500, async () => ({})).response, "refused"],
		[
			"a 200 with the wrong body",
			async () => makeResponseDouble(200, async () => ({ accepted: RESPONSE_BODY_CANARY })).response,
			"refused",
		],
		[
			"a thrown fetch",
			async () => {
				throw new Error(THROWN_MESSAGE_CANARY);
			},
			"unreachable",
		],
	];

	it.each(CASES)(
		"%s: the log carries the reason token and neither the operator token, the response body, the caught message nor the secret",
		async (_label, impl, expectedReason) => {
			fetchMock.mockImplementation(impl as () => Promise<unknown>);
			const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN });

			let caught: unknown;
			try {
				await handle.upload(makeRequest());
			} catch (error) {
				caught = error;
			}

			// The paired positive control: the spy really is observing this
			// module, because one whole argument IS the closed-set reason token.
			const args = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat();
			expect(args).toContain(expectedReason);

			const haystack = loggedText();
			expect(haystack).not.toContain(TOKEN);
			expect(haystack).not.toContain(RESPONSE_BODY_CANARY);
			expect(haystack).not.toContain(THROWN_MESSAGE_CANARY);
			expect(haystack).not.toContain(SECRET_HEX);
			expect(haystack).not.toContain(BASE_URL);

			const message = (caught as Error).message;
			expect(message).toContain(expectedReason);
			expect(message).not.toContain(TOKEN);
			expect(message).not.toContain(RESPONSE_BODY_CANARY);
			expect(message).not.toContain(THROWN_MESSAGE_CANARY);
			expect(message).not.toContain(SECRET_HEX);
			expect(message).not.toContain(BASE_URL);
			// 52-06 attaches no `cause` for exactly this reason; neither does this module.
			expect((caught as { cause?: unknown }).cause).toBeUndefined();
		},
	);

	it("exactly one warn line is emitted per failed attempt", async () => {
		fetchMock.mockImplementation(async () => makeResponseDouble(401, async () => ({})).response);
		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN });

		await expect(handle.upload(makeRequest())).rejects.toBeDefined();

		expect(warnSpy).toHaveBeenCalledTimes(1);
	});
});

describe("D-27 the dev-only upload target", () => {
	it("the shipped constants are strictly undefined — this test fails loudly if a device-proof session's edit is ever committed", () => {
		expect(DEV_BOOTSTRAP_UPLOAD_BASE_URL).toBeUndefined();
		expect(DEV_BOOTSTRAP_UPLOAD_TOKEN).toBeUndefined();
	});

	it("with no target configured, isBootstrapUploadConfigured is false", () => {
		expect(isBootstrapUploadConfigured()).toBe(false);
	});

	it("the positive control: with both values supplied under a dev build, it is true", () => {
		expect(isBootstrapUploadConfigured({ baseUrl: BASE_URL, token: TOKEN })).toBe(true);
	});

	it("a base URL with no token is still not configured", () => {
		expect(isBootstrapUploadConfigured({ baseUrl: BASE_URL })).toBe(false);
	});

	it("a whitespace-only value is not a configured value", () => {
		expect(isBootstrapUploadConfigured({ baseUrl: "   ", token: TOKEN })).toBe(false);
		expect(isBootstrapUploadConfigured({ baseUrl: BASE_URL, token: "  " })).toBe(false);
	});

	it("an unconfigured target refuses with not-configured WITHOUT calling fetch at all", async () => {
		const handle = createBootstrapUploadHandle();

		await expect(handle.upload(makeRequest())).rejects.toMatchObject({ reason: "not-configured" });

		expect(handle.lastFailureReason()).toBe("not-configured");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("a base URL with no token refuses with not-configured WITHOUT calling fetch", async () => {
		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL });

		await expect(handle.upload(makeRequest())).rejects.toMatchObject({ reason: "not-configured" });

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("the paired positive control: with both configured, the same call DOES reach fetch", async () => {
		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN });

		await handle.upload(makeRequest());

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("D-27 the release gate, asserted on this module's own source text", () => {
	// The established release-guard idiom in this app (see the two
	// `*.releaseGuard.test.ts` suites under `src/engines/__tests__`): read the
	// file as TEXT, so the assertion is about what `git add` would stage and
	// what Metro would bundle. It does NOT prove a release build was ever
	// produced and observed inert — only a release-bundle inspection could, and
	// that is the device leg's job, not this file's.
	//
	// The sibling guard's file name is deliberately NOT written out here: that
	// suite greps the whole `src` tree for its own module name and treats any
	// unexpected match as a violation, so quoting it would fail an unrelated
	// gate for a comment.
	const MODULE_PATH = path.join(__dirname, "../bootstrap-upload.ts");
	const source = fs.readFileSync(MODULE_PATH, "utf8");
	const stripped = source
		.split("\n")
		.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
		.join("\n");

	it("references __DEV__ at least twice — the build-time condition is checked on both reachable paths", () => {
		expect((source.match(/__DEV__/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	it("isBootstrapUploadConfigured checks __DEV__ before it reads either constant", () => {
		const start = stripped.indexOf("export function isBootstrapUploadConfigured");
		expect(start).toBeGreaterThan(-1);
		const body = stripped.slice(start, stripped.indexOf("\n}", start));
		const devIndex = body.indexOf("__DEV__");
		const baseUrlIndex = body.indexOf("DEV_BOOTSTRAP_UPLOAD_BASE_URL");
		const tokenIndex = body.indexOf("DEV_BOOTSTRAP_UPLOAD_TOKEN");
		expect(devIndex).toBeGreaterThan(-1);
		expect(baseUrlIndex).toBeGreaterThan(devIndex);
		expect(tokenIndex).toBeGreaterThan(devIndex);
	});

	it("carries no host literal in code — a default host is exactly how a build ships pointing at the wrong service", () => {
		for (const host of ["http://", "https://", "10.0.2.2", "localhost", "127.0.0.1"]) {
			expect(stripped).not.toContain(host);
		}
		// Positive control in the same case: the right file really was read.
		expect(stripped).toContain("DEV_BOOTSTRAP_UPLOAD_BASE_URL");
	});

	it("declares both constants with no default value", () => {
		for (const name of ["DEV_BOOTSTRAP_UPLOAD_BASE_URL", "DEV_BOOTSTRAP_UPLOAD_TOKEN"]) {
			expect(source).toMatch(new RegExp(`export const ${name}\\s*:\\s*string \\| undefined = undefined`));
		}
	});

	it("calls globalThis.fetch at the call site and never binds it to a local", () => {
		expect(stripped).toContain("globalThis.fetch(");
		expect(stripped).not.toMatch(/=\s*globalThis\.fetch\s*[;,)]/);
		expect(stripped).not.toMatch(/\bfetch\s*}\s*=\s*globalThis/);
	});

	it("uses an AbortController with an explicit timer, never AbortSignal.timeout", () => {
		expect(stripped).toContain("new AbortController()");
		expect(stripped).toContain("clearTimeout(");
		expect(stripped).not.toContain("AbortSignal.timeout");
	});
});

describe("a hung upload is aborted and classified as unreachable", () => {
	it("the timer fires, the signal aborts, and the attempt rejects unreachable", async () => {
		jest.useFakeTimers();
		let capturedSignal: AbortSignal | undefined;
		fetchMock.mockImplementation(
			(_url: string, init: CapturedInit) =>
				new Promise((_resolve, reject) => {
					capturedSignal = init.signal;
					init.signal?.addEventListener("abort", () => {
						reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
					});
				}),
		);

		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN, timeoutMs: 15_000 });
		const pending = handle.upload(makeRequest());
		const assertion = expect(pending).rejects.toMatchObject({ reason: "unreachable" });

		jest.advanceTimersByTime(15_000);
		await assertion;

		expect(capturedSignal).toBeDefined();
		expect(capturedSignal?.aborted).toBe(true);
		expect(handle.lastFailureReason()).toBe("unreachable");
	});

	it("the paired control: a response that arrives in time does not abort, and the timer is cleared", async () => {
		jest.useFakeTimers();
		let capturedSignal: AbortSignal | undefined;
		fetchMock.mockImplementation(async (_url: string, init: CapturedInit) => {
			capturedSignal = init.signal;
			return ackResponse().response;
		});

		const handle = createBootstrapUploadHandle({ baseUrl: BASE_URL, token: TOKEN, timeoutMs: 15_000 });
		await handle.upload(makeRequest());

		expect(capturedSignal?.aborted).toBe(false);
		// Advancing well past the timeout produces no late abort: the timer was cleared.
		jest.advanceTimersByTime(120_000);
		expect(capturedSignal?.aborted).toBe(false);
		expect(handle.lastFailureReason()).toBeUndefined();
	});
});

describe("uploadFailureCopyKey is total over the closed reason set", () => {
	const en = resources.en.translation as Record<string, string>;

	it("the vocabulary is exactly the five locked members", () => {
		expect([...BOOTSTRAP_UPLOAD_FAILURE_REASONS].sort()).toEqual([
			"not-configured",
			"refused",
			"too-large",
			"unauthorized",
			"unreachable",
		]);
	});

	it("every reason maps to a key that exists in en, and never to the generic generate-failed key", () => {
		for (const reason of BOOTSTRAP_UPLOAD_FAILURE_REASONS) {
			const key = uploadFailureCopyKey(reason);
			expect(typeof key).toBe("string");
			expect(en[key]).toBeTruthy();
			expect(key).not.toBe("dashboardSignInCodeGenerateFailed");
		}
	});

	it("the four officer-distinguishable reasons map to four pairwise-distinct keys", () => {
		// DEVIATION, recorded here rather than buried: `'refused'` and
		// `'unreachable'` deliberately SHARE the generic upload-failure key.
		// The plan locks exactly five new copy keys, one of which is the
		// in-flight line, leaving four failure keys for five reasons — and
		// these two are the pair whose officer-facing remedy is identical
		// ("no new code was created; check the service is running, then try
		// again"). The four below are the ones whose remedies genuinely
		// differ, and they stay distinct.
		const keys = (["unauthorized", "too-large", "not-configured", "unreachable"] as const).map(uploadFailureCopyKey);
		expect(new Set(keys).size).toBe(4);
	});

	it("refused and unreachable share the generic upload key, and it is not the generate-failed key", () => {
		expect(uploadFailureCopyKey("refused")).toBe(uploadFailureCopyKey("unreachable"));
		expect(uploadFailureCopyKey("refused")).not.toBe("dashboardSignInCodeGenerateFailed");
	});
});
