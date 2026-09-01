/**
 * registrations.js -- the `vrg` read surface, the deepest of the three
 * (39% of the whole authorization surface, 16 of 41 enforcement sites over
 * 12 tables). RULE R4 and inherited-spec item 4 apply exactly as documented
 * at the top of `./elections.js`.
 *
 * RULE R3 (column allowlist, counts never contents for the private tiers):
 * this module NEVER selects `RegistrantPrivate.PrivateDetails` (schema
 * comment: "never disclosed"), `RegistrantSelective.SelectiveDetails`
 * (salted leaves -- disclosure is a per-election policy decision, not a
 * dashboard one), `RegistrationRequest.Payload` / `.PayloadCid`,
 * `RegistrantPublic.ExtraFields` (unbounded authority-specific keys), or
 * any `AssociationPrivate` payload column. Those five tables are reached
 * by `select count(*)` ONLY, inside `readRegistrationSurfaceCounts` below.
 *
 * FINDING (measured at execution time, 2026-08-26): `limit` is itself a SQL
 * keyword, and Quereus rejects a bind parameter NAMED `limit` (`:limit`)
 * after the `LIMIT` clause with the exact same class of parse error the
 * plan's own read-first notes warn about for `:desc` / `:group` / `:order`
 * / `:type` -- "Expected identifier or number after parameter prefix",
 * naming no column and no statement. Empirically:
 * `select Id from Authority limit :limit` fails to parse;
 * `select Id from Authority limit :rosterLimit` parses and runs cleanly.
 * `readRegistrantRoster` below therefore binds the roster bound as
 * `:rosterLimit`, not `:limit` -- the SAME reserved-word hazard class, one
 * more instance of it. The value is still a genuine bound parameter (never
 * interpolated); only the bind's NAME differs from the plan's literal
 * example.
 */

import { CAPABILITIES } from '../auth/capabilities.js';

const CAPABILITY = /** @type {NonNullable<ReturnType<typeof CAPABILITIES.find>>} */ (
	CAPABILITIES.find((c) => c.id === 'registrations')
);

/** The twelve `vrg` tables this module covers, read from `capabilities.js`. @type {ReadonlyArray<string>} */
export const TABLES_READ = Object.freeze([...CAPABILITY.tables]);

/** The registrant roster page bound -- a PRIVACY control first, a
 * performance one second: a borrowed or shoulder-surfed browser exposes at
 * most this many rows rather than an entire county roll, and a page-source
 * `Ctrl-F` cannot enumerate more than this. @type {100} */
export const ROSTER_PAGE_SIZE = 100;

/**
 * @typedef {object} StatusBreakdownRow
 * @property {string} Code
 * @property {string} Name
 * @property {number} Count
 */

/**
 * Drives FROM the view, so every status appears even at zero -- an absent
 * row and a zero row read very differently to an officer.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<StatusBreakdownRow[]>}
 */
export async function readRegistrantStatusBreakdown(db) {
	/** @type {StatusBreakdownRow[]} */
	const out = [];
	for await (const r of db.eval(
		`select S.Code, S.Name, (select count(*) from Registrant R where R.Status = S.Code) as Count
		 from RegistrantStatus S`,
		{},
	)) {
		out.push(/** @type {StatusBreakdownRow} */ (r));
	}
	return out;
}

/**
 * @typedef {object} RequestBreakdownRow
 * @property {string} Status
 * @property {string} StatusName
 * @property {string} IssuerType
 * @property {string} IssuerName
 * @property {number} Count
 */

/**
 * The issuer split is not decoration -- the schema's own `BridgeIdValid`
 * comment calls it the D-03 machine-distinguishability gate, so an officer
 * can see which requests were asserted on someone's behalf.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<RequestBreakdownRow[]>}
 */
export async function readRegistrationRequestBreakdown(db) {
	/** @type {RequestBreakdownRow[]} */
	const out = [];
	for await (const r of db.eval(
		`select RR.Status, RS.Name as StatusName, RR.IssuerType, RI.Name as IssuerName, count(*) as Count
		 from RegistrationRequest RR
		 join RegistrationRequestStatus RS on RS.Code = RR.Status
		 join RegistrationRequestIssuer RI on RI.Code = RR.IssuerType
		 group by RR.Status, RS.Name, RR.IssuerType, RI.Name`,
		{},
	)) {
		out.push(/** @type {RequestBreakdownRow} */ (r));
	}
	return out;
}

/**
 * @typedef {object} RosterRow
 * @property {string} Id
 * @property {string} Status
 * @property {string} Expiration - VERBATIM. `Z`-suffixed by CHECK, not
 *   canonical 19-character -- never normalised, never parsed.
 * @property {string | null} LastName
 * @property {string | null} FirstName
 * @property {string | null} District
 */

