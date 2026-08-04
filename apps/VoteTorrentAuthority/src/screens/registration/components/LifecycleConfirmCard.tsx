import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { ThemedText } from "../../../components/ThemedText";
import { CustomButton } from "../../../components/CustomButton";
import { CustomTextInput } from "../../../components/CustomTextInput";
import { globalStyles } from "../../../theme/styles";

/**
 * LifecycleConfirmCard — the D-10 confirmation card, both variants, plus its
 * two exported pure gate predicates.
 *
 * Purpose: the registration engine is deliberately permissive (Phase 42
 * D-16 removed the transition guard, there is no undo, and a 'vrg'-signed
 * status change is effective the instant it commits). Nothing on the engine
 * side asks whether the officer meant to act — this card is the ONLY thing
 * standing between a misclick and a revoked voter registration. It has no
 * analog anywhere else in this app.
 *
 * Purely presentational: props in, callbacks out. Neither this file nor
 * `VerdictBadge.tsx` may import the vote-core package, the vote-engine
 * package, the engines layer, or navigation beyond `useTheme`/
 * `ExtendedTheme` — the type introduced by the sibling Phase 47 plan running
 * in this same wave would not resolve.
 *
 * All copy arrives already resolved via props (`title`/`body`/
 * `confirmLabel`/`dismissLabel`/`typedPlaceholder`) — the owning screen
 * calls `t()`, since eight distinct call sites bind eight different key
 * sets with different interpolation params.
 */

// A stable no-op for the (non-optional) CustomButton.onPress prop when a
// gate is unmet — belt-and-suspenders alongside `disabled` so no callback
// can fire even from a direct programmatic invocation of the handler, not
// just from a blocked touch event. Both button rows below wire this in
// addition to `disabled`.
const NOOP = () => {};

export type LifecycleConfirmVariant = "ordinary" | "typed";
export type LifecycleConfirmTone = "neutral" | "destructive";

/**
 * The single most important function in this plan — the entire D-10
 * typed-confirmation safeguard reduces to this comparison. Exact semantics,
 * in order, and deliberately narrow:
 *
 * 1. A blank `expected` (undefined, empty, or whitespace-only) returns
 *    `false` UNCONDITIONALLY. This is fail-closed and load-bearing: the
 *    display name a caller passes can fall back to a truncated record id,
 *    but if a caller ever passes an empty name, a naive implementation
 *    would let an EMPTY typed value satisfy the gate — and a single tap
 *    would revoke a registration.
 * 2. A blank `typed` (after trimming) returns `false`.
 * 3. Otherwise: trim both sides and compare with plain lowercasing only.
 *
 * Prohibited widenings — do not "improve" this function with any of the
 * following; an executor "improving" ergonomics here silently weakens the
 * only safeguard between a misclick and an irreversible signed change:
 * - Collapsing repeated internal whitespace (two spaces must not equal one).
 * - Any locale-sensitive case-folding method. Plain lowercasing is
 *   required — a host-locale-aware fold would be non-deterministic across
 *   devices under Hermes, making the gate itself unpredictable.
 * - Unicode normalization (NFC/NFD) or diacritic stripping. A
 *   precomposed-vs-decomposed mismatch must fail the gate — failing is the
 *   SAFE direction here, since the officer can simply retype.
 * - Punctuation stripping, prefix/substring/superstring matching, fuzzy or
 *   edit-distance matching, and no minimum-length shortcut.
 */
export function matchesConfirmationName(typed: string, expected: string | undefined): boolean {
	if (expected === undefined || expected.trim().length === 0) return false;
	if (typed.trim().length === 0) return false;
	return typed.trim().toLowerCase() === expected.trim().toLowerCase();
}

/**
 * Lowercase bare-acknowledgement labels the D-10 dismiss control must never
 * use, covering both shipped locales. A DENY-list, not an allow-list on a
 * "keep/mantener" pattern: an allow-list would reject a perfectly good
 * future label in a third locale, while a deny-list only ever flags the
 * specific failure D-10 names — a dismiss label that names nothing.
 */
export const BARE_DISMISS_LABELS: readonly string[] = [
	"cancel",
	"cancelar",
	"dismiss",
	"descartar",
	"close",
	"cerrar",
	"back",
	"atras",
	"atrás",
	"ok",
	"no",
];

export function isBareDismissLabel(label: string): boolean {
	return BARE_DISMISS_LABELS.includes(label.trim().toLowerCase());
}

type SubmitState = "idle" | "submitting" | "submitted";

export interface LifecycleConfirmCardProps {
	variant: LifecycleConfirmVariant;
	/** Ordinary variant only; ignored (always destructive) for the typed variant. */
	tone?: LifecycleConfirmTone;
	title: string;
	body: string;
	confirmLabel: string;
	dismissLabel: string;
	/** Typed variant only: the registrant's current display name. */
	matchText?: string;
	/** Typed variant only. */
	typedPlaceholder?: string;
	onConfirm: () => void | Promise<void>;
	onDismiss: () => void;
	testIDPrefix?: string;
}

