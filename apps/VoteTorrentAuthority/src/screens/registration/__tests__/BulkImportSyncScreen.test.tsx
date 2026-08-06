/**
 * BulkImportSyncScreen.test.tsx — D-01/D-11 proofs for the Bulk Import / Sync screen.
 *
 * DECLARED BLIND SPOT: this suite proves the screen's composition, ordering, seam invocation, and
 * PII discipline (T-48-20-01, T-48-20-02, T-48-20-05). It proves NOTHING about the peer-cluster
 * transport itself, whose leg ships **code-complete, unverified** — a green run here must never be
 * cited as verification for it. It also proves nothing about whether an approving officer actually
 * holds `'vrg'`: that gate is a legibility control, not enforcement (Phase 999.1), and this suite's
 * "disabled, not hidden" assertions describe presentation only.
 *
 * 48-23 UPDATE — Suite C: through 48-20, `SyncBindingId` excluded `'peer'` and the peer card's
 * `onTrySync` was the literal `INERT_PEER_SYNC` no-op — pressing it could invoke NOTHING, by
 * construction. 48-23 widens `SyncBindingId` to admit `'peer'` and routes the peer card's press
 * through `runSync('peer')` against the seam. Suite C below is rewritten to the POST-widening
 * truth: the peer control resolves nothing (because no host in this repo registers a `'peer'`
 * binding) and never reaches the filesystem or REST bindings, and the peer card's warning
 * treatment and experimental body copy survive a real bridge succeeding, a real bridge failing,
 * AND a peer sync attempt. The peer-cluster leg itself remains **code-complete, unverified**
 * throughout — nothing in this file verifies it, and a green assertion below proves only that the
 * seam resolved (or failed to resolve) a handle, never that the peer-cluster protocol works.
 *
 * PATTERN SOURCE: `RegistrantsListScreen.test.tsx` (mock preamble, press/present/absent/treeText
 * helpers) and `TransportStatusCard.test.tsx` (sentinel color palette, host-node testID filtering,
 * serializeSubtree for substring assertions against an arbitrary rendered subtree).
 */

import React from "react";
import renderer from "react-test-renderer";

// ---------------------------------------------------------------------------
// Mutable module-level slots. Prefixed `mock` so babel-plugin-jest-hoist allows the jest.mock()
// factories below to close over them despite being declared outside the factory's own scope.
// ---------------------------------------------------------------------------

let mockRouteParams: { authorityId: string } = { authorityId: "auth-1" };

let mockScopesResult: { scopes: string[] | undefined; loading: boolean } = {
	scopes: ["vrg"],
	loading: false,
};

// Sentinel palette — visually impossible, uniquely greppable color strings so a color assertion is
// an exact substring match rather than a judgement call (mirrors TransportStatusCard.test.tsx).
const SENTINEL_COLORS = {
	primary: "#PRIMAR0",
	background: "#BACKGR0",
	card: "#CARD000",
	text: "#TEXT000",
	border: "#BORDER0",
	notification: "#NOTIFY0",
	error: "#ERROR00",
	textSecondary: "#MUTED00",
	important: "#IMPORT0",
	success: "#SUCCES0",
	accent: "#ACCENT0",
	warning: "#WARN000",
	dark: "#DARK000",
	light: "#LIGHT00",
};

// ---------------------------------------------------------------------------
// Module mocks — module scope, before any import of the screen. Copied in shape from
// RegistrantsListScreen.test.tsx:56-70.
// ---------------------------------------------------------------------------

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({ colors: SENTINEL_COLORS }),
	useRoute: () => ({ params: mockRouteParams }),
}));

// t() echoes its key, and `key + "|" + "k1=v1,k2=v2"` (unquoted) when an options object is
// present — the rendered string is itself embedded inside JSON.stringify(tr.toJSON()) for
// tree-text assertions, and a quoted value would be double-escaped by that outer stringify.
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && Object.keys(options).length > 0
				? key +
				  "|" +
				  Object.entries(options)
						.map(([k, v]) => k + "=" + String(v))
						.join(",")
				: key,
	}),
}));

jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: () => mockScopesResult,
}));

// ---------------------------------------------------------------------------
// The model — plain TypeScript, no mocked dependency of its own, safe to import directly.
// ---------------------------------------------------------------------------

