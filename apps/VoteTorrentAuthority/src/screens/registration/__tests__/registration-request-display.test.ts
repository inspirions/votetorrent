/**
 * registration-request-display.test.ts — pure unit spec for the
 * registration-request display vocabulary (D-03/D-06). No `react-test-renderer`,
 * no RN module mocks — nothing in the module under test touches React Native.
 */

import {
	REGISTRATION_REQUEST_STATUS_META,
	registrationRequestDisplayName,
	resolveBridgeLabel,
	formatRequestTimestamp,
	resolveRowTimestamps,
} from "../registration-request-display";

describe("REGISTRATION_REQUEST_STATUS_META", () => {
	it("has exactly three entries with the correct label/color mapping", () => {
		expect(Object.keys(REGISTRATION_REQUEST_STATUS_META).sort()).toEqual(["a", "p", "r"]);
		expect(REGISTRATION_REQUEST_STATUS_META.p).toEqual({
			labelKey: "registrationRequestStatusPending",
			colorKey: "warning",
		});
		expect(REGISTRATION_REQUEST_STATUS_META.a).toEqual({
			labelKey: "registrationRequestStatusApproved",
			colorKey: "success",
		});
		expect(REGISTRATION_REQUEST_STATUS_META.r).toEqual({
			labelKey: "registrationRequestStatusRejected",
			colorKey: "error",
		});
	});
});

describe("registrationRequestDisplayName", () => {
	it("last + first -> 'Last, First'", () => {
		expect(registrationRequestDisplayName({ requestId: "x", lastName: "Doe", firstName: "Jane" })).toBe(
			"Doe, Jane",
		);
	});

	it("last only", () => {
		expect(registrationRequestDisplayName({ requestId: "x", lastName: "Doe" })).toBe("Doe");
	});

	it("first only", () => {
		expect(registrationRequestDisplayName({ requestId: "x", firstName: "Jane" })).toBe("Jane");
	});

	it("whitespace-only last, first present -> first wins (whitespace-only treated as absent)", () => {
		expect(registrationRequestDisplayName({ requestId: "x", lastName: "  ", firstName: "Jane" })).toBe("Jane");
	});

	it("no name, no requesterKey -> truncated requestId", () => {
		expect(registrationRequestDisplayName({ requestId: "req-abcdefgh" })).toBe("req-a...");
	});

	it("no name, requesterKey present -> truncated requesterKey takes priority over requestId", () => {
		expect(
			registrationRequestDisplayName({ requestId: "req-abcdefgh", requesterKey: "keyABCDEFGH" }),
		).toBe("keyAB...");
	});

	it("whitespace-only requesterKey falls through to truncated requestId", () => {
		expect(registrationRequestDisplayName({ requestId: "req-abcdefgh", requesterKey: "   " })).toBe(
			"req-a...",
		);
	});
});

describe("resolveBridgeLabel", () => {
	it("neither bridgeLabel nor bridgeId -> undefined", () => {
		expect(resolveBridgeLabel({})).toBeUndefined();
	});

	it("bridgeLabel present -> trimmed label", () => {
		expect(resolveBridgeLabel({ bridgeLabel: " County Clerk " })).toBe("County Clerk");
	});

	it("whitespace-only bridgeLabel with bridgeId -> falls back to truncated bridgeId", () => {
		expect(resolveBridgeLabel({ bridgeLabel: "  ", bridgeId: "bridge-1234567" })).toBe("bridg...");
	});

	it("no bridgeLabel, bridgeId only -> truncated bridgeId", () => {
		expect(resolveBridgeLabel({ bridgeId: "bridge-1234567" })).toBe("bridg...");
	});
});

describe("formatRequestTimestamp", () => {
	it("formats an ISO-Z string to YYYY-MM-DD", () => {
		expect(formatRequestTimestamp("2026-08-05T10:00:00Z")).toBe("2026-08-05");
	});

	it("returns an unparseable string unchanged and never throws", () => {
		expect(() => formatRequestTimestamp("not-a-date")).not.toThrow();
		expect(formatRequestTimestamp("not-a-date")).toBe("not-a-date");
	});
});

describe("resolveRowTimestamps", () => {
	it("identical instants -> claimed is undefined, received is the formatted value", () => {
		const result = resolveRowTimestamps({
			receivedAt: "2026-08-05T10:00:00Z",
			submittedAt: "2026-08-05T10:00:00Z",
		});
		expect(result).toEqual({ received: "2026-08-05" });
		expect(result.claimed).toBeUndefined();
	});

	it("same calendar date, different clock times -> claimed is undefined (equal at rendered precision)", () => {
		const result = resolveRowTimestamps({
			receivedAt: "2026-08-05T10:00:00Z",
			submittedAt: "2026-08-05T02:00:00Z",
		});
		expect(result.received).toBe("2026-08-05");
		expect(result.claimed).toBeUndefined();
	});

	it("different calendar dates -> claimed is defined, not equal to received, each derived from its own field", () => {
		const result = resolveRowTimestamps({
			receivedAt: "2026-08-05T10:00:00Z",
			submittedAt: "2026-07-01T09:00:00Z",
		});
		expect(result.received).toBe("2026-08-05");
		expect(result.claimed).toBe("2026-07-01");
		expect(result.claimed).not.toBe(result.received);
	});

	it("backdated claim (30 days before, 48-07's extreme) -> older value in claimed, newer in received, never swapped", () => {
		const result = resolveRowTimestamps({
			receivedAt: "2026-08-05T10:00:00Z",
			submittedAt: "2026-07-06T10:00:00Z",
		});
		expect(result.received).toBe("2026-08-05");
		expect(result.claimed).toBe("2026-07-06");
	});
});