export function LifecycleConfirmCard({
	variant,
	tone = "neutral",
	title,
	body,
	confirmLabel,
	dismissLabel,
	matchText,
	typedPlaceholder,
	onConfirm,
	onDismiss,
	testIDPrefix = "lifecycle-confirm",
}: LifecycleConfirmCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const [typedValue, setTypedValue] = useState("");
	const [submitState, setSubmitState] = useState<SubmitState>("idle");

	// __DEV__-only diagnostic, re-evaluated only when `dismissLabel` changes:
	// a build with a bare-acknowledgement dismiss label warns so the defect
	// is caught before it ships. This warns rather than throws — a throw
	// would white-screen the dev app on a locale whose translation happens
	// to collide. The real per-call-site enforcement is each consuming
	// plan's test asserting `isBareDismissLabel(t('<its key>')) === false`.
	// Only `dismissLabel` — a static translated UI string, never a
	// registrant name — may reach this diagnostic call.
	useEffect(() => {
		if (__DEV__ && isBareDismissLabel(dismissLabel)) {
			// eslint-disable-next-line no-console
			console.warn(
				`LifecycleConfirmCard: dismissLabel "${dismissLabel}" reads as a bare acknowledgement. Per D-10, the dismiss label must name what is kept (e.g. "Keep Current Status"), not just acknowledge dismissal.`,
			);
		}
	}, [dismissLabel]);

	// Typed variant is always destructive (Suspend/Revoke); `tone` is only
	// meaningful on the ordinary variant (Renew/Reinstate).
	const resolvedTone: LifecycleConfirmTone = variant === "typed" ? "destructive" : tone;

	// Exhaustive color matrix (variant/tone -> border/confirm/dismiss). A
	// warning-tinted treatment must never appear here — that token is
	// reserved this phase for the Play Console provisioning state only, and
	// using it on the neutral-ordinary row would misrepresent a routine
	// renewal as a flagged issue.
	const borderColor = resolvedTone === "destructive" ? colors.error : colors.border;
	const confirmBackground = resolvedTone === "destructive" ? colors.error : colors.accent;
	// Both variants' dismiss button is `colors.accent`. On the neutral row
	// this means confirm and dismiss share a background — CustomButton
	// exposes no opacity/outline lever for a tertiary treatment, so the
	// dismiss's "visually secondary" status is expressed by POSITION only:
	// dismiss renders first (left), confirm renders second (right). This is
	// a deliberate constraint, not an oversight.
	const dismissBackground = colors.accent;

	const canConfirm =
		submitState === "idle" && (variant === "ordinary" ? true : matchesConfirmationName(typedValue, matchText));

	// Three-state submit latch: idle -> submitting -> submitted. This app
	// has already shipped two double-press defects on signed writes; a
	// double-fired onConfirm here means two signed, immediately-effective,
	// un-undoable status changes. A resolved submit latches permanently
	// (the card's owner is expected to unmount it on success); a rejected
	// submit returns to idle so the officer can retry rather than being
	// stranded.
	async function handleConfirm() {
		if (submitState !== "idle" || !canConfirm) return;
		setSubmitState("submitting");
		try {
			await onConfirm();
			setSubmitState("submitted");
		} catch {
			setSubmitState("idle");
		}
	}

	// A dismissed confirmation performs ZERO engine work: this handler
	// invokes only `onDismiss`, never `onConfirm`, and never inspects or
	// clears the typed value. While a signed write is in flight the dismiss
	// control is also disabled — the write cannot be recalled, so an
	// enabled dismiss would misrepresent the outcome.
	function handleDismiss() {
		if (submitState !== "idle") return;
		onDismiss();
	}

	return (
		<View
			testID={`${testIDPrefix}-card`}
			style={[styles.cardSurface, { backgroundColor: colors.card, borderLeftWidth: 4, borderLeftColor: borderColor }]}
		>
			<ThemedText type="defaultSemiBold" testID={`${testIDPrefix}-title`}>
				{title}
			</ThemedText>
			<ThemedText type="default" testID={`${testIDPrefix}-body`}>
				{body}
			</ThemedText>

			{variant === "typed" && (
				<CustomTextInput
					testID={`${testIDPrefix}-typed-input`}
					placeholder={typedPlaceholder}
					value={typedValue}
					onChangeText={setTypedValue}
					autoCapitalize="none"
					autoCorrect={false}
					spellCheck={false}
				/>
			)}

			<View style={localStyles.buttonRow}>
				<View testID={`${testIDPrefix}-dismiss`}>
					<CustomButton
						size="thin"
						title={dismissLabel}
						backgroundColor={dismissBackground}
						disabled={submitState !== "idle"}
						onPress={submitState === "idle" ? handleDismiss : NOOP}
					/>
				</View>
				<View testID={`${testIDPrefix}-confirm`}>
					<CustomButton
						size="thin"
						title={confirmLabel}
						backgroundColor={confirmBackground}
						disabled={!canConfirm}
						onPress={canConfirm ? handleConfirm : NOOP}
					/>
				</View>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	buttonRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginTop: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