import {
	clearSyncBindings,
	registerSyncBinding,
	resolveSyncBinding,
	resolveTransportCardState,
	toSyncErrorRefs,
	INERT_PEER_SYNC,
	type TransportSyncReport,
} from "../bulk-import-sync-model";

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
	// Required lazily, at test-runtime, AFTER every jest.mock() factory and every `mock`-prefixed
	// slot above has already been assigned — mirrors RegistrantsListScreen.test.tsx's own
	// `renderScreen()` convention exactly, avoiding any import-order hazard against the mocks.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { BulkImportSyncScreen } = require("../BulkImportSyncScreen");

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<BulkImportSyncScreen />);
	});
	await flushTicks(2);
	return tr;
}

/** Fires the real handler on a control reachable under `testID`. Asserting a non-empty candidate
 * list BEFORE firing turns a renamed/restructured control into a loud failure instead of a
 * silent no-op pass. */
async function press(tr: renderer.ReactTestRenderer, testID: string): Promise<void> {
	const wrapper = tr.root.findByProps({ testID });
	const candidates = wrapper.findAll((node) => typeof node.props.onPress === "function");
	expect(candidates.length).toBeGreaterThan(0);
	await renderer.act(async () => {
		candidates[0]!.props.onPress();
	});
	await flushTicks(4);
}

function present(tr: renderer.ReactTestRenderer, testID: string): void {
	expect(() => tr.root.findByProps({ testID })).not.toThrow();
}

function absent(tr: renderer.ReactTestRenderer, testID: string): void {
	expect(() => tr.root.findByProps({ testID })).toThrow();
}

function treeText(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}

/** `ReactTestInstance` has no `.toJSON()` (only the top-level renderer does) — walks a subtree and
 * concatenates each node's non-`children` props (JSON-stringified) plus leaf text, so substring
 * assertions can run against an arbitrary subtree. Mirrors TransportStatusCard.test.tsx. */
function serializeSubtree(node: renderer.ReactTestInstance): string {
	const parts: string[] = [];
	function visit(n: renderer.ReactTestInstance | string): void {
		if (typeof n === "string") {
			parts.push(n);
			return;
		}
		const { children: _children, ...rest } = n.props;
		try {
			parts.push(JSON.stringify(rest));
		} catch {
			// Non-serializable prop bag — skip, the leaf text/other props still get walked.
		}
		n.children.forEach(visit);
	}
	visit(node);
	return parts.join("|");
}

const BLOCK_TEST_IDS = [
	"bulk-import-sync-error",
	"transport-status-card-filesystem",
	"transport-status-card-rest",
	"transport-status-card-p2p",
	"bulk-import-sync-errors-section",
];

/** Collects, IN RENDER ORDER, every host-node testID from `BLOCK_TEST_IDS` present in the tree. */
function orderedBlockIds(tr: renderer.ReactTestRenderer): string[] {
	return tr.root
		.findAll(
			(node) => typeof node.type === "string" && BLOCK_TEST_IDS.includes(node.props.testID),
		)
		.map((n) => n.props.testID as string);
}

function report(overrides: Partial<TransportSyncReport> = {}): TransportSyncReport {
	return {
		syncedAt: "2026-08-05T12:00:00Z",
		imported: 3,
		pending: 1,
		errorItemIds: [],
		...overrides,
	};
}

beforeEach(() => {
	// Deliberately NOT jest.resetModules(): the screen is required lazily inside renderScreen()
	// and, un-reset, resolves through the SAME cached `bulk-import-sync-model` module instance
	// this file imports at the top — so a binding registered here is visible to the screen's own
	// `resolveSyncBinding` calls. Resetting modules would split that into two separate registries.
	clearSyncBindings();
	mockRouteParams = { authorityId: "auth-1" };
	mockScopesResult = { scopes: ["vrg"], loading: false };
});

// ---------------------------------------------------------------------------
// Suite A — the fixed render order (the centerpiece of the D-11 claim on this screen).
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — fixed render order (D-01/D-11)", () => {
	it("peer card renders below both proven bindings, always", async () => {
		registerSyncBinding({
			id: "filesystem",
			syncNow: jest.fn(async () => report({ errorItemIds: ["req-0001"] })),
		});
		registerSyncBinding({
			id: "rest",
			syncNow: jest.fn(async () => report({ errorItemIds: ["req-0009"] })),
		});
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");

		expect(orderedBlockIds(tr)).toEqual(BLOCK_TEST_IDS);
	});

	it("ordering holds even when the peer card is the only card with anything to say", async () => {
		// Both real transports stay in their `never` state (nothing registered, nothing synced),
		// and no errors section renders — proves ordering is not a side effect of one transport
		// having data.
		const tr = await renderScreen();

		expect(orderedBlockIds(tr)).toEqual([
			"bulk-import-sync-error",
			"transport-status-card-filesystem",
			"transport-status-card-rest",
			"transport-status-card-p2p",
		]);
	});
});

