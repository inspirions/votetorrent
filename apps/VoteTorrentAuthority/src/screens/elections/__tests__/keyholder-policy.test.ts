import { validateKeyholderPolicy } from "../keyholder-policy";

describe("validateKeyholderPolicy", () => {
	it("refuses fewer than two keyholders", () => {
		expect(validateKeyholderPolicy(["A"], 1)).toEqual({ ok: false, reason: "too-few-keyholders" });
		expect(validateKeyholderPolicy([], 0)).toEqual({ ok: false, reason: "too-few-keyholders" });
	});
	it("refuses a threshold below 2", () => {
		expect(validateKeyholderPolicy(["A", "B"], 1)).toEqual({ ok: false, reason: "threshold-too-low" });
	});
	it("refuses a threshold above the keyholder count", () => {
		expect(validateKeyholderPolicy(["A", "B"], 3)).toEqual({ ok: false, reason: "threshold-above-count" });
	});
	it("accepts 2-of-2 and 2-of-3", () => {
		expect(validateKeyholderPolicy(["A", "B"], 2)).toEqual({ ok: true });
		expect(validateKeyholderPolicy(["A", "B", "C"], 2)).toEqual({ ok: true });
	});
});
