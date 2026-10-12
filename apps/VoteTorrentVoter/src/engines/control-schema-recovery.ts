/**
 * control-schema-recovery.ts — spike 105.
 *
 * cadre-core refuses to migrate a control store written by a build with OLDER constraint text: its
 * declarative apply diffs to DDL the optimystic module refuses, Quereus takes the apply back, and
 * `CadreNode.start()` rejects on every launch ("policy: recreate", cadre-core's
 * `ControlDatabase.loadSchema`). Measured 1.13 -> 1.14: `DROP TABLE IF EXISTS
 * CadreControl.pendingjoin` is refused because `Revocation.RowIsGone` still references it.
 *
 * The control store holds no Voter data that cannot come back by sync: the Voter never runs owner
 * genesis, and its networks live in per-strand stores. So the recovery is to recreate ONLY the
 * control scope (`controlStorageScope(partyId)`, which is `control-<hex(partyId)>`, not
 * `control`) and start once more.
 */

function errorChain(e: unknown): string {
	const parts: string[] = [];
	for (let x: unknown = e; x != null && parts.length < 6; x = (x as { cause?: unknown }).cause) {
		parts.push(x instanceof Error ? x.message : String(x));
	}
	return parts.join(' <- ');
}

/** True only for a CadreControl schema that can be neither migrated nor restored. */
export function isUnrestorableControlSchemaError(e: unknown): boolean {
	const text = errorChain(e);
	return /CadreControl\./i.test(text)
		&& /could not be restored|partially migrated|cannot drop table|drop constraint/i.test(text);
}