// ---------------------------------------------------------------------------
// Suite B — the Filesystem and REST cards are wired to real bindings.
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — Filesystem/REST cards invoke a real attached binding", () => {
	for (const id of ["filesystem", "rest"] as const) {
		it(`Sync Now (${id}) calls the attached binding exactly once and drives the card to success`, async () => {
			const syncNow = jest.fn(async () => report());
			registerSyncBinding({ id, syncNow });
			const tr = await renderScreen();

			await press(tr, `transport-sync-now-${id}`);

			expect(syncNow).toHaveBeenCalledTimes(1);
			present(tr, `transport-status-${id}-success-heading`);
			present(tr, `transport-status-counts-${id}`);
		});

		it(`Sync Now (${id}) moves the card to error and swallows the rejection's text (T-48-20-02)`, async () => {
			const syncNow = jest.fn(async () => {
				throw new Error("SSN-123-45-6789-LEAKED");
			});
			registerSyncBinding({ id, syncNow });
			const tr = await renderScreen();

			await press(tr, `transport-sync-now-${id}`);

			present(tr, `transport-status-${id}-error-heading`);
			expect(treeText(tr)).not.toContain("SSN-123-45-6789-LEAKED");
		});

		it(`Sync Now (${id}) with no binding registered renders the error variant without throwing`, async () => {
			const tr = await renderScreen();

			await expect(press(tr, `transport-sync-now-${id}`)).resolves.not.toThrow();

			present(tr, `transport-status-${id}-error-heading`);
		});
	}
});

