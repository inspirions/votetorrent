/**
 * keyrelease-fixture.js — TEST-ONLY. Nothing under
 * `apps/VoteTorrentPublic/src` may import this file (D-17), for the same reason
 * `registrant-roll-fixture.js` states: a production bundle carrying these facts
 * would let a public page assert election facts that are not true.
 *
 * ZERO IMPORTS. Every row here is inserted through a context shoe-in, so no key
 * material and no ceremony helper is needed. `Task.MutationValid` is
 * `context.IsMutationValid = true` and nothing else — the cheapest insert
 * pattern in this schema, and the reason D-14's fixture needs no signing at
 * all.
 *
 * TWO OPPOSITE TRANSACTION RULES LIVE IN THIS PHASE. They are stated side by
 * side here so the contrast reads as deliberate rather than as an
 * inconsistency a later reader should "fix":
 *
 *   - THIS FILE BATCHES. `Task.ExtensionExists` requires a matching
 *     `ReleaseKeyTaskExtension`, and `ReleaseKeyTaskExtension.TaskIdValid`
 *     requires the `Task`. Both contain subqueries and are therefore DEFERRED
 *     TO COMMIT. Under autocommit each statement commits alone, so inserting
 *     the `Task` by itself fails `ExtensionExists` and inserting the extension
 *     first fails `TaskIdValid`. The pair is only satisfiable inside ONE
 *     transaction whose commit evaluates them together.
 *   - `registrant-roll-fixture.js` MUST NOT BATCH its reissue.
 *     `RegistrantPublic.RegistrantCidMatch` is likewise deferred to commit, so
 *     batching there would evaluate the superseded row's check after
 *     `Registrant.PublicCid` had already moved forward, and the row would be
 *     rejected.
 *
 * CLOSING SPIKE 088'S RECORDED SEEDING LIMIT. Spike 088 seeded exactly ONE
 * keyholder and said so explicitly, because `User.InsertValid` admits the
 * unsigned shoe-in only while `(select count(*) from User) = 1`; a second user
 * needs a valid `InviteSlot` + `InviteSignature`. It chose not to pay for that
 * and recorded the single-keyholder roster as a SEEDING LIMIT rather than an
 * election state — the honest call at the time. The workaround is now cheap and
 * legitimate, because `InviteSlot`'s own integrity checks
 * (`InviteSignatureValid`, `InsertValid`) are context passthroughs: seed one
 * slot, then seed users against it. THE WALL WAS IN THE FIXTURE, NOT IN THE
 * SCHEMA'S MEANING, and it is gone — later fixture work should not re-derive
 * it.
 */

/**
 * The four additional keyholder users the `InviteSlot` unlocks. The founding
 * fixture's `u1` is the fifth keyholder and already exists.
 * @type {ReadonlyArray<Readonly<{ id: string, name: string }>>}
 */
export const KEYRELEASE_USERS = Object.freeze([
	Object.freeze({ id: 'u-kh-2', name: 'vtx-fixture Keyholder Two' }),
	Object.freeze({ id: 'u-kh-3', name: 'vtx-fixture Keyholder Three' }),
	Object.freeze({ id: 'u-kh-4', name: 'vtx-fixture Keyholder Four' }),
	Object.freeze({ id: 'u-kh-5', name: 'vtx-fixture Keyholder Five' }),
]);

/**
 * One release-key `Task` per keyholder, three completed and two not.
 *
 * WHY THE MIX MATTERS. `0 of 0` and `N of N` both render a degenerate sentence
 * that hides an aggregate bug: an aggregate stuck at zero and an aggregate that
 * counts tasks instead of completions both look correct at those two extremes.
 * `released` must therefore be non-zero AND strictly less than `total`, and the
 * tier-1 suite asserts both of those RELATIONALLY, not just as the literals
 * below.
 * @type {ReadonlyArray<Readonly<{ id: string, userId: string, isCompleted: number }>>}
 */
export const KEYRELEASE_TASKS = Object.freeze([
	Object.freeze({ id: 't-rk-1', userId: 'u1', isCompleted: 1 }),
	Object.freeze({ id: 't-rk-2', userId: 'u-kh-2', isCompleted: 1 }),
	Object.freeze({ id: 't-rk-3', userId: 'u-kh-3', isCompleted: 1 }),
	Object.freeze({ id: 't-rk-4', userId: 'u-kh-4', isCompleted: 0 }),
	Object.freeze({ id: 't-rk-5', userId: 'u-kh-5', isCompleted: 0 }),
]);

