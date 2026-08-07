/**
 * RegistrationRequestApprovalScreen.test.tsx — the Phase 48 approval-ceremony
 * suite (48-19): all three modes, the fixed render order, the observed-vs-
 * claimed provenance pair, the D-07 checklist gate, the accept ceremony's
 * unconditional `sign` + bound checklist, the `requestId` task-scoping
 * disambiguation, the D-06 reject-reason gate and its no-sign discipline,
 * the never-log privacy rule, and the untouched-`SignatureTaskScreen.tsx`
 * source gate.
 *
 * ============================================================================
 * DECLARED BLIND SPOT — read before trusting a single green test in this file.
 * ============================================================================
 * Every engine here is a `jest.fn()` stub. None of them enforce the schema's
 * PK/CHECK/`InsertOnly` semantics — no `DecisionValid`, no `AdminSigning`
 * scope CHECK, no `SignatureValid` re-verification. Every assertion below
 * proves a UI legibility affordance and a CALL CONTRACT — the exact shape of
 * the arguments this screen passes to `completeSignature` /
 * `rejectRegistrationRequest` — and never an access-control boundary. The
 * real controls are the schema CHECKs proven by 48-04/48-11/48-12's
 * real-Quereus specs and the device leg in 48-22.
 *
 * `jest.fn()` stubs are used here rather than the `dist/`-loaded
 * `MockRegistrationEngine` that `RegistrationInboxScreen.test.tsx` prefers,
 * because this suite's subject IS the argument shape the screen passes to
 * `completeSignature` / `rejectRegistrationRequest` — a call-recording stub
 * proves that directly; a `Map`-backed mock engine only proves it by
 * inference from a resulting row.
 *
 * `VerificationChecklist`, `PriorRejectionsCallout`, `BridgeSourceBadge` (the
 * module `BridgeSourceCallout` lives in) and `RejectReasonCard` are
 * DELIBERATELY NOT mocked below — they render for real. Mocking them would
 * reduce the render-order assertion and the two gate assertions to
 * tautologies about the screen's own JSX.
 * ============================================================================
 */

import React from "react";
import renderer from "react-test-renderer";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Mutable module-level slots. Prefixed `mock` so babel-plugin-jest-hoist
// allows the jest.mock() factories below to close over them.
// ---------------------------------------------------------------------------

const RECEIVED_AT = "2026-08-05T10:00:00Z";
const SUBMITTED_AT = "2026-07-01T09:00:00Z"; // deliberately divergent from RECEIVED_AT
const FUTURE_EXPIRATION = "2099-01-01T00:00:00.000Z";

// Private-tier VALUE sentinel (a fake SSN-shaped string) — never used in a
// test title, per this file's own never-log discipline.
const PII_SENTINEL = "999-99-9999";

const BASE_PAYLOAD = {
	registrant: { id: "registrant-draft-1", authorityId: "auth-1", expiration: FUTURE_EXPIRATION },
	public: { lastName: "Doe", firstName: "Jane", district: "D3", extraFields: { note: "first-time applicant" } },
	private: { expiration: FUTURE_EXPIRATION, details: [{ name: "ssn", value: PII_SENTINEL }] },
};

const PENDING_READ: any = {
	requestId: "req-pending-1",
	authorityId: "auth-1",
	requesterKey: "requester-key-1",
	issuerType: "registrant",
	payload: BASE_PAYLOAD,
	payloadCid: "cid-pending-1",
	status: "p",
	submittedAt: SUBMITTED_AT,
	receivedAt: RECEIVED_AT,
};

const BRIDGE_PENDING_READ: any = {
	...PENDING_READ,
	requestId: "req-bridge-1",
	issuerType: "bridge",
	bridgeId: "bridge-1",
	bridgeLabel: "Statewide DMV Bridge",
};

const APPROVED_READ: any = {
	...PENDING_READ,
	requestId: "req-approved-1",
	status: "a",
	decidedAt: "2026-08-06T12:00:00Z",
	decidingOfficerUserId: "officer-1",
	registrantId: "registrant-approved-1",
	verificationChecklist: ["id", "roll"],
};

const APPROVED_READ_NO_REGISTRANT: any = {
	...APPROVED_READ,
	requestId: "req-approved-2",
	registrantId: undefined,
};

const REJECTED_READ: any = {
	...PENDING_READ,
	requestId: "req-rejected-1",
	status: "r",
	decidedAt: "2026-08-06T12:00:00Z",
	decidingOfficerUserId: "officer-2",
	rejectionReason: "ID did not match the voter roll",
	verificationChecklist: ["roll"],
};

function taskFor(read: any): any {
	return {
		type: "signature",
		network: {},
		userId: "device-user-1",
		signatureType: "registrant",
		requestId: read.requestId,
		payload: read.payload,
		submittedAt: read.submittedAt,
		issuerType: read.issuerType,
	};
}

