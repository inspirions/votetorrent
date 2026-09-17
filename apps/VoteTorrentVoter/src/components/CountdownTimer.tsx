/**
 * CountdownTimer (HOME-01, D-09) — presentational, self-ticking live countdown rendered from a
 * fixed ISO target. First `setInterval`/`AppState` component in this codebase (RESEARCH.md
 * Pattern 2, PATTERNS.md §CountdownTimer — copied verbatim in structure).
 *
 * Drift-free by construction: every tick recomputes `remaining(targetIso)` from `Date.now()`
 * rather than decrementing a held counter (Pattern 2 / Pitfall 2) — so it neither drifts against
 * real elapsed time nor goes stale while the app is backgrounded (JS timers suspend in the
 * background; the `AppState` listener forces an immediate resync on return to `'active'`).
 *
 * Pure presentational (`targetIso: string`, optional `nowOffsetMs?: number`) — does NOT call
 * `useVoterApp()` (RESEARCH.md Anti-Patterns: keep provider reads confined to screens, not this
 * leaf component).
 *
 * `nowOffsetMs` (D-14, dev-instrumentation): optional, defaults to `0`, inert in release builds.
 * It shifts the reference clock from a bare `Date.now()` to `Date.now() + nowOffsetMs`, letting
 * the Timeline's `__DEV__` clock-offset control move this countdown's reference clock in step
 * with the rail's own `nowMs`. It arrives by prop only — never a provider read (Phase 59 D-20).
 */