/** Keyholders who have completed their release-key task. @type {number} */
export const EXPECTED_RELEASED = 3;

/** Release-key TASKS raised for this election revision. @type {number} */
export const EXPECTED_TOTAL = 5;

/** Keyholders of record — the denominator the render layer says "of". @type {number} */
export const EXPECTED_KEYHOLDERS = 5;

/**
 * Row counts this fixture leaves behind.
 *
 * `User` IS 5, NOT 4: the founding fixture's single user plus the four seeded
 * here. THIS KEY OVERRIDES the founding fixture's `User: 1`, so any merge must
 * place this object LAST — see `seed-public-surface.js`, which asserts the
 * resulting value rather than trusting the spread order.
 * @type {Readonly<Record<string, number>>}
 */
export const KEYRELEASE_EXPECTED_COUNTS = Object.freeze({
	InviteSlot: 1,
	User: 5,
	Keyholder: 5,
	Task: 5,
	ReleaseKeyTaskExtension: 5,
});

/**
 * The invite slot's `SigningNonce`.
 *
 * THIS VALUE MUST NOT MATCH ANY `AdminSigning.Nonce`, and it cannot: the shared
 * `ceremony` helper mints nonces of the form `n-<scope>-<seq>`. That
 * non-collision is LOAD-BEARING. The global `InviteSlotSigningValid` assertion
 * is written as an INNER JOIN from `InviteSlot` to `AdminSigning`, so a slot
 * whose nonce matches no signing row satisfies it VACUOUSLY — which is the
 * documented and allowed insert-before-signing ordering (`votetorrent.qsql`'s
 * own D-03 comment on that assertion). A later reader who "tidies" this nonce
 * into a real ceremony nonce would trip a GLOBAL assertion at a commit far from
 * this statement, with nothing pointing back here.
 * @type {string}
 */
const INVITE_SIGNING_NONCE = 'vtx-fixture-invite-nonce';

/** The slot's invite keypair stand-ins. Never verified — `InviteSignatureValid` is a context passthrough. @type {string} */
const INVITE_KEY = 'vtx-fixture-invite-key';

/** @type {string} */
const INVITE_SIGNATURE = 'vtx-fixture-invite-signature';

/**
 * Canonical 19 characters, NO trailing `Z`. `InviteSlot` has no
 * `isISODatetime` check and `ExpirationValid` is a plain `> context.now`
 * comparison against `seedNow` — the opposite of `Registrant.Expiration`, which
 * REQUIRES the `Z`.
 * @type {string}
 */
const INVITE_EXPIRATION = '2026-12-31T00:00:00';

/**
 * Seed the keyholder roster and the release-key tasks that D-14's aggregate
 * counts: one `InviteSlot`, four `User`s, five `Keyholder`s, and five
 * `Task` + `ReleaseKeyTaskExtension` pairs.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {{ electionId: string, revision: number, seedNow: string }} options
 * @returns {Promise<void>}
 */