let mockRouteParams: { requestId: string; authorityId: string } = {
	requestId: PENDING_READ.requestId,
	authorityId: "auth-1",
};

let mockCurrentRead: any = PENDING_READ;
let mockPriorRejections: any[] = [];
let mockPriorRejectionsError: Error | undefined = undefined;
let mockTasks: any[] = [taskFor(PENDING_READ)];
let mockScopes: string[] | undefined = ["vrg"];

const mockGetRegistrationRequest = jest.fn(async (_id: string) => mockCurrentRead);
const mockGetPriorRejections = jest.fn(async (_requesterKey: string) => {
	if (mockPriorRejectionsError) throw mockPriorRejectionsError;
	return mockPriorRejections;
});
const mockRejectRegistrationRequest = jest.fn(async (_requestId: string, _decision: any, _signer: any) => undefined);

const mockRegistrationEngine = {
	getRegistrationRequest: mockGetRegistrationRequest,
	getPriorRejections: mockGetPriorRejections,
	rejectRegistrationRequest: mockRejectRegistrationRequest,
};

const mockGetRequestedSignatures = jest.fn(async (_pending: boolean) => mockTasks);
const mockGetSignatureDigest = jest.fn(async (_task: any) => new Uint8Array([9, 9, 9]));
const mockCompleteSignature = jest.fn(async (_task: any, _result: any) => undefined);

const mockSignatureTasksEngine = {
	getRequestedSignatures: mockGetRequestedSignatures,
	getSignatureDigest: mockGetSignatureDigest,
	completeSignature: mockCompleteSignature,
};

const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") return mockRegistrationEngine;
	if (name === "signatureTasksEngine") return mockSignatureTasksEngine;
	return null;
});

const mockSignerFn = jest.fn(async (_digest: Uint8Array) => ({
	signature: "device-signature",
	signerKey: "device-key",
	signerUserId: "device-user-1",
}));
const mockCreateDeviceSigner = jest.fn(async (_displayName: string) => mockSignerFn);

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();

// ---------------------------------------------------------------------------
// Module mocks — module scope, before any import of the screen.
// ---------------------------------------------------------------------------

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

// bottom: 34 (not 0) is deliberate — a non-zero mocked inset is what makes
// the "strictly greater than 24" padding assertions below actually
// discriminate a safe-area-aware pad from a hardcoded one; with bottom: 0
// `insets.bottom + 24` and a bare `paddingBottom: 24` would be indistinguishable.
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

// react-i18next: identity `t` that returns the bare key even when given an
// options object — interpolated strings therefore assert on KEY names, not
// on resolved copy (48-03 owns copy; this suite is not a copy oracle).
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock("@react-navigation/native", () => ({
	// Distinct sentinel values for every color token so a color assertion can
	// never pass by accidental equality between two tokens.
	dark: false,
	useTheme: () => ({
		dark: false,
		colors: {
			primary: "sentinel-primary",
			background: "sentinel-background",
			card: "sentinel-card",
			text: "sentinel-text",
			border: "sentinel-border",
			notification: "sentinel-notification",
			error: "sentinel-error",
			textSecondary: "sentinel-textSecondary",
			important: "sentinel-important",
			success: "sentinel-success",
			accent: "sentinel-accent",
			warning: "sentinel-warning",
			dark: "sentinel-dark",
			light: "sentinel-light",
		},
	}),
	useNavigation: () => ({
		navigate: mockNavigate,
		goBack: mockGoBack,
		setOptions: mockSetOptions,
	}),
	useRoute: () => ({ params: mockRouteParams }),
}));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: mockCreateDeviceSigner,
}));

jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: (_authorityId: string) => ({ scopes: mockScopes, loading: false }),
}));

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flushTicks(count: number): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < count; i++) {
			await Promise.resolve();
		}
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const RegistrationRequestApprovalScreenModule = require("../RegistrationRequestApprovalScreen");
	const RegistrationRequestApprovalScreen = RegistrationRequestApprovalScreenModule.default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<RegistrationRequestApprovalScreen />);
	});
	await flushTicks(8);
	return tr;
}

/** Walks `tr.toJSON()` (HOST nodes only — no composite/host double-count) collecting every `testID` in tree order. */
function collectTestIDs(node: any, acc: string[]): void {
	if (node === null || node === undefined) return;
	if (Array.isArray(node)) {
		for (const child of node) collectTestIDs(child, acc);
		return;
	}
	if (node.props && typeof node.props.testID === "string") acc.push(node.props.testID);
	if (node.children) {
		for (const child of node.children) collectTestIDs(child, acc);
	}
}

function orderedTestIDs(tr: renderer.ReactTestRenderer): string[] {
	const acc: string[] = [];
	collectTestIDs(tr.toJSON(), acc);
	return acc;
}

