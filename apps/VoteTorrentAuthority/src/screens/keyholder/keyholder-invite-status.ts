import type { InviteStatus, SentKeyholderInvite } from "@votetorrent/vote-core";

export type KeyholderInviteState = "accepted" | "declined" | "pending";

/**
 * What a keyholder's `InviteStatus` can honestly say. The election engine's keyholder projection
 * (D-27) sets `result` ONLY from a real `Keyholder` row (the invitee ACCEPTED) or an
 * `InviteResult`. It carries no signal that an invite slot was sent. So `result` means
 * "responded", never "sent".
 *
 * The old UI read `Boolean(result)` as Sent/Unsent. The result: "Unsent" after two successful
 * sends, then "Sent" after the keyholder had actually accepted. Absent a result the honest state
 * is "pending" (not accepted yet, whether or not an invite went out).
 */
export function keyholderInviteState(status: InviteStatus<SentKeyholderInvite>): KeyholderInviteState {
	if (!status.result) return "pending";
	return status.result.isAccepted ? "accepted" : "declined";
}

/** i18n key + theme color key for a keyholder invite state. */
export const KEYHOLDER_INVITE_STATE_META: Record<
	KeyholderInviteState,
	{ labelKey: string; colorKey: "success" | "error" | "warning" }
> = {
	accepted: { labelKey: "accepted", colorKey: "success" },
	declined: { labelKey: "keyholderStatusDeclined", colorKey: "error" },
	pending: { labelKey: "pending", colorKey: "warning" },
};
