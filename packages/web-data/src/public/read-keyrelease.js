/**
 * read-keyrelease.js — D-14: "N of M keyholders have released a key", with no
 * task row exposed. The one genuinely live fact during the ~13-day settling
 * window, filled by an aggregate rather than left as a gap (087 gap D).
 *
 * RULE R4 (bound parameters only): every SQL string in this module is a
 * plain template with NO `${` inside it. Every value that varies arrives
 * through `.get({...})` / `db.eval(sql, {...})` named binds.
 *
 * RULE R4, ADDENDUM (reserved bind NAMES): `:limit`, `:desc`, `:group`,
 * `:order` and `:type` parse as KEYWORDS, not parameters, in this engine. That
 * addendum is not academic here — see point 2 below.
 *
 * THREE LOAD-BEARING FACTS ABOUT THE AGGREGATE STRING:
 *
 * 1. THE JOIN IS MANDATORY. `IsCompleted integer default 0` lives on `Task`
 *    (votetorrent.qsql:1138). `ReleaseKeyTaskExtension` (votetorrent.qsql:1162)
 *    carries only TaskId, ElectionId and ElectionRevision and has NO status
 *    column at all. A query over the extension alone measures how many
 *    release-key tasks EXIST, not how many COMPLETED, and would read
 *    "0 released" forever — mid-settling included, which is precisely the
 *    window this fact exists to cover.
 *
 * 2. THE TASK TYPE IS A LITERAL, NOT A BIND. The natural bind name for a
 *    `Task.Type` filter is one of the engine's reserved words and would parse
 *    as a keyword rather than a parameter. The value is a fixed schema code
 *    (`TaskType`), not caller input, so a literal is correct — and this is the
 *    one place in this module where R4's "every varying value is bound" does
 *    not apply, because the value does not vary.
 *
 * 3. ONLY COUNTS LEAVE THIS FUNCTION. Never select `Task.UserId`, `Task.Id` or
 *    `Task.SigningNonce`: any of the three answers WHICH keyholder released a
 *    key, which is exactly what D-14's "no task row exposed" forbids (54-ISSUES
 *    I-07). `T.Id` appears in the join condition and nowhere else;
 *    `assertNoIdentifyingColumns` checks the SELECT LIST only, precisely so
 *    that join condition stays legal while UserId and SigningNonce cannot
 *    appear in anything the function returns.
 *
 * D-15 PAYING OFF: `Task` and `ReleaseKeyTaskExtension` are AGGREGATE in the
 * corrected `classification.js`, so `assertPublicSafe` passes here with no
 * special case, no named allowlist and nothing to rot.
 */

import { assertPublicSafe, assertNoIdentifyingColumns } from '../classification.js';

/** @type {'public/read-keyrelease.js'} */
const MODULE_LABEL = 'public/read-keyrelease.js';

/** Task and ReleaseKeyTaskExtension are AGGREGATE (D-15) and reached by counts only; Keyholder is PUBLIC and supplies the denominator. @type {ReadonlyArray<string>} */
export const TABLES_READ = Object.freeze(['Task', 'ReleaseKeyTaskExtension', 'Keyholder']);

/** @type {string} */
export const KEYRELEASE_AGGREGATE_SQL =
	`select count(*) as total, sum(T.IsCompleted) as released from Task T join ReleaseKeyTaskExtension R on R.TaskId = T.Id where T.Type = 'release-key' and R.ElectionId = :electionId and R.ElectionRevision = :revision`;

/** @type {string} */
export const KEYHOLDER_COUNT_SQL =
	`select count(*) as keyholders from Keyholder where ElectionId = :electionId and ElectionRevision = :revision`;

/**
 * @typedef {object} KeyReleaseProgress
 * @property {number} released - keyholders who have completed their release-key task.
 * @property {number} total - release-key TASKS raised for this election revision.
 * @property {number} keyholderCount - keyholders of record: the denominator.
 */

/**
 * D-14's fact, as three numbers.
 *
 * The render layer (54-13) says "released of keyholderCount", NOT "released of
 * total": `total` counts release-key TASKS, which is zero before any are
 * raised, and "0 of 0" is indistinguishable on screen from a genuinely empty
 * election. `total` is returned alongside anyway so a divergence between the
 * task count and the keyholder count is observable rather than hidden.
 *
 * `sum()` over zero matching rows yields `null`, not `0`, so every field is
 * coerced with `Number(...)` and defaulted to `0`. `revision` is bound as a
 * NUMBER, matching `ReleaseKeyTaskExtension.ElectionRevision`'s `integer`
 * declaration.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {string} electionId
 * @param {number} revision
 * @returns {Promise<KeyReleaseProgress>}
 */
export async function readKeyReleaseProgress(db, electionId, revision) {
	const binds = { electionId, revision: Number(revision) };
	const aggregateRow = await db.prepare(KEYRELEASE_AGGREGATE_SQL).get(binds);
	const keyholderRow = await db.prepare(KEYHOLDER_COUNT_SQL).get(binds);
	return {
		released: Number(aggregateRow?.released ?? 0) || 0,
		total: Number(aggregateRow?.total ?? 0) || 0,
		keyholderCount: Number(keyholderRow?.keyholders ?? 0) || 0,
	};
}

assertPublicSafe(TABLES_READ, MODULE_LABEL);
for (const sql of [KEYRELEASE_AGGREGATE_SQL, KEYHOLDER_COUNT_SQL]) {
	assertNoIdentifyingColumns(sql, MODULE_LABEL);
}