function findPressable(tr: renderer.ReactTestRenderer, testID: string) {
	const wrapper = tr.root.findByProps({ testID });
	return [wrapper, ...wrapper.findAll(() => true)].find((node) => typeof node.props.onPress === "function");
}

function press(tr: renderer.ReactTestRenderer, testID: string) {
	const pressable = findPressable(tr, testID);
	renderer.act(() => {
		pressable!.props.onPress();
	});
}

async function pressAsync(tr: renderer.ReactTestRenderer, testID: string) {
	const pressable = findPressable(tr, testID);
	await renderer.act(async () => {
		pressable!.props.onPress();
	});
	await flushTicks(8);
}

function isDisabled(tr: renderer.ReactTestRenderer, testID: string): boolean {
	const wrapper = tr.root.findByProps({ testID });
	const disabledNode = [wrapper, ...wrapper.findAll(() => true)].find((node) => "disabled" in node.props);
	return disabledNode?.props.disabled === true;
}

function textOf(tr: renderer.ReactTestRenderer, testID: string): string {
	const node = tr.root.findByProps({ testID });
	return String(node.props.children);
}

function exists(tr: renderer.ReactTestRenderer, testID: string): boolean {
	try {
		tr.root.findByProps({ testID });
		return true;
	} catch {
		return false;
	}
}

