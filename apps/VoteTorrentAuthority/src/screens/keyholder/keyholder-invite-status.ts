import type { InviteStatus, SentKeyholderInvite } from "@votetorrent/vote-core";

export type KeyholderInviteState = "accepted" | "declined" | "sent" | "expired" | "not-sent";

/**
 * What a keyholder's `InviteStatus` says. `result` is set only from a real `Keyholder` row (the
 * invitee ACCEPTED) or an `InviteResult`, so it means "responded". The election engine's keyholder
 * projection also reports `sent` (live | answered | no-longer-valid) read from the invitation
 * slots, which is what lets the officer see "Sent" before any response.
 *
 * - response wins: accepted / declined regardless of `sent`
 * - live, or answered without a visible result yet (replication lag): sent
 * - no-longer-valid (cancelled or expired): expired, send again
 * - no slot found: not sent
 */
export function keyholderInviteState(status: InviteStatus<SentKeyholderInvite>): KeyholderInviteState {
	if (status.result) return status.result.isAccepted ? "accepted" : "declined";
	switch (status.sent?.state) {
		case "live":
		case "answered":
			return "sent";
		case "no-longer-valid":
			return "expired";
		default:
			return "not-sent";
	}
}

/** i18n key + theme color key for a keyholder invite state. */
export const KEYHOLDER_INVITE_STATE_META: Record<
	KeyholderInviteState,
	{ labelKey: string; colorKey: "success" | "error" | "warning" }
> = {
	accepted: { labelKey: "accepted", colorKey: "success" },
	declined: { labelKey: "keyholderStatusDeclined", colorKey: "error" },
	sent: { labelKey: "keyholderStatusSent", colorKey: "warning" },
	expired: { labelKey: "keyholderStatusExpired", colorKey: "error" },
	"not-sent": { labelKey: "keyholderStatusNotSent", colorKey: "warning" },
};