// ---------------------------------------------------------------------------
// Suite C — the peer card's control is wired through the seam (48-23), and its experimental
// treatment is unchanged by that (the D-11 proof at the screen level).
//
// Through 48-20, this suite proved the peer control invoked NOTHING and left the tree
// byte-identical. 48-23 wires the control through `runSync('peer')`, so that specific claim is no
// longer true and is not silenced here — it is replaced by the narrower, still-true claims below:
// the control never reaches the filesystem or REST bindings, an attached peer binding's rejection
// text never reaches the tree, and the card's warning treatment survives every combination of
// outcome. The peer-cluster leg itself remains **code-complete, unverified** throughout — none of
// these assertions is evidence that the peer-cluster protocol works.
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — the peer card's control is wired, its treatment is unchanged (D-11)", () => {
	it("transport-status-card-p2p is present when both real transports are unregistered", async () => {
		const tr = await renderScreen();
		present(tr, "transport-status-card-p2p");
	});

	it("transport-status-card-p2p is present after both real transports have synced successfully", async () => {
		registerSyncBinding({ id: "filesystem", syncNow: jest.fn(async () => report()) });
		registerSyncBinding({ id: "rest", syncNow: jest.fn(async () => report()) });
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");
		present(tr, "transport-status-card-p2p");
	});

	it("48-23: with no peer binding registered, pressing the peer control resolves nothing, throws nothing, and never reaches the filesystem or REST bindings", async () => {
		const filesystemSyncNow = jest.fn(async () => report());
		const restSyncNow = jest.fn(async () => report());
		registerSyncBinding({ id: "filesystem", syncNow: filesystemSyncNow });
		registerSyncBinding({ id: "rest", syncNow: restSyncNow });
		const tr = await renderScreen();

		await expect(press(tr, "transport-try-peer-sync-p2p")).resolves.not.toThrow();

		// The peer control never reaches another transport's binding — the seam resolves 'peer'
		// independently of 'filesystem'/'rest', and nothing in this repo registers a 'peer' handle.
		expect(filesystemSyncNow).not.toHaveBeenCalled();
		expect(restSyncNow).not.toHaveBeenCalled();
	});

	it("48-23: an attached peer binding's rejection is called exactly once and its text never reaches the tree (T-48-20-02 holds for the third binding)", async () => {
		const peerSyncNow = jest.fn(async () => {
			throw new Error("SSN-123-45-6789-LEAKED");
		});
		registerSyncBinding({ id: "peer", syncNow: peerSyncNow });
		const tr = await renderScreen();

		await expect(press(tr, "transport-try-peer-sync-p2p")).resolves.not.toThrow();

		expect(peerSyncNow).toHaveBeenCalledTimes(1);
		expect(treeText(tr)).not.toContain("SSN-123-45-6789-LEAKED");
	});

	it("a real bridge succeeding, and a peer sync attempt of either outcome, do not soften the peer card's warning treatment", async () => {
		registerSyncBinding({ id: "filesystem", syncNow: jest.fn(async () => report()) });
		registerSyncBinding({ id: "rest", syncNow: jest.fn(async () => report()) });
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");
		// No peer binding attached here — a peer press resolves to the honest { failed: true }
		// no-binding path, which is itself a "peer sync attempt" outcome the card must survive.
		await press(tr, "transport-try-peer-sync-p2p");

		const peerCard = tr.root.findByProps({ testID: "transport-status-card-p2p" });
		const serialized = serializeSubtree(peerCard);
		expect(serialized).toContain(SENTINEL_COLORS.warning);
		expect(serialized).toContain("bulkImportSyncP2pBody");
	});

	it("48-23: the same warning treatment survives an ATTACHED peer binding succeeding", async () => {
		registerSyncBinding({ id: "filesystem", syncNow: jest.fn(async () => report()) });
		registerSyncBinding({ id: "rest", syncNow: jest.fn(async () => report()) });
		registerSyncBinding({ id: "peer", syncNow: jest.fn(async () => report()) });
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");
		await press(tr, "transport-try-peer-sync-p2p");

		const peerCard = tr.root.findByProps({ testID: "transport-status-card-p2p" });
		const serialized = serializeSubtree(peerCard);
		expect(serialized).toContain(SENTINEL_COLORS.warning);
		expect(serialized).toContain("bulkImportSyncP2pBody");
	});

	it("the ordered block-testID array equality from Suite A still holds with a peer binding attached", async () => {
		registerSyncBinding({
			id: "filesystem",
			syncNow: jest.fn(async () => report({ errorItemIds: ["req-0001"] })),
		});
		registerSyncBinding({
			id: "rest",
			syncNow: jest.fn(async () => report({ errorItemIds: ["req-0009"] })),
		});
		registerSyncBinding({ id: "peer", syncNow: jest.fn(async () => report()) });
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");
		await press(tr, "transport-try-peer-sync-p2p");

		expect(orderedBlockIds(tr)).toEqual(BLOCK_TEST_IDS);
	});

	it("INERT_PEER_SYNC itself is a no-op that returns undefined and throws nothing — retained across the widening for the assertion that documents it (48-20 Suite F still applies)", () => {
		expect(() => expect(INERT_PEER_SYNC()).toBeUndefined()).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Suite D — the errors section renders identifiers only (T-48-20-02).
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — the errors section is identifier-only", () => {
	it("renders exactly three rows, filesystem before rest, identifier + heading only", async () => {
		registerSyncBinding({
			id: "filesystem",
			syncNow: jest.fn(async () => report({ errorItemIds: ["req-0001", "req-0002"] })),
		});
		registerSyncBinding({
			id: "rest",
			syncNow: jest.fn(async () => report({ errorItemIds: ["req-0009"] })),
		});
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");

		present(tr, "bulk-import-sync-errors-section");

		const rowIds = ["bulk-import-sync-error-row-0", "bulk-import-sync-error-row-1", "bulk-import-sync-error-row-2"];
		for (const id of rowIds) present(tr, id);
		absent(tr, "bulk-import-sync-error-row-3");

		const row0 = serializeSubtree(tr.root.findByProps({ testID: "bulk-import-sync-error-row-0" }));
		const row1 = serializeSubtree(tr.root.findByProps({ testID: "bulk-import-sync-error-row-1" }));
		const row2 = serializeSubtree(tr.root.findByProps({ testID: "bulk-import-sync-error-row-2" }));

		expect(row0).toContain("req-0001");
		expect(row0).toContain("bulkImportSyncFilesystemHeading");
		expect(row1).toContain("req-0002");
		expect(row1).toContain("bulkImportSyncFilesystemHeading");
		expect(row2).toContain("req-0009");
		expect(row2).toContain("bulkImportSyncRestHeading");

		// Filesystem rows precede rest rows: neither filesystem row mentions the rest heading key,
		// and the rest row does not mention the filesystem heading key.
		expect(row0).not.toContain("bulkImportSyncRestHeading");
		expect(row1).not.toContain("bulkImportSyncRestHeading");
		expect(row2).not.toContain("bulkImportSyncFilesystemHeading");

		// Identifier only: no row carries the report's syncedAt value or its imported/pending
		// counts inside its own subtree.
		for (const row of [row0, row1, row2]) {
			expect(row).not.toContain("2026-08-05T12:00:00Z");
			expect(row).not.toContain("bulkImportSyncImportedCountLabel");
			expect(row).not.toContain("bulkImportSyncPendingCountLabel");
		}
	});

	it("is absent when both transports report empty errorItemIds", async () => {
		registerSyncBinding({ id: "filesystem", syncNow: jest.fn(async () => report()) });
		registerSyncBinding({ id: "rest", syncNow: jest.fn(async () => report()) });
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");

		absent(tr, "bulk-import-sync-errors-section");
	});
});