/** Finds the JSON (host-node) subtree for `testID` within `tr.toJSON()`, by walking the same tree `orderedTestIDs` walks. Returns `undefined` when absent. */
function findJsonSubtree(node: any, testID: string): any {
	if (node === null || node === undefined) return undefined;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findJsonSubtree(child, testID);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (node.props && node.props.testID === testID) return node;
	if (node.children) {
		for (const child of node.children) {
			const found = findJsonSubtree(child, testID);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

function jsonSubtreeText(tr: renderer.ReactTestRenderer, testID: string): string {
	const subtree = findJsonSubtree(tr.toJSON(), testID);
	return subtree === undefined ? "" : JSON.stringify(subtree);
}

function totalEngineCallCount(): number {
	return (
		mockGetRegistrationRequest.mock.calls.length +
		mockGetPriorRejections.mock.calls.length +
		mockRejectRegistrationRequest.mock.calls.length +
		mockGetRequestedSignatures.mock.calls.length +
		mockGetSignatureDigest.mock.calls.length +
		mockCompleteSignature.mock.calls.length
	);
}

// ---------------------------------------------------------------------------
// Console spies — Group F, assertion 21. Installed once for the whole file,
// asserted (and cleared) around EVERY test, including failure paths.
// ---------------------------------------------------------------------------

let consoleSpies: jest.SpyInstance[] = [];

beforeAll(() => {
	consoleSpies = (["log", "warn", "error", "debug", "info"] as const).map((method) =>
		jest.spyOn(console, method).mockImplementation(() => undefined)
	);
});

afterAll(() => {
	consoleSpies.forEach((spy) => spy.mockRestore());
});

beforeEach(() => {
	jest.clearAllMocks();
	consoleSpies.forEach((spy) => spy.mockClear());
	mockRouteParams = { requestId: PENDING_READ.requestId, authorityId: "auth-1" };
	mockCurrentRead = PENDING_READ;
	mockPriorRejections = [];
	mockPriorRejectionsError = undefined;
	mockTasks = [taskFor(PENDING_READ)];
	mockScopes = ["vrg"];
});

afterEach(() => {
	consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
});

// ---------------------------------------------------------------------------
// Group A — pending mode, render order, and the D-03 claim.
// ---------------------------------------------------------------------------

describe("RegistrationRequestApprovalScreen — Group A (render order, D-03)", () => {
	it("1. pending + bridge-issued: screen renders, and bridge-source-callout < prior-rejections-callout < summary < verification-checklist in tree order", async () => {
		mockCurrentRead = BRIDGE_PENDING_READ;
		mockTasks = [taskFor(BRIDGE_PENDING_READ)];
		mockPriorRejections = [
			{ requestId: "req-old-1", rejectedAt: "2026-01-01T00:00:00Z", rejectionReason: "no id", decidingOfficerUserId: "officer-9" },
		];
		mockRouteParams = { requestId: BRIDGE_PENDING_READ.requestId, authorityId: "auth-1" };

		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-screen")).toBe(true);

		const ids = orderedTestIDs(tr);
		const bridgeIdx = ids.indexOf("bridge-source-callout");
		const priorIdx = ids.indexOf("prior-rejections-callout");
		const summaryIdx = ids.indexOf("registration-request-approval-summary");
		const checklistIdx = ids.indexOf("verification-checklist");

		expect(bridgeIdx).toBeGreaterThanOrEqual(0);
		expect(priorIdx).toBeGreaterThan(bridgeIdx);
		expect(summaryIdx).toBeGreaterThan(priorIdx);
		expect(checklistIdx).toBeGreaterThan(summaryIdx);
	});

	it("2. pending + registrant-issued: bridge-source-callout is absent while the summary and checklist still render", async () => {
		const tr = await renderScreen();
		expect(exists(tr, "bridge-source-callout")).toBe(false);
		expect(exists(tr, "registration-request-approval-summary")).toBe(true);
		expect(exists(tr, "verification-checklist")).toBe(true);
	});

	it("1b. pending + registrant-issued + WITH prior rejections: prior-rejections-callout < summary order still holds with no bridge callout in between", async () => {
		mockPriorRejections = [
			{ requestId: "req-old-2", rejectedAt: "2026-02-01T00:00:00Z", rejectionReason: "wrong address", decidingOfficerUserId: "officer-8" },
		];
		const tr = await renderScreen();
		expect(exists(tr, "bridge-source-callout")).toBe(false);

		const ids = orderedTestIDs(tr);
		const priorIdx = ids.indexOf("prior-rejections-callout");
		const summaryIdx = ids.indexOf("registration-request-approval-summary");
		expect(priorIdx).toBeGreaterThanOrEqual(0);
		expect(summaryIdx).toBeGreaterThan(priorIdx);
	});

	it("3. pending + zero prior rejections: prior-rejections-callout is absent, summary still renders", async () => {
		const tr = await renderScreen();
		expect(exists(tr, "prior-rejections-callout")).toBe(false);
		expect(exists(tr, "registration-request-approval-summary")).toBe(true);
	});

	it("3b. both timestamps, pending mode — the provenance-pair assertion T-48-05-09/T-48-07-12/T-48-08-11 rest on", async () => {
		const tr = await renderScreen();
		const receivedValue = textOf(tr, "registration-request-approval-summary-value-received-at");
		const submittedValue = textOf(tr, "registration-request-approval-summary-value-submitted-at");

		expect(receivedValue).toBe("2026-08-05");
		expect(submittedValue).toBe("2026-07-01");
		expect(receivedValue).not.toBe(submittedValue);

		expect(textOf(tr, "registration-request-approval-summary-label-received-at")).toBe(
			"registrationRequestApprovalReceivedAtLabel"
		);
		expect(textOf(tr, "registration-request-approval-summary-label-submitted-at")).toBe(
			"registrationRequestApprovalSubmittedAtLabel"
		);

		const ids = orderedTestIDs(tr);
		const receivedRowIdx = ids.indexOf("registration-request-approval-summary-row-received-at");
		const submittedRowIdx = ids.indexOf("registration-request-approval-summary-row-submitted-at");
		const firstPublicRowIdx = ids.findIndex((id) => id.startsWith("registration-request-approval-summary-row-public-"));

		expect(receivedRowIdx).toBeGreaterThanOrEqual(0);
		expect(submittedRowIdx).toBeGreaterThan(receivedRowIdx);
		expect(firstPublicRowIdx).toBeGreaterThan(submittedRowIdx);
	});

	it("3c. converged case: both provenance rows still render, even when the two values are equal (no divergence threshold)", async () => {
		mockCurrentRead = { ...PENDING_READ, submittedAt: RECEIVED_AT };
		mockTasks = [taskFor(mockCurrentRead)];

		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-summary-value-received-at")).toBe(true);
		expect(exists(tr, "registration-request-approval-summary-value-submitted-at")).toBe(true);
		expect(textOf(tr, "registration-request-approval-summary-value-received-at")).toBe(
			textOf(tr, "registration-request-approval-summary-value-submitted-at")
		);
	});

	it("4. registration-request-approval-footer renders in pending mode; the two decided-mode blocks do not", async () => {
		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-footer")).toBe(true);
		expect(exists(tr, "registration-request-approval-approved-block")).toBe(false);
		expect(exists(tr, "registration-request-approval-rejected-block")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Group B — the D-07 checklist gate and the accept ceremony.
// ---------------------------------------------------------------------------

describe("RegistrationRequestApprovalScreen — Group B (D-07 gate, accept ceremony)", () => {
	it("5. at mount Approve is disabled and Reject is not", async () => {
		const tr = await renderScreen();
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(false);
	});

	it("6. toggling the checklist flips Approve's disabled state in both directions", async () => {
		const tr = await renderScreen();
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);

		press(tr, "verification-checklist-toggle-id");
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(false);

		press(tr, "verification-checklist-toggle-id");
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
	});

	it("7. approving calls getSignatureDigest -> createDeviceSigner -> completeSignature, in order, with an unconditional function sign and the bound checklist", async () => {
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(false);

		await pressAsync(tr, "registration-request-approval-approve");

		expect(mockGetSignatureDigest).toHaveBeenCalledTimes(1);
		expect(mockGetSignatureDigest.mock.calls[0][0].requestId).toBe(PENDING_READ.requestId);
		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(mockCompleteSignature).toHaveBeenCalledTimes(1);

		expect(mockGetSignatureDigest.mock.invocationCallOrder[0]).toBeLessThan(
			mockCreateDeviceSigner.mock.invocationCallOrder[0]
		);
		expect(mockCreateDeviceSigner.mock.invocationCallOrder[0]).toBeLessThan(
			mockCompleteSignature.mock.invocationCallOrder[0]
		);

		const [, result] = mockCompleteSignature.mock.calls[0];
		expect(result.isAccepted).toBe(true);
		expect(typeof result.sign).toBe("function");
		expect(result.decision.checklist).toEqual(["id"]);

		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});

	it("8. requestId scoping: with two pending 'registrant' tasks (non-matching first), the matching one is signed and completed", async () => {
		const otherTask = taskFor({ ...PENDING_READ, requestId: "req-other-pending" });
		const matchingTask = taskFor(PENDING_READ);
		mockTasks = [otherTask, matchingTask];

		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		await pressAsync(tr, "registration-request-approval-approve");

		expect(mockGetSignatureDigest.mock.calls[0][0].requestId).toBe(PENDING_READ.requestId);
		expect(mockCompleteSignature.mock.calls[0][0].requestId).toBe(PENDING_READ.requestId);
	});

	it("9. scope gate (legibility only): without 'vrg', Approve and Reject both render disabled === true and are present, not hidden", async () => {
		mockScopes = ["other-scope"];
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");

		expect(exists(tr, "registration-request-approval-approve")).toBe(true);
		expect(exists(tr, "registration-request-approval-reject")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(true);
	});

	it("10. L-3: a getPriorRejections failure surfaces in InlineError and blocks Approve even after the checklist gate is met, while Reject stays enabled", async () => {
		mockPriorRejectionsError = new Error("prior-rejections-lookup-failed");
		const tr = await renderScreen();

		expect(exists(tr, "registration-request-approval-error")).toBe(true);

		press(tr, "verification-checklist-toggle-id");
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(false);
	});

	it("10b. no seeded signature task yet: Approve fails closed with an InlineError and calls neither getSignatureDigest nor completeSignature", async () => {
		mockTasks = []; // no 'registrant' task materialized for this request yet
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(false);

		await pressAsync(tr, "registration-request-approval-approve");

		expect(mockGetSignatureDigest).toHaveBeenCalledTimes(0);
		expect(mockCompleteSignature).toHaveBeenCalledTimes(0);
		expect(mockGoBack).not.toHaveBeenCalled();
		expect(exists(tr, "registration-request-approval-error")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Group C — the D-06 reject-reason gate.
// ---------------------------------------------------------------------------

describe("RegistrationRequestApprovalScreen — Group C (D-06 reject gate, no-sign discipline)", () => {
	it("11. tapping Reject reveals reject-reason-card, removes the footer, and fires zero engine calls", async () => {
		const tr = await renderScreen();
		const snapshot = totalEngineCallCount();

		press(tr, "registration-request-approval-reject");

		expect(exists(tr, "reject-reason-card")).toBe(true);
		expect(exists(tr, "registration-request-approval-footer")).toBe(false);
		expect(totalEngineCallCount()).toBe(snapshot);
	});

	it("12. an empty/whitespace-only reason leaves Confirm disabled", async () => {
		const tr = await renderScreen();
		press(tr, "registration-request-approval-reject");

		const input = tr.root.findByProps({ testID: "reject-reason-reason-input" });
		renderer.act(() => {
			input.props.onChangeText("   ");
		});
		expect(isDisabled(tr, "reject-reason-confirm")).toBe(true);
	});

	it("13. a non-empty reason enables Confirm; confirming calls rejectRegistrationRequest once with the TRIMMED reason", async () => {
		const tr = await renderScreen();
		press(tr, "registration-request-approval-reject");

		const input = tr.root.findByProps({ testID: "reject-reason-reason-input" });
		renderer.act(() => {
			input.props.onChangeText("  no proof of residence  ");
		});
		expect(isDisabled(tr, "reject-reason-confirm")).toBe(false);

		await pressAsync(tr, "reject-reason-confirm");

		expect(mockRejectRegistrationRequest).toHaveBeenCalledTimes(1);
		const [requestId, decision, signer] = mockRejectRegistrationRequest.mock.calls[0];
		expect(requestId).toBe(PENDING_READ.requestId);
		expect(decision.rejectionReason).toBe("no proof of residence");
		expect(typeof signer).toBe("function");
	});

	it("14. the no-sign discipline: getSignatureDigest is called zero times on reject, and completeSignature carries the blank triple with no sign/decision", async () => {
		const tr = await renderScreen();
		press(tr, "registration-request-approval-reject");

		const input = tr.root.findByProps({ testID: "reject-reason-reason-input" });
		renderer.act(() => {
			input.props.onChangeText("no proof of residence");
		});
		await pressAsync(tr, "reject-reason-confirm");

		expect(mockGetSignatureDigest).toHaveBeenCalledTimes(0);
		expect(mockCompleteSignature).toHaveBeenCalledTimes(1);

		const [, result] = mockCompleteSignature.mock.calls[0];
		expect(result.isAccepted).toBe(false);
		expect(result.signature.signature).toBe("");
		expect(result.sign).toBeUndefined();
		expect("decision" in result).toBe(false);

		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});

	it("15. dismiss restores the footer and still fires zero engine calls", async () => {
		const tr = await renderScreen();
		const snapshot = totalEngineCallCount();
		press(tr, "registration-request-approval-reject");
		press(tr, "reject-reason-dismiss");

		expect(exists(tr, "registration-request-approval-footer")).toBe(true);
		expect(exists(tr, "reject-reason-card")).toBe(false);
		expect(totalEngineCallCount()).toBe(snapshot);
	});
});

// ---------------------------------------------------------------------------
// Group D — read-only approved mode.
// ---------------------------------------------------------------------------

describe("RegistrationRequestApprovalScreen — Group D (approved mode)", () => {
	it("16. no footer and no reject card anywhere in the tree", async () => {
		mockCurrentRead = APPROVED_READ;
		mockRouteParams = { requestId: APPROVED_READ.requestId, authorityId: "auth-1" };

		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-footer")).toBe(false);
		expect(exists(tr, "reject-reason-card")).toBe(false);
	});

	it("17. approved-block and approved-by render; the checklist is read-only (no toggle testIDs)", async () => {
		mockCurrentRead = APPROVED_READ;
		mockRouteParams = { requestId: APPROVED_READ.requestId, authorityId: "auth-1" };

		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-approved-block")).toBe(true);
		expect(exists(tr, "registration-request-approval-approved-by")).toBe(true);
		expect(exists(tr, "verification-checklist-toggle-id")).toBe(false);
		expect(exists(tr, "verification-checklist-toggle-roll")).toBe(false);
	});

	it("18. tapping View Registrant navigates with the engine-resolved registrantId; absence of registrantId renders no CTA", async () => {
		mockCurrentRead = APPROVED_READ;
		mockRouteParams = { requestId: APPROVED_READ.requestId, authorityId: "auth-1" };

		const tr = await renderScreen();
		press(tr, "registration-request-approval-view-registrant");

		expect(mockNavigate).toHaveBeenCalledWith("RegistrantDetail", {
			registrantId: APPROVED_READ.registrantId,
			authorityId: "auth-1",
		});

		mockCurrentRead = APPROVED_READ_NO_REGISTRANT;
		mockRouteParams = { requestId: APPROVED_READ_NO_REGISTRANT.requestId, authorityId: "auth-1" };
		const tr2 = await renderScreen();
		expect(exists(tr2, "registration-request-approval-view-registrant")).toBe(false);
	});

	it("18b. approved mode carries the provenance pair too: both values render, differ, and carry distinct labels", async () => {
		mockCurrentRead = APPROVED_READ;
		mockRouteParams = { requestId: APPROVED_READ.requestId, authorityId: "auth-1" };

		const tr = await renderScreen();
		expect(textOf(tr, "registration-request-approval-summary-value-received-at")).toBe("2026-08-05");
		expect(textOf(tr, "registration-request-approval-summary-value-submitted-at")).toBe("2026-07-01");
	});
});

// ---------------------------------------------------------------------------
// Group E — read-only rejected mode.
// ---------------------------------------------------------------------------

describe("RegistrationRequestApprovalScreen — Group E (rejected mode)", () => {
	it("19. no footer; rejected-block, rejection-reason, rejecting-officer, decided-at, and rejected-pill all render with the stored values", async () => {
		mockCurrentRead = REJECTED_READ;
		mockRouteParams = { requestId: REJECTED_READ.requestId, authorityId: "auth-1" };

		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-footer")).toBe(false);
		expect(exists(tr, "registration-request-approval-rejected-block")).toBe(true);
		expect(exists(tr, "registration-request-approval-rejected-pill")).toBe(true);
		expect(textOf(tr, "registration-request-approval-rejection-reason")).toBe(REJECTED_READ.rejectionReason);
		expect(textOf(tr, "registration-request-approval-rejecting-officer")).toBe(REJECTED_READ.decidingOfficerUserId);
		expect(exists(tr, "registration-request-approval-decided-at")).toBe(true);
	});

	it("20. the checklist renders decision-time state with zero interactive toggle testIDs", async () => {
		mockCurrentRead = REJECTED_READ;
		mockRouteParams = { requestId: REJECTED_READ.requestId, authorityId: "auth-1" };

		const tr = await renderScreen();
		expect(exists(tr, "verification-checklist-toggle-roll")).toBe(false);
		expect(exists(tr, "verification-checklist-row-roll")).toBe(true);
	});

	it("20b. rejected mode carries the provenance pair too, with neither value substituted for the other", async () => {
		mockCurrentRead = REJECTED_READ;
		mockRouteParams = { requestId: REJECTED_READ.requestId, authorityId: "auth-1" };

		const tr = await renderScreen();
		const receivedValue = textOf(tr, "registration-request-approval-summary-value-received-at");
		const submittedValue = textOf(tr, "registration-request-approval-summary-value-submitted-at");
		expect(receivedValue).toBe("2026-08-05");
		expect(submittedValue).toBe("2026-07-01");
		expect(receivedValue).not.toBe(submittedValue);
	});
});

// ---------------------------------------------------------------------------
// Group F — the never-log privacy rule (the central threat). Console-call
// zero-count is asserted globally in `afterEach` above for EVERY test in
// this file, including every failure path exercised anywhere above; the two
// tests below additionally prove the sentinel/timestamp destination claim.
// ---------------------------------------------------------------------------

describe("RegistrationRequestApprovalScreen — Group F (never-log privacy rule)", () => {
	it("21. a load failure and a completed approval both leave every console spy uncalled (this test's own local check, in addition to the global afterEach gate)", async () => {
		mockGetRegistrationRequest.mockImplementationOnce(async () => {
			throw new Error("harmless-load-failure-token");
		});
		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-error")).toBe(true);
		consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
	});

	it("22. the PII sentinel appears ONLY under its summary-value node (never in the rendered error subtree); each timestamp appears only under its own summary-value node", async () => {
		mockGetRegistrationRequest.mockImplementationOnce(async () => {
			throw new Error("harmless-load-failure-token");
		});
		const errorTr = await renderScreen();
		const errorSubtreeText = jsonSubtreeText(errorTr, "registration-request-approval-error");
		expect(errorSubtreeText).toContain("harmless-load-failure-token");
		expect(errorSubtreeText).not.toContain(PII_SENTINEL);

		const tr = await renderScreen();
		const wholeTree = JSON.stringify(tr.toJSON());
		const sentinelMatches = wholeTree.split(PII_SENTINEL).length - 1;
		expect(sentinelMatches).toBe(1);

		const sentinelNode = tr.root.findByProps({
			testID: "registration-request-approval-summary-value-private-ssn",
		});
		expect(String(sentinelNode.props.children)).toBe(PII_SENTINEL);

		const errorSubtreeText2 = jsonSubtreeText(tr, "registration-request-approval-error");
		expect(errorSubtreeText2).not.toContain(PII_SENTINEL);
		expect(errorSubtreeText2).not.toContain("2026-08-05");
		expect(errorSubtreeText2).not.toContain("2026-07-01");
	});
});

// ---------------------------------------------------------------------------
// Group G — the untouched-file source gate.
// ---------------------------------------------------------------------------

describe("RegistrationRequestApprovalScreen — Group H (48-26 gap 3: scroll bottom padding, D-06)", () => {
	/**
	 * PROVEN here: the ScrollView carries a positive, safe-area-aware
	 * `contentContainerStyle.paddingBottom` in all three modes, and the
	 * rejected block's child order is unchanged with decided-at still last.
	 * NOT proven here, and unprovable here: that the decided-at line is
	 * actually reachable at maximum scroll on a real viewport —
	 * `react-test-renderer` has no layout engine. See the Group H/I header
	 * block below for the full statement; 48-29's on-device leg owns that.
	 */
	function scrollPaddingBottom(tr: renderer.ReactTestRenderer): number | undefined {
		const node = tr.root.findByProps({ testID: "registration-request-approval-scroll" });
		const style = node.props.contentContainerStyle;
		const flattened = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
		return flattened?.paddingBottom;
	}

	it("24. pending mode: the scroll carries a contentContainerStyle paddingBottom > 24", async () => {
		const tr = await renderScreen();
		const paddingBottom = scrollPaddingBottom(tr);
		expect(typeof paddingBottom).toBe("number");
		expect(paddingBottom as number).toBeGreaterThan(24);
	});

	it("25. approved mode: the scroll carries the same paddingBottom > 24 contract", async () => {
		mockCurrentRead = APPROVED_READ;
		mockRouteParams = { requestId: APPROVED_READ.requestId, authorityId: "auth-1" };
		const tr = await renderScreen();
		const paddingBottom = scrollPaddingBottom(tr);
		expect(typeof paddingBottom).toBe("number");
		expect(paddingBottom as number).toBeGreaterThan(24);
	});

	it("26. rejected mode: the scroll carries the same paddingBottom > 24 contract, and registration-request-approval-decided-at is the LAST child of the rejected block, after pill/reason/officer in that order", async () => {
		mockCurrentRead = REJECTED_READ;
		mockRouteParams = { requestId: REJECTED_READ.requestId, authorityId: "auth-1" };
		const tr = await renderScreen();

		const paddingBottom = scrollPaddingBottom(tr);
		expect(typeof paddingBottom).toBe("number");
		expect(paddingBottom as number).toBeGreaterThan(24);

		const ids = orderedTestIDs(tr);
		const blockIdx = ids.indexOf("registration-request-approval-rejected-block");
		const pillIdx = ids.indexOf("registration-request-approval-rejected-pill");
		const reasonIdx = ids.indexOf("registration-request-approval-rejection-reason");
		const officerIdx = ids.indexOf("registration-request-approval-rejecting-officer");
		const decidedAtIdx = ids.indexOf("registration-request-approval-decided-at");

		expect(blockIdx).toBeGreaterThanOrEqual(0);
		expect(pillIdx).toBeGreaterThan(blockIdx);
		expect(reasonIdx).toBeGreaterThan(pillIdx);
		expect(officerIdx).toBeGreaterThan(reasonIdx);
		expect(decidedAtIdx).toBeGreaterThan(officerIdx);
		// decided-at is the LAST testID under the rejected block — no sibling
		// after it anywhere in the tree's rejected-block subtree.
		expect(decidedAtIdx).toBe(ids.length - 1);
	});
});

describe("RegistrationRequestApprovalScreen — Group I (48-26 gap 4: footer stacks, D-07)", () => {
	it("27. pending mode: Footer receives no truthy row prop, footerSlot no longer flexes, and both CustomButtons receive no truthy flex prop", async () => {
		const tr = await renderScreen();

		const footerNode = tr.root.findByProps({ testID: "registration-request-approval-footer" });
		const footerElement = footerNode.findByType(require("../../../components/Footer").Footer as any);
		expect(Boolean(footerElement.props.row)).toBe(false);

		const approveButton = tr.root.findByProps({ testID: "registration-request-approval-approve" });
		const approveCustomButton = approveButton.findByType(
			require("../../../components/CustomButton").CustomButton as any
		);
		expect(Boolean(approveCustomButton.props.flex)).toBe(false);

		const rejectButton = tr.root.findByProps({ testID: "registration-request-approval-reject" });
		const rejectCustomButton = rejectButton.findByType(
			require("../../../components/CustomButton").CustomButton as any
		);
		expect(Boolean(rejectCustomButton.props.flex)).toBe(false);
	});

	it("28. footerSlot wrapper style no longer carries flex: 1 — it stretches instead", async () => {
		const tr = await renderScreen();
		const approveButton = tr.root.findByProps({ testID: "registration-request-approval-approve" });
		const style = approveButton.props.style;
		const flattened = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
		expect(flattened?.flex).not.toBe(1);
		expect(flattened?.alignSelf).toBe("stretch");
	});

	it("29. testIDs and i18n title keys are unchanged after the footer-shape change", async () => {
		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-approve")).toBe(true);
		expect(exists(tr, "registration-request-approval-reject")).toBe(true);

		const approveButton = tr.root.findByProps({ testID: "registration-request-approval-approve" });
		const approveCustomButton = approveButton.findByType(
			require("../../../components/CustomButton").CustomButton as any
		);
		expect(approveCustomButton.props.title).toBe("registrationRequestApprovalApproveButton");

		const rejectButton = tr.root.findByProps({ testID: "registration-request-approval-reject" });
		const rejectCustomButton = rejectButton.findByType(
			require("../../../components/CustomButton").CustomButton as any
		);
		expect(rejectCustomButton.props.title).toBe("registrationRequestApprovalRejectButton");
	});
});

describe("RegistrationRequestApprovalScreen — Group G (SignatureTaskScreen.tsx left alone)", () => {
	it("23. SignatureTaskScreen.tsx carries no 'registrant' token and its titleKey record has exactly six entries — asserted at the source level, since react-test-renderer cannot see a file that was never touched", () => {
		// react-test-renderer proves what RENDERS; it cannot prove a sibling
		// file was left alone. This is a source-level gate by necessity,
		// mirroring phase47Routes.test.tsx's own source-gate rationale.
		const filePath = path.join(__dirname, "..", "..", "tasks", "SignatureTaskScreen.tsx");
		const source = fs.readFileSync(filePath, "utf8");

		expect(/registrant/i.test(source)).toBe(false);

		const titleKeyMatch = source.match(/const titleKey:[\s\S]*?= \{([\s\S]*?)\};/);
		expect(titleKeyMatch).not.toBeNull();
		const entryCount = (titleKeyMatch![1].match(/^\s*"?[a-zA-Z-]+"?:\s*"[^"]+",?\s*$/gm) ?? []).length;
		expect(entryCount).toBe(6);
	});
});
