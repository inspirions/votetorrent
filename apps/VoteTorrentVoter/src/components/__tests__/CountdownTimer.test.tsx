/**
 * Unit tests for CountdownTimer (HOME-01, D-09) — first jest.useFakeTimers() consumer in this
 * app's test suite (RESEARCH.md §Wave 0 Gaps). Asserts the drift-free target-diff derivation:
 * recomputed from `targetIso` every tick, never a decrementing counter.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import {CountdownTimer} from '../CountdownTimer';
import {lightTheme} from '../../theme/themes';
import '../../i18n'; // initializes the global i18next instance useTranslation() reads from

/** ~2h/5m/2s in the future from a fixed reference "now". */
const NOW = new Date('2026-07-09T12:00:00.000Z').getTime();
const FUTURE_ISO = new Date(NOW + (2 * 3600 + 5 * 60 + 2) * 1000).toISOString();

/**
 * D2 adaptive-unit / shrink-to-fit fixtures — each derived from NOW so they stay deterministic
 * under jest.setSystemTime(NOW). See this plan's <contract> section for the locked format()
 * discriminated union.
 */
/** Honest ~30-day remainder (30d 04h 12m); renders '30' / '04' / '12'. Not the 4304h dev-control
 * artifact (D-12) — this is a Jest fixture built directly from a targetIso. */
const LONG_ISO = new Date(NOW + (30 * 86400 + 4 * 3600 + 12 * 60) * 1000).toISOString();
/** Exactly totalSeconds === 86400 — the >=24h branch boundary, days unpadded '1'. */
const BOUNDARY_AT_ISO = new Date(NOW + 86_400_000).toISOString();
/** Exactly totalSeconds === 86399 — the <24h branch boundary, no days group. */
const BOUNDARY_BELOW_ISO = new Date(NOW + 86_399_000).toISOString();
/** 179-day remainder — the only way to reach a 3-digit displayed group (long bounds hours 0-23,
 * minutes 0-59), driving the h2 shrink step. */
const LONG_3DIGIT_ISO = new Date(NOW + 179 * 86_400_000).toISOString();

/** useTheme() requires a ThemeProvider ancestor (@react-navigation/native) — wrap every render. */
function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

describe('CountdownTimer (HOME-01, D-09)', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(NOW);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('renders the correct HH:MM:SS three 2-digit groups on initial render', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={FUTURE_ISO} />));
		});
		const text = tr.root.findAll(node => typeof node.props.children === 'string')
			.map(node => node.props.children)
			.join(' ');
		expect(text).toContain('02');
		expect(text).toContain('05');
		expect(text).toContain('02');
	});

	it('decrements the seconds group by exactly 1 after one 1000ms tick (recomputed from target, not a decrementing counter)', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={FUTURE_ISO} />));
		});

		renderer.act(() => {
			jest.advanceTimersByTime(1000);
		});

		const seconds = tr.root.findByProps({testID: 'countdown-seconds-value'});
		expect(seconds.props.children).toBe('01');
	});

	it('renders 00:00:00 for a target in the past (Math.max(0, ...) floor, never negative)', () => {
		const pastIso = new Date(NOW - 60_000).toISOString();
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={pastIso} />));
		});
		const hours = tr.root.findByProps({testID: 'countdown-hours-value'});
		const minutes = tr.root.findByProps({testID: 'countdown-minutes-value'});
		const seconds = tr.root.findByProps({testID: 'countdown-seconds-value'});
		expect(hours.props.children).toBe('00');
		expect(minutes.props.children).toBe('00');
		expect(seconds.props.children).toBe('00');
	});

	it('resolves sub-labels from i18n keys countdown.hours/minutes/seconds', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={FUTURE_ISO} />));
		});
		const hoursLabel = tr.root.findByProps({testID: 'countdown-hours-label'});
		const minutesLabel = tr.root.findByProps({testID: 'countdown-minutes-label'});
		const secondsLabel = tr.root.findByProps({testID: 'countdown-seconds-label'});
		expect(hoursLabel.props.children).toBe('hours');
		expect(minutesLabel.props.children).toBe('minutes');
		expect(secondsLabel.props.children).toBe('seconds');
	});

	it('renders DAYS:HOURS:MINUTES with an unpadded days group and no seconds group at a 30d04h12m remainder (>=24h branch)', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={LONG_ISO} />));
		});
		expect(tr.root.findByProps({testID: 'countdown-days-value'}).props.children).toBe('30');
		expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('04');
		expect(tr.root.findByProps({testID: 'countdown-minutes-value'}).props.children).toBe('12');
		expect(tr.root.findByProps({testID: 'countdown-days-label'}).props.children).toBe('days');
		expect(tr.root.findAllByProps({testID: 'countdown-seconds-value'}).length).toBe(0);
	});

	it('picks the >=24h branch at exactly totalSeconds === 86400 (boundary, days is unpadded "1")', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={BOUNDARY_AT_ISO} />));
		});
		expect(tr.root.findByProps({testID: 'countdown-days-value'}).props.children).toBe('1');
		expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('00');
		expect(tr.root.findByProps({testID: 'countdown-minutes-value'}).props.children).toBe('00');
		expect(tr.root.findAllByProps({testID: 'countdown-seconds-value'}).length).toBe(0);
	});

	it('picks the <24h branch at exactly totalSeconds === 86399 (boundary, no days group)', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={BOUNDARY_BELOW_ISO} />));
		});
		expect(tr.root.findAllByProps({testID: 'countdown-days-value'}).length).toBe(0);
		expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('23');
		expect(tr.root.findByProps({testID: 'countdown-minutes-value'}).props.children).toBe('59');
		expect(tr.root.findByProps({testID: 'countdown-seconds-value'}).props.children).toBe('59');
	});

	it('shrink-to-fit keeps type.display (40/48) when the longest displayed group is <= 2 digits', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={LONG_ISO} />));
		});
		const days = tr.root.findByProps({testID: 'countdown-days-value'});
		const hours = tr.root.findByProps({testID: 'countdown-hours-value'});
		const minutes = tr.root.findByProps({testID: 'countdown-minutes-value'});
		for (const node of [days, hours, minutes]) {
			expect(node.props.style.fontSize).toBe(40);
			expect(node.props.style.lineHeight).toBe(48);
		}
	});

	it('shrink-to-fit steps down to type.h2 (28/34) when the longest displayed group is > 2 digits', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={LONG_3DIGIT_ISO} />));
		});
		const days = tr.root.findByProps({testID: 'countdown-days-value'});
		expect(days.props.children).toBe('179');
		const hours = tr.root.findByProps({testID: 'countdown-hours-value'});
		const minutes = tr.root.findByProps({testID: 'countdown-minutes-value'});
		for (const node of [days, hours, minutes]) {
			expect(node.props.style.fontSize).toBe(28);
			expect(node.props.style.lineHeight).toBe(34);
		}
	});

	it('nowOffsetMs (not Date.now()) sets the reference clock, and a changed nowOffsetMs resyncs immediately', () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(withTheme(<CountdownTimer targetIso={FUTURE_ISO} nowOffsetMs={0} />));
		});
		expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('02');

		renderer.act(() => {
			tr.update(withTheme(<CountdownTimer targetIso={FUTURE_ISO} nowOffsetMs={3_600_000} />));
		});
		expect(tr.root.findByProps({testID: 'countdown-hours-value'}).props.children).toBe('01');
		expect(tr.root.findByProps({testID: 'countdown-minutes-value'}).props.children).toBe('05');
	});
});
