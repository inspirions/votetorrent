import type { InviteStatus, SentKeyholderInvite } from "@votetorrent/vote-core";
import { KEYHOLDER_INVITE_STATE_META, keyholderInviteState } from "../keyholder-invite-status";

type S = InviteStatus<SentKeyholderInvite>;
const inv = { name: "A" } as unknown as SentKeyholderInvite;
const exp = "2030-01-01T00:00:00";

describe("keyholderInviteState", () => {
	it("accepted result -> accepted, regardless of sent", () => {
		const s = { invite: inv, result: { isAccepted: true }, sent: { state: "no-longer-valid", expiration: exp } } as unknown as S;
		expect(keyholderInviteState(s)).toBe("accepted");
	});
	it("declined result -> declined", () => {
		const s = { invite: inv, result: { isAccepted: false }, sent: { state: "answered", expiration: exp } } as unknown as S;
		expect(keyholderInviteState(s)).toBe("declined");
	});
	it("live -> sent", () => {
		expect(keyholderInviteState({ invite: inv, sent: { state: "live", expiration: exp } } as S)).toBe("sent");
	});
	it("answered without a result (replication lag) -> sent", () => {
		expect(keyholderInviteState({ invite: inv, sent: { state: "answered", expiration: exp } } as S)).toBe("sent");
	});
	it("no-longer-valid -> expired", () => {
		expect(keyholderInviteState({ invite: inv, sent: { state: "no-longer-valid", expiration: exp } } as S)).toBe("expired");
	});
	it("no sent -> not-sent", () => {
		expect(keyholderInviteState({ invite: inv } as S)).toBe("not-sent");
	});
	it("META tones and labels", () => {
		expect(KEYHOLDER_INVITE_STATE_META.sent).toEqual({ labelKey: "keyholderStatusSent", colorKey: "warning" });
		expect(KEYHOLDER_INVITE_STATE_META.expired).toEqual({ labelKey: "keyholderStatusExpired", colorKey: "error" });
		expect(KEYHOLDER_INVITE_STATE_META["not-sent"]).toEqual({ labelKey: "keyholderStatusNotSent", colorKey: "warning" });
		expect(KEYHOLDER_INVITE_STATE_META.accepted.colorKey).toBe("success");
		expect(KEYHOLDER_INVITE_STATE_META.declined.colorKey).toBe("error");
	});
});