// ---------------------------------------------------------------------------
// Suite E — disabled, not hidden. Legibility control, NOT a security boundary (Phase 999.1).
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — write controls render disabled, not hidden", () => {
	it("a real officer without 'vrg' (scopes: []) sees all three controls, disabled, and the scoped banner", async () => {
		mockScopesResult = { scopes: [], loading: false };
		const filesystemSyncNow = jest.fn(async () => report());
		registerSyncBinding({ id: "filesystem", syncNow: filesystemSyncNow });
		const tr = await renderScreen();

		for (const id of [
			"transport-sync-now-filesystem",
			"transport-sync-now-rest",
			"transport-try-peer-sync-p2p",
		]) {
			present(tr, id);
			const wrapper = tr.root.findByProps({ testID: id });
			const disabledNodes = wrapper.findAll((node) => node.props.disabled === true);
			expect(disabledNodes.length).toBeGreaterThanOrEqual(1);
		}

		expect(treeText(tr)).toContain("registrationRequestScopeReadOnlyBanner");
		expect(treeText(tr)).not.toContain("registrationRequestScopeReadOnlyNoOfficerBanner");

		// This is a legibility control, not a security boundary: firing a disabled Sync Now must
		// still invoke no binding.
		const wrapper = tr.root.findByProps({ testID: "transport-sync-now-filesystem" });
		const disabledNode = wrapper.findAll((node) => node.props.disabled === true)[0]!;
		await renderer.act(async () => {
			disabledNode.props.onPress?.();
		});
		await flushTicks(4);
		expect(filesystemSyncNow).not.toHaveBeenCalled();
	});

	it("a device that is not a registered officer (scopes: undefined) sees the no-officer banner, controls disabled", async () => {
		mockScopesResult = { scopes: undefined, loading: false };
		const tr = await renderScreen();

		for (const id of [
			"transport-sync-now-filesystem",
			"transport-sync-now-rest",
			"transport-try-peer-sync-p2p",
		]) {
			present(tr, id);
			const wrapper = tr.root.findByProps({ testID: id });
			const disabledNodes = wrapper.findAll((node) => node.props.disabled === true);
			expect(disabledNodes.length).toBeGreaterThanOrEqual(1);
		}

		expect(treeText(tr)).toContain("registrationRequestScopeReadOnlyNoOfficerBanner");
		expect(treeText(tr)).not.toContain("registrationRequestScopeReadOnlyBanner|");
	});
});

// ---------------------------------------------------------------------------
// Suite F — bulk-import-sync-model as a pure unit (no rendering).
// ---------------------------------------------------------------------------

