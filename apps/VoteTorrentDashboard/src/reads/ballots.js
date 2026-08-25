/**
 * ballots.js -- the `ceb` read surface: ballots and their questions for the
 * active election, with per-question option counts.
 *
 * RULE R4 (bound parameters only) and inherited-spec item 4 (raw-handle
 * reads are correct here) apply exactly as documented at the top of
 * `./elections.js` -- see that header for the full reasoning; it is not
 * repeated verbatim in every module.
 *
 * RESERVED-WORD BIND NAMES: `desc`, `group`, `order` and `type` are all SQL
 * keywords -- Quereus rejects `:desc` (and the like) after a parameter
 * prefix with "Expected identifier or number after parameter prefix", a
 * parse error naming no column and no statement
 * (`.planning/spikes/078-authority-dashboard-prototype/src/engine.js:131-135`).
 * `Question.Grouping` is quoted exactly as the schema spells it and bound
 * as `:grp`, never `:group`.
 */

import { CAPABILITIES } from '../auth/capabilities.js';

const CAPABILITY = /** @type {NonNullable<ReturnType<typeof CAPABILITIES.find>>} */ (
	CAPABILITIES.find((c) => c.id === 'ballotsQuestions')
);

/** The four `ceb` tables this module covers, read from `capabilities.js`. @type {ReadonlyArray<string>} */
export const TABLES_READ = Object.freeze([...CAPABILITY.tables]);

/**
 * @typedef {object} BallotRow
 * @property {string} Id
 * @property {string} Description
 * @property {string[]} Districts
 */

/**
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @returns {Promise<BallotRow[]>}
 */
export async function readBallots(db, electionId) {
	/** @type {BallotRow[]} */
	const out = [];
	for await (const r of db.eval(
		`select Id, Description, Districts from Ballot where ElectionId = :electionId order by Id`,
		{ electionId },
	)) {
		/** @type {string[]} */
		let districts = [];
		try {
			const parsed = JSON.parse(/** @type {string} */ (r.Districts));
			if (Array.isArray(parsed)) districts = parsed;
		} catch {
			districts = [];
		}
		out.push({ Id: /** @type {string} */ (r.Id), Description: /** @type {string} */ (r.Description), Districts: districts });
	}
	return out;
}

/**
 * @typedef {object} QuestionRow
 * @property {string} BallotId
 * @property {string} Code
 * @property {string} Title
 * @property {string} TypeName
 * @property {unknown} OptionRange - raw JSON column value
 * @property {number} Required
 * @property {string | null} Grouping
 * @property {number} OptionCount
 */

/**
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @returns {Promise<QuestionRow[]>}
 */
export async function readQuestions(db, electionId) {
	/** @type {QuestionRow[]} */
	const out = [];
	for await (const r of db.eval(
		`select Q.BallotId, Q.Code, Q.Title, QT.Name as TypeName, Q.OptionRange, Q.Required, Q.Grouping,
		        coalesce(OC.OptionCount, 0) as OptionCount
		 from Question Q
		 join Ballot B on B.Id = Q.BallotId
		 join QuestionType QT on QT.Code = Q.Type
		 left join (
		   select BallotId, QuestionCode, count(*) as OptionCount from Option group by BallotId, QuestionCode
		 ) OC on OC.BallotId = Q.BallotId and OC.QuestionCode = Q.Code
		 where B.ElectionId = :electionId
		 order by Q.BallotId, Q.Sequence, Q.Code`,
		{ electionId },
	)) {
		out.push(/** @type {QuestionRow} */ (r));
	}
	return out;
}

/**
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<number>}
 */
export async function countBallotSigningTasks(db) {
	const row = await db.prepare(`select count(*) as c from BallotSignatureTaskExtension`).get({});
	return /** @type {number} */ (row?.c ?? 0);
}