import React, {useEffect, useState} from 'react';
import {AppState, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';

/**
 * WR-09: returns `null` for a `targetIso` this component cannot parse. Previously an unparsable
 * value produced `NaN`, which `format()` then padded into a literal `NaN : NaN : NaN` -- and
 * because `'NaN'.length === 3`, `maxDigits > 2` selected the SMALLER `h2` shrink step, so the
 * failure rendered as a legitimately shrunken long countdown rather than as an error.
 */
function remaining(targetIso: string, nowOffsetMs = 0): number | null {
	const targetMs = new Date(targetIso).getTime();
	if (!Number.isFinite(targetMs)) return null;
	return Math.max(0, targetMs - (Date.now() + nowOffsetMs));
}

/** D2 root-cause fix: adaptive units at the 24h boundary, discriminated union. */
type FormattedCountdown =
	| {unit: 'long'; days: string; hours: string; minutes: string}
	| {unit: 'short'; hours: string; minutes: string; seconds: string};

function format(ms: number): FormattedCountdown {
	const totalSeconds = Math.floor(ms / 1000);
	const pad = (n: number) => String(n).padStart(2, '0');

	// 86400 = seconds in a day — the exact D2 discriminant. totalSeconds === 86400 picks 'long';
	// totalSeconds === 86399 picks 'short'.
	if (totalSeconds >= 86400) {
		const days = Math.floor(totalSeconds / 86400);
		// Hours/minutes bounded 0-23 / 0-59 because the >=86400 case is routed away first — this
		// bound is D2's root-cause fix (was unbounded Math.floor(totalSeconds / 3600)).
		const hours = Math.floor((totalSeconds % 86400) / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		return {unit: 'long', days: String(days), hours: pad(hours), minutes: pad(minutes)};
	}

	// hours is bounded 0-23 here because the >=86400 case above already routed away anything
	// larger — no seconds group is dropped, this branch keeps today's derivation exactly.
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return {unit: 'short', hours: pad(hours), minutes: pad(minutes), seconds: pad(seconds)};
}

export function CountdownTimer({targetIso, nowOffsetMs = 0}: {targetIso: string; nowOffsetMs?: number}) {
	const [remainingMs, setRemainingMs] = useState(() => remaining(targetIso, nowOffsetMs));
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('home');

	useEffect(() => {
		// Resync immediately whenever targetIso or nowOffsetMs changes (covers the effect's own
		// mount too). Omitting nowOffsetMs from the deps array below leaves the running interval on
		// a stale offset and reproduces the "label and countdown disagree" defect D-13 closes.
		setRemainingMs(remaining(targetIso, nowOffsetMs));
		const id = setInterval(() => setRemainingMs(remaining(targetIso, nowOffsetMs)), 1000);

		// JS timers are suspended while the app is backgrounded (reactnative.dev/docs/appstate) —
		// force an immediate resync on return to 'active' instead of waiting for the next tick.
		const sub = AppState.addEventListener('change', state => {
			if (state === 'active') setRemainingMs(remaining(targetIso, nowOffsetMs));
		});

		return () => {
			clearInterval(id);
			sub.remove();
		};
	}, [targetIso, nowOffsetMs]);

	// WR-09: render nothing rather than a NaN countdown. Consistent with TimelineRail's CR-02
	// guard -- degrade to "no countdown", never to a plausible-looking wrong one.
	if (remainingMs === null) return null;

	const formatted = format(remainingMs);

	// Shrink-to-fit (D2): derived after `groups` values are known, from the longest displayed
	// group only. Two steps only — type.display (2 digits or fewer) or type.h2 (more than 2) —
	// applied uniformly to every displayed group and the colons in a given render.
	const groups: Array<{value: string; labelKey: string; testId: string}> =
		formatted.unit === 'long'
			? [
					{value: formatted.days, labelKey: 'countdown.days', testId: 'days'},
					{value: formatted.hours, labelKey: 'countdown.hours', testId: 'hours'},
					{value: formatted.minutes, labelKey: 'countdown.minutes', testId: 'minutes'},
				]
			: [
					{value: formatted.hours, labelKey: 'countdown.hours', testId: 'hours'},
					{value: formatted.minutes, labelKey: 'countdown.minutes', testId: 'minutes'},
					{value: formatted.seconds, labelKey: 'countdown.seconds', testId: 'seconds'},
				];

	// CR-01: the shrink trigger used to be `maxDigits > 2` alone, and the step reached only the
	// digits. Both halves were wrong for the case that actually clips:
	//   1. In the `short` (<24h) branch every group is pad()'d to 2 chars, so maxDigits is ALWAYS
	//      2 and the shrink could never fire there at all.
	//   2. The LABELS, not the digits, are the widest element -- on the Redmi 8 the >=24h labels
	//      already span ~362px of a ~371px card inner width, and the `short` branch swaps the
	//      narrowest label (DAYS/DÍAS) for the widest (SECONDS/SEGUNDOS).
	// So the trigger now also counts label characters, and the step applies to labelStyle too.
	// The budget is the >=24h row's own 16 characters -- the widest label row device-verified to
	// fit (evidence/61-08-after-current-row-en.png). Anything wider than what has been measured to
	// fit must shrink, which keeps this correct for future locales rather than just for ES.
	const LABEL_CHAR_BUDGET = 16;
	const labels = groups.map(group => t(group.labelKey));
	const maxDigits = Math.max(...groups.map(group => group.value.length));
	const totalLabelChars = labels.reduce((sum, label) => sum + label.length, 0);
	const needsShrink = maxDigits > 2 || totalLabelChars > LABEL_CHAR_BUDGET;
	const shrinkStep = needsShrink ? typeScale.h2 : typeScale.display;
	const labelStep = needsShrink ? typeScale.captionSmall : typeScale.caption;

	const digitStyle = {
		fontFamily: fonts.regular.fontFamily,
		fontWeight: fonts.regular.fontWeight,
		fontSize: shrinkStep.fontSize,
		lineHeight: shrinkStep.lineHeight,
		color: colors.text,
	};
	const labelStyle = {
		fontFamily: fonts.regular.fontFamily,
		fontWeight: fonts.regular.fontWeight,
		fontSize: labelStep.fontSize,
		lineHeight: labelStep.lineHeight,
		color: colors.textSecondary,
	};

	return (
		<View style={styles.row}>
			{groups.map((group, index) => (
				<React.Fragment key={group.testId}>
					{index > 0 && <Text style={[digitStyle, styles.colon]}>:</Text>}
					<View style={styles.group}>
						<Text style={digitStyle} testID={`countdown-${group.testId}-value`}>
							{group.value}
						</Text>
						<Text style={[labelStyle, styles.label]} testID={`countdown-${group.testId}-label`}>
							{t(group.labelKey)}
						</Text>
					</View>
				</React.Fragment>
			))}
		</View>
	);
}

export default CountdownTimer;

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		alignItems: 'flex-start',
	},
	group: {
		alignItems: 'center',
		marginHorizontal: 4, // sm(8px) gap between groups == 4px on each side
	},
	// D-09 addendum (61-08, C3, developer-approved): marginTop 0 -> 4 (xs) -- `styles.row`'s
	// `alignItems: 'flex-start'` (untouched) top-aligns every group, so the shorter colon glyph
	// reads slightly high against the taller digit groups at the `display` step; this nudges it
	// toward the digits' optical middle. Shared with Home's `ElectionCard`.
	colon: {
		marginTop: 4,
	},
	label: {
		textTransform: 'uppercase',
		letterSpacing: 1,
		marginTop: 4, // xs(4px) gap to sub-labels
	},
});
