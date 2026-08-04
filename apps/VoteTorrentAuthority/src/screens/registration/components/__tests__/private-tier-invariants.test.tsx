/**
 * private-tier-invariants — the executable form of Phase 47's "private-tier
 * values are never logged" and "salts are never displayed" rules (D-01,
 * D-12, T-47-02).
 *
 * These assertions are STRUCTURAL, not behavioral — they pin the SOURCE of
 * `PrivateFieldRow.tsx` and `SelectiveAudiencePreview.tsx` so a later edit
 * that introduces a diagnostic log line or a raw-leaf render fails a
 * Phase-47-named test rather than surviving review. Part A reads the
 * component source (via `fs.readFileSync`, mirroring
 * `foundingOfficerScopes.test.ts`'s source-text-gate idiom) and strips line
 * and block comments before matching, so a header comment describing the
 * constraint can never accidentally self-satisfy the gate. Part B renders
 * both components together and asserts over the combined tree.
 */

import * as fs from "fs";
import * as path from "path";
import React from "react";
import renderer from "react-test-renderer";
import type { DisclosedSelective, SelectiveLeaf } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		dark: false,
		colors: {
			primary: "#007AFF",
			background: "#FFFFFF",
			card: "#F2F2F7",
			text: "#000000",
			border: "#C6C6C8",
			notification: "#FF3B30",
			error: "#FF3B30",
			textSecondary: "#888888",
			accent: "#5856D6",
			warning: "#FF9500",
			success: "#34C759",
			dark: "#000000",
			light: "#FFFFFF",
		},
	}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PrivateFieldRowModule = require("../PrivateFieldRow");
const PrivateFieldRow = PrivateFieldRowModule.PrivateFieldRow ?? PrivateFieldRowModule.default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SelectiveAudiencePreviewModule = require("../SelectiveAudiencePreview");
const SelectiveAudiencePreview =
	SelectiveAudiencePreviewModule.SelectiveAudiencePreview ?? SelectiveAudiencePreviewModule.default;

const PRIVATE_FIELD_ROW_PATH = path.join(__dirname, "../PrivateFieldRow.tsx");
const SELECTIVE_AUDIENCE_PREVIEW_PATH = path.join(__dirname, "../SelectiveAudiencePreview.tsx");

