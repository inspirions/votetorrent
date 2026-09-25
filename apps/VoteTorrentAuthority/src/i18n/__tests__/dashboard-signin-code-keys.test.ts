/**
 * dashboard-signin-code-keys.test.ts — the `dashboardSignInCode*` copy group's
 * en/es parity proof, and the standing "no phase number, no decision ID in a
 * user-facing string" assertion over every value in it.
 *
 * Renderer-free: imports only the exported `resources` object. No renderer
 * package is a dependency of this app — the same convention
 * `registrant-keys.test.ts` established.
 *
 * A duplicate key inside a single object literal is silently collapsed by the
 * JS parser (the later entry wins, with no runtime trace) — this test alone
 * CANNOT detect that failure mode. The companion source-level `sort | uniq -d`
 * grep gate over `i18n/index.ts` is required in addition to this test, not
 * instead of it.
 */

import { resources } from "../index";

const enTranslation = resources.en.translation as Record<string, string>;
const esTranslation = resources.es.translation as Record<string, string>;

const GROUP_RE = /^dashboardSignInCode[A-Z]/;

/** 12 was the count in each language before the upload copy landed (read off
 * `i18n/index.ts`'s en group, which ran from `dashboardSignInCodeTitle`
 * through `dashboardSignInCodeConfirmBody`). Five keys were added for the
 * upload sequence: the in-flight line and four refusals. */
const GROUP_SIZE = 17;

/** The five keys this group gained for the sealed-upload sequence. */
const NEW_KEYS = [
	"dashboardSignInCodeUploading",
	"dashboardSignInCodeUploadFailed",
	"dashboardSignInCodeUploadRefused",
	"dashboardSignInCodeUploadTooLarge",
	"dashboardSignInCodeUploadNotConfigured",
] as const;

function groupKeys(table: Record<string, string>): string[] {
	return Object.keys(table)
		.filter((key) => GROUP_RE.test(key))
		.sort();
}

/** A decision ID (`D-` plus two digits) or a plan/phase number (two digits, a
 * hyphen, two digits). Either one in officer-facing copy is a defect. */
const ENGINEERING_MARKER_RE = /\bD-\d{2}\b|\b\d{2}-\d{2}\b/;

describe("the dashboardSignInCode* copy group", () => {
	it("the en and es key sets are identical", () => {
		expect(groupKeys(esTranslation)).toEqual(groupKeys(enTranslation));
	});

	it("each language carries exactly the expected number of keys", () => {
		expect(groupKeys(enTranslation)).toHaveLength(GROUP_SIZE);
		expect(groupKeys(esTranslation)).toHaveLength(GROUP_SIZE);
	});

	it.each(NEW_KEYS)("%s is present in both languages with a non-empty string value", (key) => {
		expect(typeof enTranslation[key]).toBe("string");
		expect(enTranslation[key].trim().length).toBeGreaterThan(0);
		expect(typeof esTranslation[key]).toBe("string");
		expect(esTranslation[key].trim().length).toBeGreaterThan(0);
	});

	it("the Spanish strings are real translations, not English placeholders", () => {
		for (const key of NEW_KEYS) {
			expect(esTranslation[key]).not.toBe(enTranslation[key]);
		}
	});

	it("no value in either language carries a decision ID or a phase number", () => {
		// The paired positive control FIRST: a broken regex must fail here
		// rather than pass every assertion below vacuously.
		expect(ENGINEERING_MARKER_RE.test("see D-09 in the 52-11 plan")).toBe(true);
		expect(ENGINEERING_MARKER_RE.test("Copy Code")).toBe(false);

		for (const key of groupKeys(enTranslation)) {
			expect(enTranslation[key]).not.toMatch(ENGINEERING_MARKER_RE);
			expect(esTranslation[key]).not.toMatch(ENGINEERING_MARKER_RE);
		}
	});

	it("every upload refusal states plainly that no code was created", () => {
		// A refusal banner can appear while a PRIOR record still governs the
		// screen, so "couldn't generate a code" alone would leave the officer
		// unsure which code the failure applies to. Each refusal says so
		// explicitly, in both languages.
		const REFUSALS = [
			"dashboardSignInCodeUploadFailed",
			"dashboardSignInCodeUploadRefused",
			"dashboardSignInCodeUploadTooLarge",
			"dashboardSignInCodeUploadNotConfigured",
		];
		// Paired positive control: a broken matcher must fail here rather than
		// pass every assertion below vacuously.
		expect(/no (new )?code was created/.test("so no new code was created.")).toBe(true);
		expect(/no (new )?code was created/.test("Copy Code")).toBe(false);

		for (const key of REFUSALS) {
			expect(enTranslation[key]).toMatch(/no (new )?code was created/);
			expect(esTranslation[key]).toMatch(/no se creó ningún código/);
		}
	});

	it("every upload refusal names a next action the officer can actually take", () => {
		expect(enTranslation.dashboardSignInCodeUploadFailed).toMatch(/try again/);
		expect(enTranslation.dashboardSignInCodeUploadRefused).toMatch(/token/);
		expect(enTranslation.dashboardSignInCodeUploadTooLarge).toMatch(/raise its limit/);
		expect(enTranslation.dashboardSignInCodeUploadNotConfigured).toMatch(/set up/);
	});

	it("the too-large copy interpolates no byte count — the phone is never told the service's limit", () => {
		expect(enTranslation.dashboardSignInCodeUploadTooLarge).not.toMatch(/\{\{/);
		expect(esTranslation.dashboardSignInCodeUploadTooLarge).not.toMatch(/\{\{/);
		expect(enTranslation.dashboardSignInCodeUploadTooLarge).not.toMatch(/\d/);
		expect(esTranslation.dashboardSignInCodeUploadTooLarge).not.toMatch(/\d/);
	});

	it("no value in either language names an engineering internal an officer cannot act on", () => {
		const FORBIDDEN = ["__DEV__", "bearer", "Bearer", "HTTP", "401", "413", "constant", "release build"];
		for (const key of groupKeys(enTranslation)) {
			for (const term of FORBIDDEN) {
				expect(enTranslation[key]).not.toContain(term);
				expect(esTranslation[key]).not.toContain(term);
			}
		}
	});
});
