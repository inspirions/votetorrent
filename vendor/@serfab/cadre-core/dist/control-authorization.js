/**
 * The single definition of the field vector every signed control-plane message
 * covers. Both producers of signed bytes — `control-database.ts`'s
 * `buildAuthorizationMessage` (raw digest bytes) and `peer-authorization.ts`'s
 * digest helpers (base64url digest strings) — build their vector here, so the
 * byte layout cannot drift between them or away from the SQL constraints in
 * `schemas/control.qsql`.
 *
 * Every vector leads with two fixed literals:
 *
 *   digest(<domain>, <action>, <row field 1>, ..., <row field n>)
 *
 * so a signature verifies ONLY against the one rule it was minted for. Without
 * the tags, several rules built byte-identical tuples (e.g. `ValidationKey`
 * insert and `OwnerKey` insert both signed `digest(Key, StampId)`), so an
 * approval for a narrow grant doubled as an approval for full ownership.
 *
 * This module deliberately has no Quereus / Optimystic / libp2p imports so the
 * lightweight verifiers (`peer-authorization.ts`, consumed by the offline
 * `cadre enroll register` check) can use it without pulling in the runtime.
 */
/**
 * Names of the CadreControl tables, in schema order. The single list: the
 * {@link ControlTable} union is derived from it and `ControlDatabase.countRows`
 * guards its dynamic `from` clause against it (keeping the table name off the
 * SQL-injection surface), so a new table cannot be added to one and missed in
 * the other.
 *
 * `Revocation` is here for the same two reasons as every other entry: it
 * derives a `'CadreControl.Revocation'` domain tag — its `Authorized` CHECK
 * verifies an owner signature over the `'remove'`-tagged digest that
 * `peer-authorization.ts`'s `revocationDigest` mints, and its `AuthorizedReissue`
 * CHECK the `'reissue'`-tagged digest `ControlDatabase.reissueRevocations`
 * signs — and `countRows` counts it.
 */
export const CONTROL_TABLES = [
    'OwnerKey',
    'ValidationKey',
    'Strand',
    'StrandPartyKey',
    'JoinedStrand',
    'CadrePeer',
    'DeviceToken',
    'FormationInvite',
    'FormationUsage',
    'Revocation',
];
/**
 * The full ordered field vector a control-plane signature covers. Digest this
 * with the crypto plugin's injective multi-field encoding (every field TEXT);
 * the SQL mirror passes the same literals as leading `digest(...)` arguments:
 *
 *   TS:  digest(controlAuthorizationFields('CadreControl.X', 'add', [a, b]), 'sha256', ...)
 *   SQL: digest('CadreControl.X', 'add', new.A, new.B)
 */
export function controlAuthorizationFields(domain, action, rowFields) {
    return [domain, action, ...rowFields];
}
//# sourceMappingURL=control-authorization.js.map