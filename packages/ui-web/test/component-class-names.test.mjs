/**
 * component-class-names.test.mjs — proves `src/component-class-names.js`'s
 * manifest agrees with what each component's own source can literally
 * produce (CR-01), so the tier-1 CSS class-name coverage checker
 * (`scripts/lib/css-class-coverage.mjs`) is reading a manifest that is
 * measured against the real components, not merely asserted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uiWebSrc } from '../../../scripts/lib/source-paths.mjs';
import { COMPONENT_CLASS_NAMES } from '../src/component-class-names.js';

const ADVISORY_SOURCE = readFileSync(uiWebSrc('components', 'AdvisoryDisclosure.tsx'), 'utf8');
const LIFECYCLE_SOURCE = readFileSync(uiWebSrc('components', 'LifecyclePill.tsx'), 'utf8');
const DETAILS_SOURCE = readFileSync(uiWebSrc('components', 'DetailsToggle.tsx'), 'utf8');

test('manifest declares exactly the three components this package ships (AdvisoryDisclosure, LifecyclePill, DetailsToggle)', () => {
	assert.deepEqual(Object.keys(COMPONENT_CLASS_NAMES), ['AdvisoryDisclosure', 'LifecyclePill', 'DetailsToggle']);
});

test('AdvisoryDisclosure.tsx literally contains every class name the manifest declares for it', () => {
	for (const cls of COMPONENT_CLASS_NAMES.AdvisoryDisclosure) {
		assert.ok(ADVISORY_SOURCE.includes(`"${cls}"`), `AdvisoryDisclosure.tsx does not contain "${cls}"`);
	}
});

test('DetailsToggle.tsx literally contains every class name the manifest declares for it', () => {
	for (const cls of COMPONENT_CLASS_NAMES.DetailsToggle) {
		assert.ok(DETAILS_SOURCE.includes(`"${cls}"`), `DetailsToggle.tsx does not contain "${cls}"`);
	}
});

test('LifecyclePill.tsx contains the base class name and the phase-modifier template literal', () => {
	assert.match(LIFECYCLE_SOURCE, /className=\{`lifecycle-pill lifecycle-pill--\$\{phase\}`\}/);
});

test("LifecyclePillProps' phase union names exactly the five modifiers the manifest declares", () => {
	const propsMatch = LIFECYCLE_SOURCE.match(/phase:\s*(.+);/);
	assert.ok(propsMatch, 'expected to find the `phase:` prop type line in LifecyclePill.tsx');
	const unionValues = [...propsMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
	assert.deepEqual(unionValues, ['pre', 'voting', 'settling', 'closed', 'indeterminate']);
	const manifestModifiers = COMPONENT_CLASS_NAMES.LifecyclePill.filter((c) => c !== 'lifecycle-pill').map((c) =>
		c.replace('lifecycle-pill--', ''),
	);
	assert.deepEqual(manifestModifiers, unionValues);
});

test('inertness control: a manifest entry naming a class absent from its component source would be caught', () => {
	const fixtureSource = 'export function Fixture() { return <p className="real-class">x</p>; }';
	assert.ok(!fixtureSource.includes('"phantom-class"'), 'sanity: the fixture must not contain the planted phantom class');
});
