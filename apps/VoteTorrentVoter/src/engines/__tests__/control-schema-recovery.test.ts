/**
 * Spike 105: the predicate that lets CadreNodeProvider recreate ONLY an unmigratable control store.
 * The positive case is the exact error cadre-core 1.14 raised opening a 1.13 store (host repro in
 * .planning/spikes/105-control-schema-upgrade-boot, identical to the Pixel_8 session-1b logcat).
 */
import { isUnrestorableControlSchemaError } from '../control-schema-recovery';

const OBSERVED =
	"Failed to execute DDL: DROP TABLE IF EXISTS CadreControl.pendingjoin\n" +
	"Error: cannot drop table 'cadrecontrol.pendingjoin': it is referenced by CHECK constraint 'RowIsGone' on table 'Revocation' — drop or redefine it first\n" +
	'The schema could not be restored: the failing step `DROP TABLE IF EXISTS CadreControl.pendingjoin` cannot be undone';

// cadre-core 1.15 opening a 1.14 store (the CadrePeer `Profile` column): the outer error names the
// DDL, its cause only the module's refusal. Host repro: the spike-105 harness re-run on 1.15.0.
const OBSERVED_115_CAUSE = "Module for table 'CadrePeer' does not support ALTER TABLE ADD COLUMN";
const OBSERVED_115 = new Error(
	'Failed to execute DDL: ALTER TABLE CadreControl.CadrePeer ADD COLUMN Profile text null\nError: ' + OBSERVED_115_CAUSE,
	{ cause: new Error(OBSERVED_115_CAUSE) },
);

describe('isUnrestorableControlSchemaError', () => {
	it('matches the 1.13 -> 1.14 control-schema failure', () => {
		expect(isUnrestorableControlSchemaError(new Error(OBSERVED))).toBe(true);
	});

	it('matches it when it arrives as the cause of a wrapper error', () => {
		expect(isUnrestorableControlSchemaError(new Error('CadreNode start failed', { cause: new Error(OBSERVED) }))).toBe(true);
	});

	it('matches the 1.14 -> 1.15 control-schema failure (ALTER TABLE ADD COLUMN refused)', () => {
		expect(isUnrestorableControlSchemaError(OBSERVED_115)).toBe(true);
	});

	it.each([
		['a network failure', new Error('Relay reservation failed: NoValidAddressesError')],
		['a strand (App) schema refusal', new Error('The schema could not be restored: App.Registrant')],
		['a strand (App) ALTER refusal', new Error("Failed to execute DDL: ALTER TABLE App.Registrant ADD COLUMN Note text null\nError: Module for table 'Registrant' does not support ALTER TABLE ADD COLUMN")],
		['the module refusal without the CadreControl DDL around it', new Error(OBSERVED_115_CAUSE)],
		['a CadreControl write refusal that is not a migration', new Error('CHECK constraint failed: InsertValid on CadreControl.CadrePeer')],
		['a non-error value', 'boom'],
		['undefined', undefined],
	])('does not match %s', (_label, value) => {
		expect(isUnrestorableControlSchemaError(value)).toBe(false);
	});
});