export async function seedKeyReleaseTasks(db, options) {
	const { electionId, revision, seedNow } = options ?? {};
	if (!electionId) throw new Error('seedKeyReleaseTasks: options.electionId is required');
	if (revision === undefined || revision === null) throw new Error('seedKeyReleaseTasks: options.revision is required');
	if (!seedNow) throw new Error('seedKeyReleaseTasks: options.seedNow is required');

	// --- 1. Unlock additional users through one keyholder InviteSlot. ---------
	// The content id is computed IN SQL against `CidValid`'s KEYHOLDER branch —
	// the one keyed on `ElectionId is not null`. Its argument order is
	// `Digest(ElectionId, Expiration, InviteKey, InviteSignature, Name,
	// SigningNonce, Type)`: ALPHABETICAL BY COLUMN NAME, not declaration order.
	// Getting the order wrong surfaces as a bare
	// `CHECK constraint failed: CidValid` naming nothing.
	//
	// Bind names avoid this engine's reserved words (`:type` parses as a
	// keyword, not a parameter), hence `:itype`.
	const slotName = 'vtx-fixture Keyholder Invite Batch';
	const cidRow = await db
		.prepare('select cid(Digest(:eid, :exp, :ikey, :isig, :iname, :nonce, :itype)) as c')
		.get({
			eid: electionId,
			exp: INVITE_EXPIRATION,
			ikey: INVITE_KEY,
			isig: INVITE_SIGNATURE,
			iname: slotName,
			nonce: INVITE_SIGNING_NONCE,
			itype: 'k',
		});
	if (cidRow?.c == null) {
		throw new Error('keyrelease-fixture: cid(Digest(...)) returned null — crypto plugin not registered?');
	}
	const slotCid = String(cidRow.c);

	await db.exec(
		`insert into InviteSlot (Cid,Type,Name,Expiration,InviteKey,InviteSignature,SigningNonce,ResendSalt,ElectionId)
		 with context Tid = 1, now = '${seedNow}', IsSignatureValid = true, IsInsertValid = true
		 values (:cid,:itype,:iname,:exp,:ikey,:isig,:nonce,null,:eid)`,
		{
			cid: slotCid,
			itype: 'k',
			iname: slotName,
			exp: INVITE_EXPIRATION,
			ikey: INVITE_KEY,
			isig: INVITE_SIGNATURE,
			nonce: INVITE_SIGNING_NONCE,
			eid: electionId,
		},
	);

	for (const user of KEYRELEASE_USERS) {
		// `User.InsertValid`'s SECOND disjunct: a null SigningNonce plus an
		// InviteSlotCid / InviteSignature pair matching an existing slot.
		// eslint-disable-next-line no-await-in-loop -- sequential against one shared handle, this project's tier-1 discipline
		await db.exec(
			`insert into User (Id, Name, ImageRef)
			 with context SigningNonce = null, InviteSlotCid = :slot, InviteSignature = :sig, Tid = 1
			 values (:id,:uname,null)`,
			{ slot: slotCid, sig: INVITE_SIGNATURE, id: user.id, uname: user.name },
		);
	}

	// --- 2. Keyholders. ------------------------------------------------------
	// `Keyholder.InsertValid` requires exactly that all three context fields are
	// null. `revision` is bound as a NUMBER; the column is declared `integer`.
	const keyholderUserIds = ['u1', ...KEYRELEASE_USERS.map((u) => u.id)];
	for (const userId of keyholderUserIds) {
		// eslint-disable-next-line no-await-in-loop
		await db.exec(
			`insert into Keyholder (ElectionId,ElectionRevision,UserId)
			 with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 1
			 values (:eid,:rev,:uid)`,
			{ eid: electionId, rev: Number(revision), uid: userId },
		);
	}

	// --- 3. Tasks and their extensions, ONE EXPLICIT TRANSACTION PER PAIR. ----
	// See this file's header for why batching is mandatory here and forbidden in
	// `registrant-roll-fixture.js`. `BEGIN`/`COMMIT`/`ROLLBACK` through
	// `db.exec` is the form `elections-engine.ts` uses for this exact pair.
	//
	// `IsCompleted` is bound as a NUMBER (0/1) into a column declared
	// `integer default 0`, so it is stored as an integer. This is NOT the
	// `number`-column-stores-bound-integers-as-blobs hazard recorded elsewhere
	// in this project — that one is about columns DECLARED `number`. Nothing
	// here needs re-declaring.
	for (const task of KEYRELEASE_TASKS) {
		// eslint-disable-next-line no-await-in-loop
		await db.exec('BEGIN');
		try {
			// eslint-disable-next-line no-await-in-loop
			await db.exec(
				`insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
				 with context IsMutationValid = true, Tid = 1
				 values (:id, :uid, 'release-key', null, null, :done)`,
				{ id: task.id, uid: task.userId, done: Number(task.isCompleted) },
			);
			// eslint-disable-next-line no-await-in-loop
			await db.exec(
				`insert into ReleaseKeyTaskExtension (TaskId, ElectionId, ElectionRevision)
				 with context Tid = 1
				 values (:tid, :eid, :rev)`,
				{ tid: task.id, eid: electionId, rev: Number(revision) },
			);
			// eslint-disable-next-line no-await-in-loop
			await db.exec('COMMIT');
		} catch (err) {
			// eslint-disable-next-line no-await-in-loop
			await db.exec('ROLLBACK');
			throw err;
		}
	}
}