/**
 * @typedef {object} RosterResult
 * @property {RosterRow[]} rows
 * @property {number} total
 */

/**
 * @param {import('@quereus/quereus').Database} db
 * @param {number} [limit]
 * @returns {Promise<RosterResult>}
 */
export async function readRegistrantRoster(db, limit = ROSTER_PAGE_SIZE) {
	/** @type {RosterRow[]} */
	const rows = [];
	for await (const r of db.eval(
		`select R.Id, R.Status, R.Expiration, RP.LastName, RP.FirstName, RP.District
		 from Registrant R left join RegistrantPublic RP on RP.RegistrantId = R.Id and RP.Cid = R.PublicCid
		 order by RP.LastName, RP.FirstName, R.Id limit :rosterLimit`,
		{ rosterLimit: limit },
	)) {
		rows.push(/** @type {RosterRow} */ (r));
	}

	const totalRow = await db.prepare(`select count(*) as c from Registrant`).get({});
	return { rows, total: /** @type {number} */ (totalRow?.c ?? 0) };
}

/**
 * @typedef {object} SurfaceCountEntry
 * @property {string} table
 * @property {number} count
 */

// A static, literal SQL string per `vrg` table -- no template interpolation
// anywhere (rule R4), and table/column identifiers cannot be bound via a
// `:name` parameter in standard SQL regardless. `ElectionRegistrant` is the
// one entry scoped to the active election; every other table is counted
// network-wide (rule R3: these five private/selective/payload-bearing
// tables are reached by count(*) ONLY -- RegistrantPrivate,
// RegistrantSelective, AssociationPrivate, Association, AttestationChallenge).
const SURFACE_COUNT_QUERIES = Object.freeze({
	Association: 'select count(*) as c from Association',
	AssociationRequest: 'select count(*) as c from AssociationRequest',
	AssociationPrivate: 'select count(*) as c from AssociationPrivate',
	AttestationChallenge: 'select count(*) as c from AttestationChallenge',
	ElectionRegistrant: 'select count(*) as c from ElectionRegistrant where ElectionId = :electionId',
	PollingDevice: 'select count(*) as c from PollingDevice',
	Registrant: 'select count(*) as c from Registrant',
	RegistrantPrivate: 'select count(*) as c from RegistrantPrivate',
	RegistrantPublic: 'select count(*) as c from RegistrantPublic',
	RegistrantSelective: 'select count(*) as c from RegistrantSelective',
	RegistrantSignatureTaskExtension: 'select count(*) as c from RegistrantSignatureTaskExtension',
	RegistrationBridgeKey: 'select count(*) as c from RegistrationBridgeKey',
	RegistrationRequest: 'select count(*) as c from RegistrationRequest',
});

/**
 * One `{ table, count }` entry per `vrg` table, in `capability.tables`
 * order (i.e. `TABLES_READ` order) -- the positive control that proves the
 * counts are really being read, and the section that makes all thirteen
 * tables visible in the panel.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @returns {Promise<SurfaceCountEntry[]>}
 */
export async function readRegistrationSurfaceCounts(db, electionId) {
	/** @type {SurfaceCountEntry[]} */
	const out = [];
	for (const table of TABLES_READ) {
		const sql = SURFACE_COUNT_QUERIES[/** @type {keyof typeof SURFACE_COUNT_QUERIES} */ (table)];
		// eslint-disable-next-line no-await-in-loop -- sequential against one shared handle, this project's tier-1 discipline
		const row = await db.prepare(sql).get(table === 'ElectionRegistrant' ? { electionId } : {});
		out.push({ table, count: /** @type {number} */ (row?.c ?? 0) });
	}
	return out;
}

/**
 * The single tested predicate that decides Empty versus Populated for the
 * Registrations panel -- so that decision lives here, not in the
 * component.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<boolean>}
 */
export async function hasAnyRegistrationData(db) {
	const row = await db
		.prepare(
			`select (
			   exists(select 1 from Association) or
			   exists(select 1 from AssociationPrivate) or
			   exists(select 1 from AttestationChallenge) or
			   exists(select 1 from ElectionRegistrant) or
			   exists(select 1 from PollingDevice) or
			   exists(select 1 from Registrant) or
			   exists(select 1 from RegistrantPrivate) or
			   exists(select 1 from RegistrantPublic) or
			   exists(select 1 from RegistrantSelective) or
			   exists(select 1 from RegistrantSignatureTaskExtension) or
			   exists(select 1 from RegistrationBridgeKey) or
			   exists(select 1 from RegistrationRequest)
			 ) as AnyRow`,
		)
		.get({});
	return Boolean(row?.AnyRow);
}