/**
 * Strips `//` line comments and `/* ... *\/` block comments (including
 * doc-comment header blocks) from a source string, so a prose mention of a
 * forbidden token inside a comment can never trip — or hide a trip of — a
 * gate meant to catch it in real code.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map(line => line.replace(/\/\/.*$/, ""))
		.join("\n");
}

function readStripped(filePath: string): string {
	return stripComments(fs.readFileSync(filePath, "utf8"));
}

const PRIVATE_SOURCE = readStripped(PRIVATE_FIELD_ROW_PATH);
const SELECTIVE_SOURCE = readStripped(SELECTIVE_AUDIENCE_PREVIEW_PATH);

describe("private-tier-invariants — Part A: source-text gates (D-01/D-12/T-47-02)", () => {
	it("neither private-tier component writes to the debug console", () => {
		expect((PRIVATE_SOURCE.match(/console\s*\./g) ?? []).length).toBe(0);
		expect((SELECTIVE_SOURCE.match(/console\s*\./g) ?? []).length).toBe(0);
	});

	it("PrivateFieldRow binds no value into a translated string", () => {
		expect((PRIVATE_SOURCE.match(/\bt\([^)]*,/g) ?? []).length).toBe(0);
	});

	it("PrivateFieldRow declares no error state and no serialization", () => {
		expect(PRIVATE_SOURCE).not.toMatch(/errorMessage/);
		expect(PRIVATE_SOURCE).not.toMatch(/\bcatch\b/);
		expect(PRIVATE_SOURCE).not.toMatch(/JSON\.stringify/);
		expect(PRIVATE_SOURCE).not.toMatch(/onError/);
	});

	it("PrivateFieldRow exposes no retraction callback (D-14)", () => {
		expect(PRIVATE_SOURCE).not.toMatch(/onHide/);
		expect(PRIVATE_SOURCE).not.toMatch(/onConceal/);
		expect(PRIVATE_SOURCE).not.toMatch(/onRetract/);
		expect(PRIVATE_SOURCE).not.toMatch(/onUnreveal/);
		expect(PRIVATE_SOURCE).not.toMatch(/onMask/);
	});

	it("PrivateFieldRow declares a 44x44 tap target", () => {
		expect(PRIVATE_SOURCE).toMatch(/minWidth:\s*44/);
		expect(PRIVATE_SOURCE).toMatch(/minHeight:\s*44/);
		expect(PRIVATE_SOURCE).toMatch(/hitSlop/);
	});

	it("SelectiveAudiencePreview never dereferences a salt or a hidden digest", () => {
		expect((SELECTIVE_SOURCE.match(/\.salt\b/g) ?? []).length).toBe(0);
		expect((SELECTIVE_SOURCE.match(/\.hidden\b/g) ?? []).length).toBe(0);
		expect((SELECTIVE_SOURCE.match(/SALT_KEY_PATTERN/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	it("neither component imports an engine, a scope hook, or navigation", () => {
		for (const source of [PRIVATE_SOURCE, SELECTIVE_SOURCE]) {
			expect(source).not.toMatch(/useCurrentOfficerScopes/);
			expect(source).not.toMatch(/useApp\b/);
			expect(source).not.toMatch(/EngineFactory/);
			expect(source).not.toMatch(/useNavigation/);
			expect(source).not.toMatch(/@votetorrent\/vote-engine/);
		}
	});
});

// ---------------------------------------------------------------------------
// Part B — rendered-tree gates
// ---------------------------------------------------------------------------

const SSN_SENTINEL = "123-45-6789";

const LEAVES: SelectiveLeaf[] = [
	{ name: "Address", value: "12 Elm St", salt: "SALT_SENTINEL_ADDRESS" },
	{ name: "Email", value: "a@b.test", salt: "SALT_SENTINEL_EMAIL" },
	{ name: "Phone", value: "555-0100", salt: "SALT_SENTINEL_PHONE" },
];

const DISCLOSURE: DisclosedSelective = {
	cid: "cid1",
	root: "root1",
	disclosed: LEAVES,
	hidden: ["HIDDEN_DIGEST_SENTINEL"],
};

function renderCombined() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<>
				<PrivateFieldRow name="SSN" value={SSN_SENTINEL} onReveal={jest.fn()} />
				<SelectiveAudiencePreview
					leaves={LEAVES}
					selectedAudience={undefined}
					disclosure={DISCLOSURE}
					onSelectAudience={jest.fn()}
				/>
			</>,
		);
	});
	return tr;
}

function pressPrivateToggle(tr: renderer.ReactTestRenderer) {
	const toggle = tr.root.findByProps({ testID: "private-field-toggle-SSN" });
	renderer.act(() => {
		toggle.props.onPress();
	});
}

function pressAudienceChip(tr: renderer.ReactTestRenderer, testID: string) {
	const wrapper = tr.root.findByProps({ testID });
	const pressable = wrapper.findAll(node => typeof node.props.onPress === "function")[0];
	renderer.act(() => {
		pressable.props.onPress();
	});
}

describe("private-tier-invariants — Part B: rendered-tree gates (D-01/D-12)", () => {
	it("a masked private value and every salt are absent from the combined rendered tree", () => {
		const tr = renderCombined();
		const json = JSON.stringify(tr.toJSON());

		expect(json).not.toContain(SSN_SENTINEL);
		expect(json).not.toContain("SALT_SENTINEL_ADDRESS");
		expect(json).not.toContain("SALT_SENTINEL_EMAIL");
		expect(json).not.toContain("SALT_SENTINEL_PHONE");
		expect(json).not.toContain("HIDDEN_DIGEST_SENTINEL");
	});

	it("revealing the private field surfaces exactly that one value and still no salt", () => {
		const tr = renderCombined();
		pressPrivateToggle(tr);

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain(SSN_SENTINEL);
		expect(json).not.toContain("SALT_SENTINEL_ADDRESS");
		expect(json).not.toContain("SALT_SENTINEL_EMAIL");
		expect(json).not.toContain("SALT_SENTINEL_PHONE");
		expect(json).not.toContain("HIDDEN_DIGEST_SENTINEL");
	});

	it("no console method is called across the full combined interaction", () => {
		const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});

		const tr = renderCombined();
		pressPrivateToggle(tr); // reveal
		pressAudienceChip(tr, "selective-audience-chip-everyone");
		pressPrivateToggle(tr); // re-mask

		for (const spy of [logSpy, warnSpy, errorSpy, infoSpy, debugSpy]) {
			expect(spy).toHaveBeenCalledTimes(0);
			spy.mockRestore();
		}
	});
});
