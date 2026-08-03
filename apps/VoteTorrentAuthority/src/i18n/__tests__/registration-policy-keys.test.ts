/**
 * Phase 46 plan 46-03 (D-11) — registrationPolicy* i18n key-group proof.
 *
 * Renderer-free: imports only the exported `resources` object, no
 * react-test-renderer / @testing-library needed (neither is a dependency of
 * this app — see 46-03-PLAN.md's `read_first` note).
 *
 * A duplicate key inside a single object literal is silently collapsed by the
 * JS parser (the later entry wins, with no runtime trace) — this test alone
 * CANNOT detect that failure mode. The companion source-level `sort | uniq -d`
 * grep gate (see 46-03-PLAN.md's `<verify>`/acceptance criteria) is required
 * in addition to this test, not instead of it.
 */

import { resources } from '../index';

const enTranslation = resources.en.translation as Record<string, string>;
const esTranslation = resources.es.translation as Record<string, string>;

const REGISTRATION_POLICY_RE = /^registrationPolicy[A-Z]/;
const BARE_REGISTRATION_RE = /^registration(?!Policy)/;

describe('registrationPolicy* i18n key group (D-11)', () => {
	test('EN has exactly 54 registrationPolicy* keys, ES key set is deeply equal', () => {
		const enKeys = Object.keys(enTranslation).filter(k => REGISTRATION_POLICY_RE.test(k));
		const esKeys = Object.keys(esTranslation).filter(k => REGISTRATION_POLICY_RE.test(k));

		expect(enKeys).toHaveLength(54);
		expect(new Set(esKeys)).toEqual(new Set(enKeys));
		expect(esKeys).toHaveLength(54);
	});

	test('no registrationPolicy* value is empty or whitespace-only, in either locale', () => {
		const enKeys = Object.keys(enTranslation).filter(k => REGISTRATION_POLICY_RE.test(k));
		for (const key of enKeys) {
			expect(enTranslation[key]?.trim().length).toBeGreaterThan(0);
			expect(esTranslation[key]?.trim().length).toBeGreaterThan(0);
		}
	});

	test('the four pre-existing election-timeline keys survive byte-identical', () => {
		expect(enTranslation.registrationEnds).toBe('Registration Ends');
		expect(enTranslation.registrationOpens).toBe('Registration Opens');
		expect(enTranslation.registrationCloses).toBe('Registration Closes');
		expect(enTranslation.registrationDeadline).toBe('Registration Deadline');

		expect(esTranslation.registrationEnds).toBe('Finaliza Registro');
		expect(esTranslation.registrationOpens).toBe('Abre el Registro');
		expect(esTranslation.registrationCloses).toBe('Cierra el Registro');
		expect(esTranslation.registrationDeadline).toBe('Fecha Límite de Registro');
	});

	test('no new bare-registration* key exists beyond the four timeline names', () => {
		const allowed = new Set([
			'registrationEnds',
			'registrationOpens',
			'registrationCloses',
			'registrationDeadline',
		]);

		const enBareKeys = Object.keys(enTranslation).filter(k => BARE_REGISTRATION_RE.test(k));
		const esBareKeys = Object.keys(esTranslation).filter(k => BARE_REGISTRATION_RE.test(k));

		expect(new Set(enBareKeys)).toEqual(allowed);
		expect(new Set(esBareKeys)).toEqual(allowed);
	});

	test('registrationPolicyReadOnlyBanner carries the {{scope}} interpolation contract in both locales', () => {
		expect(enTranslation.registrationPolicyReadOnlyBanner).toContain('{{scope}}');
		expect(esTranslation.registrationPolicyReadOnlyBanner).toContain('{{scope}}');
	});
});