describe("bulk-import-sync-model — pure unit", () => {
	afterEach(() => {
		clearSyncBindings();
	});

	describe("resolveTransportCardState", () => {
		it("{} -> never, every other member undefined", () => {
			expect(resolveTransportCardState({})).toEqual({ syncState: "never" });
		});

		it("{ failed: true } -> error, undefined counts", () => {
			expect(resolveTransportCardState({ failed: true })).toEqual({
				syncState: "error",
				lastSyncedAt: undefined,
				importedCount: undefined,
				pendingCount: undefined,
				errorCount: undefined,
			});
		});

		it("{ failed: true, report } -> error, retaining the report's values", () => {
			const r = report({ errorItemIds: ["a", "b"] });
			expect(resolveTransportCardState({ failed: true, report: r })).toEqual({
				syncState: "error",
				lastSyncedAt: r.syncedAt,
				importedCount: r.imported,
				pendingCount: r.pending,
				errorCount: 2,
			});
		});

		it("{ report } -> success, errorCount === report.errorItemIds.length", () => {
			const r = report({ errorItemIds: ["a"] });
			expect(resolveTransportCardState({ report: r })).toEqual({
				syncState: "success",
				lastSyncedAt: r.syncedAt,
				importedCount: r.imported,
				pendingCount: r.pending,
				errorCount: 1,
			});
		});
	});

	describe("toSyncErrorRefs", () => {
		it("fixed filesystem-before-rest ordering across both transports", () => {
			const refs = toSyncErrorRefs({
				rest: report({ errorItemIds: ["r1"] }),
				filesystem: report({ errorItemIds: ["f1"] }),
			});
			expect(refs.map((r) => r.transport)).toEqual(["filesystem", "rest"]);
		});

		it("preserves within-transport order", () => {
			const refs = toSyncErrorRefs({
				filesystem: report({ errorItemIds: ["f1", "f2", "f3"] }),
			});
			expect(refs.map((r) => r.itemId)).toEqual(["f1", "f2", "f3"]);
		});

		it("returns [] for empty input", () => {
			expect(toSyncErrorRefs({})).toEqual([]);
		});

		it("every returned ref has exactly the keys transport and itemId (the runtime PII gate)", () => {
			const refs = toSyncErrorRefs({ filesystem: report({ errorItemIds: ["f1"] }) });
			expect(Object.keys(refs[0]!).sort()).toEqual(["itemId", "transport"]);
		});
	});

	describe("registerSyncBinding / resolveSyncBinding / clearSyncBindings", () => {
		it("round-trips a registration", () => {
			const handle = { id: "filesystem" as const, syncNow: jest.fn(async () => report()) };
			registerSyncBinding(handle);
			expect(resolveSyncBinding("filesystem")).toBe(handle);
		});

		it("clearSyncBindings makes a previously registered id resolve undefined", () => {
			registerSyncBinding({ id: "rest", syncNow: jest.fn(async () => report()) });
			clearSyncBindings();
			expect(resolveSyncBinding("rest")).toBeUndefined();
		});
	});

	describe("INERT_PEER_SYNC", () => {
		it("returns undefined and throws nothing", () => {
			expect(INERT_PEER_SYNC()).toBeUndefined();
		});
	});
});

// ---------------------------------------------------------------------------
// Suite G — source-level bundling gates. `react-test-renderer` cannot see what a module DOESN'T
// import, so this reads the source files at test time and asserts the forbidden strings are
// absent. Prevents a later executor "wiring up" the screen by importing the filesystem transport
// directly, which would drag `node:fs` into the Metro bundle — a failure class jest is
// structurally blind to (jest runs on Node, where the import resolves fine) and that this project
// has already paid for (Phase 44's `@peculiar` device-boot wall).
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen / bulk-import-sync-model — source-level bundling gates", () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const fs = require("fs");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const path = require("path");

	function stripComments(source: string): string {
		return source
			.split("\n")
			.filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
			.join("\n");
	}

	const FILES = {
		screen: path.join(__dirname, "..", "BulkImportSyncScreen.tsx"),
		model: path.join(__dirname, "..", "bulk-import-sync-model.ts"),
	};

	it("BUNDLING-GATE-OK: neither file imports @votetorrent/vote-engine, node:, require(, or either transport module", () => {
		for (const [, filePath] of Object.entries(FILES)) {
			const code = stripComments(fs.readFileSync(filePath, "utf8"));
			for (const bad of [
				"@votetorrent/vote-engine",
				"node:",
				"require(",
				"filesystem-registration-transport",
				"rest-registration-transport",
			]) {
				expect(code).not.toContain(bad);
			}
		}
	});

	it("the screen contains no console.* call (a transport error message must never reach a log)", () => {
		const code = stripComments(fs.readFileSync(FILES.screen, "utf8"));
		expect(code).not.toContain("console.");
	});
});
