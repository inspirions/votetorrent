import { MisuseError, QuereusError } from '@quereus/quereus'
import type { SqlValue, Database } from '@quereus/quereus'
import { SigningEngine } from '../signing/signing-engine.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { toIsoZDatetime, toDeferredCheckDatetime, restoreCanonicalDatetime } from '../signing/ceremony-helpers.js'
import { digestToBytes, nowCanonicalDatetime, parseJsonOr } from '../utils.js'
import type { EngineContext } from '../types.js'
import { verificationCid } from '@votetorrent/vote-core'
import type {
  ISigningEngine,
  ISignatureTasksEngine,
  ISignatureTasksCompleteSignatureBuilder,
  NetworkReference,
  SignatureResult,
  SignatureTask,
  AdminSignatureTask,
  BallotSignatureTask,
  RegistrantSignatureTask,
  Authority,
  ThresholdPolicy,
  AdminInit,
  Proposal,
  Ballot,
  Question,
  RegisterInit,
  RegistrationRequestDecision,
  Signature,
} from '@votetorrent/vote-core'
import { BALLOT_HEADER_TID } from '../election/election-engine.js'
import { CompleteSignatureBuilder } from './builders/index.js'
import { allocateTid } from '../database/tid-allocator.js'
import { RegistrationEngine } from '../registration/registration-engine.js'

/**
 * CR-04 (T-48-33-02/03) — the identifier-free tally a registrant seed pass returns and the
 * engine keeps the most recent copy of on {@link SignatureTasksEngine.lastSeedOutcome}. Every
 * field is a `number` or a `boolean` — NEVER a request identifier: D-02 makes
 * `RegistrationRequest` intake unauthenticated, so a skip/abort signal derived from a pending row
 * must not leak requester-chosen values across that trust boundary (T-48-08-02).
 *
 * Field meanings:
 *  - `considered` — rows in the work set AFTER the CR-01 authority-scoping predicate (the ones
 *    this pass actually attempted).
 *  - `seeded` — rows whose envelope reached `COMMIT`.
 *  - `skipped` — rows that failed and were isolated, INCLUDING the one aborting row (its
 *    `ROLLBACK` failure counts as a skip too, on top of setting `aborted`).
 *  - `aborted` — a `ROLLBACK` failure stopped the pass before every considered row was attempted.
 *  - `handleInAutocommit` — `Database.getAutocommit()` probed at pass end.
 *
 * `considered > 0, seeded === 0` is what distinguishes a permanently un-seedable request from an
 * empty inbox — the exact signal CR-04 closes the gap on. This type is intentionally NOT added to
 * `ISignatureTasksEngine` in `vote-core`: it has no UI consumer this round (PARTIAL BY DESIGN —
 * only a developer or a test can see it; an officer still cannot).
 */
export type RegistrantSeedOutcome = {
  considered: number
  seeded: number
  skipped: number
  aborted: boolean
  handleInAutocommit: boolean
}

/**
 * CR-04 (T-48-33-01) — module-private sentinel distinguishing "this row's ROLLBACK could not be
 * recovered, stop the pass" from an ordinary per-row failure that simply retries on the next
 * pull. Carries NO request data — only a fixed, identifier-free message. Never exported: callers
 * outside this file have no legitimate reason to construct or catch it.
 */
class SeedPassAborted extends Error {
  constructor () {
    super('seedRegistrantSignatureTasks: rollback failed; seed pass aborted')
    this.name = 'SeedPassAborted'
  }
}

/**
 * CR-04 (T-48-33-04/05) — one registrant seed pass at a time per `Database` handle.
 * `useTaskCount.fetchCount` and `TasksScreen`'s focus effect both call
 * `getRequestedSignatures(true)` on the SAME `ctx.db`, and Quereus's transactions are flat and
 * handle-global (`signing-engine.ts`) — interleaved `BEGIN`/`COMMIT` pairs from two overlapping
 * passes corrupt each other (duplicate extension rows or a wedged handle). This copies the
 * proven D-10 promise-chain mutex shape from `tid-allocator.ts:88-115` verbatim, keyed by
 * `Database` handle instead of a namespace string: read the prior chain (`?? Promise.resolve()`),
 * `.then()` the pass onto it, and store `next.catch(() => {})` back into the map — the STORED
 * chain's `.catch` is the wedge guard, so a rejected pass can never poison the next caller.
 */
const seedPassLocks = new WeakMap<Database, Promise<unknown>>()

/**
 * SignatureTasksEngine — Phase 05 (TASK-03, TASK-04) implementation.
 *
 * The ISignatureTasksEngine interface declares
 * `getRequestedSignatures(pending: boolean)` and
 * `completeSignature(task, result)`.
 *
 * Schema kept as-written. `Task.SignatureTypeValid` checks SignatureType
 * against the SignatureType view ({admin, authority, network, election,
 * election-revision, ballot}). Under
 * [quereus#21](https://github.com/gotchoices/quereus/issues/21), only the
 * first row of the view ('admin') matches at CHECK eval; non-admin tasks
 * are silently rejected on INSERT.
 */
export class SignatureTasksEngine implements ISignatureTasksEngine {
  /**
   * CR-04 (T-48-33-02) — the most recent registrant seed pass's tally. Public so a test or a
   * future UI consumer can read it; NOT part of `ISignatureTasksEngine` (no interface change, no
   * UI consumer this round — see {@link RegistrantSeedOutcome}'s own doc comment).
   */
  lastSeedOutcome?: RegistrantSeedOutcome

  constructor (
    private readonly networkRef: NetworkReference,
    private readonly ctx?: EngineContext,
    private readonly signingEngine: ISigningEngine | undefined = ctx
      ? new SigningEngine(ctx)
      : undefined
  ) {}

  /**
   * TASK-03 — query pending Task rows of `Type='signature'` for the
   * current user. Materialises the authority, administration, and network
   * name for 'admin' signature tasks so TasksScreen and SignatureTaskScreen
   * can render without crashing on missing fields.
   *
   * For non-admin types the base SignatureTask shape is returned with the
   * network name resolved from the Network table; authority-specific fields
   * are absent but those screen branches do not access them.
   */
  async getRequestedSignatures (pending: boolean): Promise<SignatureTask[]> {
    if (!this.ctx) return []
    const userId = this.ctx.user?.id ?? null
    const out: SignatureTask[] = []
    try {
      // D-05 pull-and-seed point: for every pending RegistrationRequest lacking a task, seed one
      // under the currently signed-in officer BEFORE this same pull reads it back — so a
      // newly-arrived request is visible on the same call that seeded it. Consequence for
      // downstream: 'registrant' tasks now appear in this generic getRequestedSignatures(true)
      // result alongside the six existing types; this method does NOT filter them out — 48-18/48-19
      // decide whether the generic tasks list renders or filters them.
      await this.seedRegistrantSignatureTasks()

      // Resolve network name once — single Network row per DB.
      const networkRow = await this.ctx.db
        .prepare('select Name, Hash from Network limit 1')
        .get({})
      const networkRef: NetworkReference = {
        ...this.networkRef,
        name: (networkRow?.Name as string | undefined) ?? (this.networkRef as NetworkReference & { name?: string }).name ?? '',
        primaryAuthorityDomainName: (this.networkRef as NetworkReference & { primaryAuthorityDomainName?: string }).primaryAuthorityDomainName ?? '',
      }

      // Collect base task rows first (avoid interleaving eval + prepare on same handle).
      const taskRows: Array<{ Id: string; UserId: string; SignatureType: string; SigningNonce: string }> = []
      for await (const row of this.ctx.db.eval(
				`select Id, UserId, SignatureType, SigningNonce
					from Task
					where Type = 'signature'
						and UserId = :userId
						and (IsCompleted = 0 or IsCompleted = :includeAll)`,
        {
          userId,
          includeAll: pending ? 0 : 1
        }
      )) {
        taskRows.push({
          Id: row.Id as string,
          UserId: row.UserId as string,
          SignatureType: row.SignatureType as string,
          SigningNonce: row.SigningNonce as string,
        })
      }

      for (const row of taskRows) {
        const signatureType = row.SignatureType as SignatureTask['signatureType']
        const base: SignatureTask = {
          type: 'signature',
          userId: row.UserId,
          network: networkRef,
          signatureType,
        }

        if (signatureType === 'admin') {
          // Materialise AdminSignatureTask: join AdminSignatureTaskExtension →
          // Authority (for authority.name) and ProposedAdmin (for administration.proposed).
          const extRow = await this.ctx.db
            .prepare(
              `select E.AuthorityId, E.AdminEffectiveAt,
                      A.Name as AuthName, A.DomainName, A.ImageRef,
                      PA.ThresholdPolicies
                 from AdminSignatureTaskExtension E
                   join Authority A on A.Id = E.AuthorityId
                   left join ProposedAdmin PA on PA.AuthorityId = E.AuthorityId and PA.EffectiveAt = E.AdminEffectiveAt
                 where E.TaskId = :taskId`
            )
            .get({ taskId: row.Id })

          if (extRow) {
            const authority: Authority = {
              id: extRow.AuthorityId as string,
              name: (extRow.AuthName as string | undefined) ?? '',
              domainName: (extRow.DomainName as string | undefined) ?? '',
              imageRef: extRow.ImageRef
                ? parseJsonOr(extRow.ImageRef, undefined, 'Authority.ImageRef')
                : undefined,
            }
            const thresholdPolicies = parseJsonOr<ThresholdPolicy[]>(
              extRow.ThresholdPolicies,
              [],
              'ProposedAdmin.ThresholdPolicies'
            )
            const administration: Proposal<AdminInit> = {
              proposed: {
                officers: [],
                effectiveAt: extRow.AdminEffectiveAt as string,
                thresholdPolicies,
              },
              signers: [],
            }
            const adminTask: AdminSignatureTask = {
              ...base,
              signatureType: 'admin',
              authority,
              administration,
            }
            out.push(adminTask)
          } else {
            // Extension row missing — push base task with a defensive authority stub
            // so getAuthorityGroupKey falls back to network name rather than crashing.
            out.push(base)
          }
        } else if (signatureType === 'ballot') {
          // Materialise BallotSignatureTask: join BallotSignatureTaskExtension →
          // ProposedBallot to populate ballot.proposed (Pitfall 6, D-09).
          const bExtRow = await this.ctx.db
            .prepare(
              `select PB.Id, PB.ElectionId, PB.AuthorityId, PB.Description, PB.Districts, PB.Questions
                 from BallotSignatureTaskExtension E
                   join ProposedBallot PB on PB.Id = E.BallotId
                 where E.TaskId = :taskId`
            )
            .get({ taskId: row.Id })

          if (bExtRow) {
            const districts = parseJsonOr<string[]>(bExtRow.Districts, [], 'ProposedBallot.Districts')
            const questions = parseJsonOr<Question[]>(bExtRow.Questions, [], 'ProposedBallot.Questions')
            const proposedBallot: Ballot = {
              id: bExtRow.Id as string,
              electionId: bExtRow.ElectionId as string,
              authorityId: bExtRow.AuthorityId as string,
              description: bExtRow.Description as string,
              districts,
              questions,
            }
            const ballotTask: BallotSignatureTask = {
              ...base,
              signatureType: 'ballot',
              ballot: { proposed: proposedBallot, signers: [] },
            }
            out.push(ballotTask)
          } else {
            // Extension or ProposedBallot row missing — fall back to base task
            out.push(base)
          }
        } else if (signatureType === 'registrant') {
          // D-05: materialise the RegistrantSignatureTask. LEFT join RegistrationBridgeKey
          // deliberately — a registrant-issued row has a null BridgeId and must still
          // materialise. A missing bridgeLabel on a bridge row means the registry lookup found no
          // label; issuerType — NOT bridgeLabel — is the only authoritative issuer signal (D-03), a
          // consumer must never infer "registrant-submitted" from a missing label.
          const rExtRow = await this.ctx.db
            .prepare(
              `select E.RequestId, R.AuthorityId, R.IssuerType, R.BridgeId, R.Payload, R.SubmittedAt,
                      B.Label as BridgeLabel
                 from RegistrantSignatureTaskExtension E
                   join RegistrationRequest R on R.Id = E.RequestId
                   left join RegistrationBridgeKey B on B.Id = R.BridgeId
                 where E.TaskId = :taskId`
            )
            .get({ taskId: row.Id })

          const payload = rExtRow
            ? parseJsonOr<RegisterInit | undefined>(rExtRow.Payload as string, undefined, 'RegistrationRequest.Payload')
            : undefined

          if (rExtRow && payload) {
            const registrantTask: RegistrantSignatureTask = {
              ...base,
              signatureType: 'registrant',
              requestId: rExtRow.RequestId as string,
              payload,
              submittedAt: rExtRow.SubmittedAt as string,
              issuerType: rExtRow.IssuerType as RegistrantSignatureTask['issuerType'],
              bridgeLabel: rExtRow.BridgeLabel == null ? undefined : (rExtRow.BridgeLabel as string),
            }
            out.push(registrantTask)
          } else {
            // Missing extension row, missing joined request, or an unparseable payload — fall back
            // to base rather than throwing, the 'admin'/'ballot' contract verbatim: the approval
            // screen renders from getRegistrationRequest, so a degraded task costs legibility, while
            // a throw here would take down the entire task inbox for every signature type.
            out.push(base)
          }
        } else {
          out.push(base)
        }
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getRequestedSignatures')
    }
  }

  /**
   * D-05 — pull-and-seed intake for the registrant approval ceremony, resolving
   * `48-RESEARCH.md` Open Question 1 in the form the research itself proposed: PULL-AND-SEED at
   * inbox mount rather than push-and-seed at submission time. `AdminSigning.UserIdValid` requires
   * a `UserId`, and an outside submitter categorically cannot supply one — a prospective
   * registrant has no `User` row at all (D-02). The task can therefore only be seeded on the
   * authority side, at read time, under the CURRENTLY SIGNED-IN OFFICER's own `ctx.user` — never
   * the requester's.
   *
   * This is NOT a claim that a `'vrg'`-scoped officer is required to seed: `AdminSigning.UserIdValid`
   * requires merely that the signer be some officer at that authority. `AdminSigning.SignerKeyValid`
   * and `OfficerSignature.OfficerValid` remain hardcoded stub CHECKs (Phase 999.1).
   *
   * Best-effort, silent no-op: with no signed-in officer there is no legal `UserId` to seed under.
   *
   * CR-04 (T-48-33-04): this method now only decides WHETHER to run a pass and enforces the
   * per-`Database`-handle serialization lock (`seedPassLocks`) around it — the actual per-row work
   * lives in {@link runRegistrantSeedPass}. `useTaskCount.fetchCount` and `TasksScreen`'s focus
   * effect both call `getRequestedSignatures(true)` on the SAME `ctx.db`; without this lock their
   * per-row `BEGIN`/`COMMIT` pairs can interleave on Quereus's flat, handle-global transaction
   * model, producing duplicate `RegistrantSignatureTaskExtension` rows or a wedged handle. The
   * lock shape is `tid-allocator.ts`'s proven D-10 promise chain, copied verbatim.
   */
  private async seedRegistrantSignatureTasks (): Promise<void> {
    if (!this.ctx?.user?.id) {
      // No signed-in officer — no legal UserId to seed under (unchanged silent no-op). Still
      // record a tally so `lastSeedOutcome` is never left stale from a PRIOR ctx/user.
      this.lastSeedOutcome = {
        considered: 0,
        seeded: 0,
        skipped: 0,
        aborted: false,
        handleInAutocommit: this.ctx?.db ? this.ctx.db.getAutocommit() : true,
      }
      return
    }
    const ctx = this.ctx
    const db = ctx.db

    // CR-04 (T-48-33-04/05): chain onto any pass already in flight for this SAME Database handle
    // — copied verbatim from tid-allocator.ts:88-115's D-10 shape. The STORED chain's
    // `.catch(() => {})` is the wedge guard: a rejected pass must not poison the next caller.
    const prior = seedPassLocks.get(db) ?? Promise.resolve()
    const next = prior.then(async () => {
      this.lastSeedOutcome = await this.runRegistrantSeedPass(ctx)
    })
    seedPassLocks.set(db, next.catch(() => {}))
    await next
  }

  /**
   * CR-04 — the actual per-row seed pass, run under {@link seedRegistrantSignatureTasks}'s
   * per-handle serialization lock. Returns the identifier-free {@link RegistrantSeedOutcome}
   * tally rather than throwing, because `getRequestedSignatures`'s own `catch` rethrows anything
   * that escapes its `try` — a PER-ROW error escaping this method would re-brick the whole Tasks
   * inbox for every signature type, which is CR-01 verbatim (round 1's closed defect).
   *
   * Scope of that guarantee, stated precisely (WR-23): every failure mode INSIDE the per-row loop
   * below is captured into the tally and never re-thrown. The work-set collection query above the
   * loop is deliberately NOT wrapped, and an error there DOES propagate. That is intentional, not
   * an oversight: the query is fully parameterized and reads no requester-chosen input, so it is
   * not reachable from D-02's unauthenticated intake; and if the handle cannot be read at all,
   * every other ceremony sharing it is equally broken — a loud failure is the correct response,
   * where a silent one would show an empty inbox and hide a dead database. CR-01's isolation
   * requirement is about per-row WRITES driven by attacker-chosen rows, and that is what this
   * method isolates.
   */
  private async runRegistrantSeedPass (ctx: EngineContext): Promise<RegistrantSeedOutcome> {
    const userId = ctx.user!.id

    // Collect the work set FIRST, into an array, before any write — mirrors this file's own
    // "avoid interleaving eval + prepare on the same handle" discipline used for the base task-row
    // collection above. The `not exists` clause is what makes seeding idempotent: a request that
    // already has an extension row is never re-seeded, which is what makes it safe to run this step
    // on every inbox mount.
    const pendingRows: Array<{
      Id: string
      AuthorityId: string
      RequesterKey: string
      IssuerType: string
      BridgeId: string | null
      PayloadCid: string
      SubmittedAt: string
    }> = []
    // CR-01 (T-48-30-01): D-02 makes intake unauthenticated, so an outside submitter chooses
    // AuthorityId freely — including an authority the signed-in officer does not serve, where
    // this method's own AdminSigning('vrg') insert (below) would fail AdminSigning.UserIdValid.
    // Scope the work set to authorities the signed-in :userId actually serves BEFORE any write
    // is attempted, joining Officer to CurrentAdmin so a request is only considered when the
    // officer serves the authority's CURRENT administration.
    for await (const row of ctx.db.eval(
      `select R.Id, R.AuthorityId, R.RequesterKey, R.IssuerType, R.BridgeId, R.PayloadCid, R.SubmittedAt
         from RegistrationRequest R
         where R.Status = 'p'
           and not exists (select 1 from RegistrantSignatureTaskExtension E where E.RequestId = R.Id)
           and exists (
             select 1 from Officer O
               join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
               where O.AuthorityId = R.AuthorityId and O.UserId = :userId
           )`,
      { userId }
    )) {
      pendingRows.push({
        Id: row.Id as string,
        AuthorityId: row.AuthorityId as string,
        RequesterKey: row.RequesterKey as string,
        IssuerType: row.IssuerType as string,
        BridgeId: row.BridgeId as string | null,
        PayloadCid: row.PayloadCid as string,
        SubmittedAt: row.SubmittedAt as string,
      })
    }

    let seeded = 0
    let skipped = 0
    let aborted = false

    // T-48-30-02/T-48-11-10, rewritten for CR-04 (T-48-33-06): one malformed/unresolvable request
    // must never take down seeding for the others — but a row whose `ROLLBACK` cannot be closed is
    // a DIFFERENT failure than an ordinary row failure, and this loop now tells them apart. Three
    // outcomes, each named by its tally field:
    //   - seeded: the row's BEGIN/AdminSigning/Task/extension/COMMIT envelope succeeded outright.
    //   - skipped (transient): the row's body failed but its own ROLLBACK succeeded — the row
    //     stays 'p' and is retried on the NEXT pull, because nothing about the shared handle is
    //     broken. This is the ONLY case the next pull is proven to recover (registrant-seeding-
    //     scope.spec.ts's CR-04 Test 5, second pull).
    //   - aborted (NOT transient): the row's own ROLLBACK failed, and Quereus's transaction model
    //     is flat and handle-global — an unclosed transaction would poison every later BEGIN on
    //     this handle (this row's remaining siblings, the next inbox mount, an approval's
    //     register(), a rejection's ceremony) with an error itself swallowed wherever it lands.
    //     ONE bounded recovery attempt is made; whether or not it succeeds, the pass STOPS
    //     (`break`, never a rethrow — see this method's own doc comment for why a rethrow here
    //     would re-brick the inbox, CR-01 verbatim) rather than continuing onto a handle whose
    //     transaction state is unknown. If the bounded recovery ALSO failed, the handle is left
    //     mid-transaction and reported as `handleInAutocommit === false` — that state persists
    //     until something OUTSIDE this method issues a real ROLLBACK or the handle is replaced; NO
    //     subsequent pull is claimed to recover it (registrant-seeding-scope.spec.ts's CR-04
    //     Test 6 asserts the stuck state, not a recovery).
    // The catch below logs NOTHING in either case: the bound params above carry request
    // identifiers, and logging on this surface is a closed security gate (T-48-08-02, T-48-30-04).
    // The tally is the only signal, and it is identifier-free by construction (see
    // RegistrantSeedOutcome's doc comment).
    for (const row of pendingRows) {
      try {
        // A request addressed to an authority with no current administration cannot be seeded —
        // one case of the general per-row-isolation rule this try/catch implements.
        const adminRow = await ctx.db
          .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
          .get({ authorityId: row.AuthorityId })
        if (!adminRow) { skipped++; continue }
        const adminEffectiveAt = adminRow.EffectiveAt as string | number

        // One fresh Tid per request, from 48-07's shared 'registration-request' namespace — the
        // SAME value feeds BOTH the Digest(...) expression below AND the extension INSERT's
        // context.Tid; MutationValid re-derives DG-4 from the joined RegistrationRequest using
        // context.Tid, and a mismatch fails the CHECK with an error that reads like a signature
        // problem, not a Tid one (mirrors election-engine.ts:910-925's BALLOT_HEADER_TID
        // discipline).
        const tid = await allocateTid(ctx.db, 'registration-request')
        const nonce = (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
        const taskId = (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
        const signerKey = ctx.user?.activeKeys?.[0]?.key ?? '0'.repeat(66)
        const placeholderSig = '0'.repeat(128)
        // nowCanonicalDatetime() is correct here and must NOT be "fixed" to toIsoZDatetime — it
        // feeds AdminSigning's pre-existing `now` context param, not a new Z-checked column; this
        // step writes no Z-checked column at all (48-02's hygiene rule pushes the opposite way for
        // NEW columns only).
        const now = nowCanonicalDatetime()

        // WR-06 (T-48-30-05): the AdminSigning('vrg') insert now shares ONE envelope with the
        // Task/extension inserts below. Before this fix it ran OUTSIDE the BEGIN/COMMIT — and
        // AdminSigning is `InsertOnly check on update, delete (false)`, so a row that failed
        // inside the envelope AFTER a successful AdminSigning insert became a permanent orphan.
        // With try/continue retrying a failed row on every future mount, that one-off orphan would
        // otherwise become unbounded growth driven entirely by unauthenticated input. Do NOT call
        // sign() here — the officer's real crypto arrives later at completeSignature as a SEPARATE
        // OfficerSignature row, never as a mutation of this one (999.1 R-02/R-04).
        await ctx.db.exec('BEGIN')
        try {
          await ctx.db.exec(
            `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
             with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
             values (:nonce, :authorityId, :adminEffectiveAt, 'vrg',
                     Digest(:tid, :requestId, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt),
                     :userId, :signerKey, :signature)`,
            {
              nonce,
              authorityId: row.AuthorityId,
              adminEffectiveAt,
              tid,
              requestId: row.Id,
              requesterKey: row.RequesterKey,
              issuerType: row.IssuerType,
              bridgeId: row.BridgeId,
              payloadCid: row.PayloadCid,
              submittedAt: row.SubmittedAt,
              userId,
              signerKey,
              signature: placeholderSig,
              now,
            }
          )
          await ctx.db.exec(
            `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
             with context IsMutationValid = true, Tid = :tid
             values (:id, :userId, 'signature', 'registrant', :nonce, 0)`,
            { id: taskId, userId, nonce, tid }
          )
          await ctx.db.exec(
            `insert into RegistrantSignatureTaskExtension (TaskId, RequestId)
             with context Tid = :tid
             values (:taskId, :requestId)`,
            { taskId, requestId: row.Id, tid }
          )
          await ctx.db.exec('COMMIT')
          seeded++
        } catch (err) {
          // CR-04 (T-48-33-01): attempt the ordinary ROLLBACK first. On success, rethrow the
          // ORIGINAL error unchanged — the ordinary per-row-failure path, preserved verbatim.
          try {
            await ctx.db.exec('ROLLBACK')
          } catch {
            // The ROLLBACK itself failed. Exactly ONE bounded recovery attempt, itself wrapped so
            // a second failure cannot escape as a different error shape — Quereus's transaction
            // model is flat, so the handle's OWN autocommit state is the only reliable signal of
            // whether anything is left open to close.
            try {
              if (!ctx.db.getAutocommit()) {
                await ctx.db.exec('ROLLBACK')
              }
            } catch {
              // Swallowed — the handle may still be mid-transaction; handleInAutocommit (below)
              // reports this truthfully rather than pretending recovery succeeded.
            }
            throw new SeedPassAborted()
          }
          throw err
        }
      } catch (err) {
        skipped++
        if (err instanceof SeedPassAborted) {
          aborted = true
          break
        }
        continue
      }
    }

    return {
      considered: pendingRows.length,
      seeded,
      skipped,
      aborted,
      handleInAutocommit: ctx.db.getAutocommit(),
    }
  }

  /**
   * TASK-04 — apply a signature via SigningEngine.sign() then mark the
   * Task complete. The two operations are NOT wrapped in a SQL
   * transaction here because SigningEngine.sign() opens its own
   * BEGIN/COMMIT envelope (AUTH-08). The order matters: signing must
   * succeed before the Task is marked complete so a failed signing
   * does not leave a "complete" task without a backing signature.
   */
  async completeSignature (
    task: SignatureTask,
    result: SignatureResult
  ): Promise<void> {
    this.requireCtx('completeSignature')
    if (!this.signingEngine) {
      throw new Error(
        'SignatureTasksEngine.completeSignature: no SigningEngine bound — construct with (networkRef, ctx)'
      )
    }
    // Read the SigningNonce off the Task row that this completion refers
    // to. The caller could supply it directly, but the IEngine surface
    // (SignatureTask) does not expose it; we look it up by (UserId,
    // SignatureType, !IsCompleted).
    // D-05 / CR-01: For ballot tasks, scope the lookup by the ballot id
    // carried on the BallotSignatureTask so that with >=2 pending ballot
    // tasks the correct task row (and therefore the correct AdminSigning
    // digest) is resolved — not an arbitrary LIMIT-1 row.
    let taskRow: { Id: string; SigningNonce: string } | undefined
    if (task.signatureType === 'ballot') {
      const ballotId = (task as BallotSignatureTask).ballot.proposed.id
      taskRow = await this.ctx!.db
        .prepare(
          `select Task.Id, Task.SigningNonce from Task
            join BallotSignatureTaskExtension E on E.TaskId = Task.Id
            where Task.UserId = :userId
              and Task.Type = 'signature'
              and Task.SignatureType = :signatureType
              and Task.IsCompleted = 0
              and E.BallotId = :ballotId
            limit 1`
        )
        .get({
          userId: task.userId,
          signatureType: task.signatureType,
          ballotId,
        }) as { Id: string; SigningNonce: string } | undefined
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.completeSignature: no pending ballot task for user=${task.userId} ballotId=${ballotId}`
        )
      }
    } else if (task.signatureType === 'registrant') {
      // L-3 (48-11): an officer legitimately has several pending registration requests at once —
      // scope the lookup by requestId, copying the 'ballot' branch's disambiguation shape above,
      // rather than the plain UserId + SignatureType lookup that would resolve an arbitrary LIMIT-1
      // row (and therefore complete the WRONG request's task).
      const requestId = (task as RegistrantSignatureTask).requestId
      taskRow = await this.ctx!.db
        .prepare(
          `select Task.Id, Task.SigningNonce from Task
            join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id
            where Task.UserId = :userId
              and Task.Type = 'signature'
              and Task.SignatureType = :signatureType
              and Task.IsCompleted = 0
              and E.RequestId = :requestId
            limit 1`
        )
        .get({
          userId: task.userId,
          signatureType: task.signatureType,
          requestId,
        }) as { Id: string; SigningNonce: string } | undefined
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.completeSignature: no pending registrant task for user=${task.userId} requestId=${requestId}`
        )
      }
    } else {
      taskRow = await this.ctx!.db
        .prepare(
          `select Id, SigningNonce from Task
            where UserId = :userId
              and Type = 'signature'
              and SignatureType = :signatureType
              and IsCompleted = 0
            limit 1`
        )
        .get({
          userId: task.userId,
          signatureType: task.signatureType,
        }) as { Id: string; SigningNonce: string } | undefined
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.completeSignature: no pending task for user=${task.userId} signatureType=${task.signatureType}`
        )
      }
    }
    const nonce = taskRow.SigningNonce as string

    // WR-19 (T-48-34-01/02/05): registrant pre-sign gate — runs BEFORE signingEngine.sign() below,
    // so a payload guaranteed to be refused (CR-02, CR-03) or a malformed accept (missing
    // result.sign, missing result.decision) never spends the officer's real header signature. This
    // is the FIRST of resolveAcceptableRegistrantApproval's two call sites; the SECOND is inside
    // finalizeRegistrantApproval itself, as defence in depth for any future caller that reaches it
    // directly — one gate, two call sites, zero duplicated SQL or message text, so the two cannot
    // drift apart (T-48-34-05). Because THIS call site runs first, a refused approval creates no
    // OfficerSignature/AdminSignature row (SigningEngine's own BEGIN/COMMIT, further down, never
    // opens) and the accept path stays retryable via a second accept attempt — the exact ordering
    // defect WR-19 closes.
    //
    // Both malformed-accept shapes are refused HERE too, moved up as one adjacent pair (never
    // duplicated, never split across the sign() call below) — each is independently
    // regression-tested (the malformed-accept case in registrant-approval.spec.ts covers missing
    // result.sign AND missing result.decision separately), so a later reader cannot assume one
    // covers the other.
    //
    // WR-05 is NOT fixed by this gate: signingEngine.sign() is still not idempotent on
    // (SigningNonce, UserId), so a finalize failure this gate cannot foresee — a register() CHECK
    // failure, a storage error, arising AFTER this gate passes but before finalize completes —
    // still leaves the task un-retryable via accept, recoverable only by rejecting. That failure
    // class stays open; this gate only removes the requester-CHOOSABLE trigger.
    if (result.isAccepted && task.signatureType === 'registrant') {
      // L-2 (48-11): the accept path REQUIRES the reusable per-digest callback — DG-2 is signed at
      // decision time, and there is no placeholder fallback on this path. An approval whose
      // checklist is covered by nothing is exactly the failure D-07 exists to prevent; do not
      // substitute a placeholder signature here.
      if (!result.sign) {
        throw new Error(
          'SignatureTasksEngine.completeSignature: registrant accept requires result.sign (a reusable per-digest signing callback) — none supplied'
        )
      }
      // The D-07 checklist is what VerificationCid is derived from — there is no legal approval
      // without one.
      if (!result.decision) {
        throw new Error(
          'SignatureTasksEngine.completeSignature: registrant accept requires result.decision (the D-07 verification checklist) — none supplied'
        )
      }
      try {
        await this.resolveAcceptableRegistrantApproval(taskRow.Id as string)
      } catch (err) {
        this.rethrow(err, 'completeSignature (registrant pre-check)')
      }
    }

    // D-12: Branch on result.isAccepted.
    // Accept path only — call sign() to insert OfficerSignature and (at threshold=1)
    // auto-complete AdminSignature. Do NOT call sign() on reject: a rejection that
    // advances the signing session is a critical integrity hole (D-12 threat).
    if (result.isAccepted) {
      await this.signingEngine.sign(nonce, result.signature)
    }

    // Ballot finalize branch (D-01, D-08): after sign() succeeds (AdminSignature inserted at
    // threshold=1), INSERT Ballot first then per-row signed Questions and Options.
    // This runs BEFORE the Task-complete update so options are promoted before the Task closes.
    if (result.isAccepted && task.signatureType === 'ballot') {
      try {
        // 39-03 (DEBT-11, D-06): thread the caller's optional reusable
        // per-digest signing callback into finalizeBallot so per-row
        // Question/Option AdminSigning rows can carry a REAL signature
        // instead of the legacy placeholder (see SignatureResult.sign doc).
        await this.finalizeBallot(taskRow.Id as string, nonce, result.sign)
      } catch (err) {
        this.rethrow(err, 'completeSignature (finalize)')
      }
    }

    // Registrant finalize branch (D-05, D-07): after sign() succeeds (the officer's header
    // signature over DG-4), drive the D-07 decision ceremony and the byte-unchanged register()
    // BEFORE the Task-complete update — mirrors finalizeBallot's call-site placement immediately
    // above. Do NOT touch the reject path: result.isAccepted === false must continue to skip
    // sign(), skip this block entirely, and fall through to the unconditional task-complete update
    // — 48-12 owns the reject ceremony (RegistrationEngine.rejectRegistrationRequest), not this file.
    //
    // D-12 (48-12): a rejection that advances the signing session is a critical integrity hole —
    // the SAME sentence guarding sign() above, carried verbatim onto this branch, because the
    // registrant-specific consequence is sharper here than on any other signature type. If this
    // guard's `result.isAccepted &&` were ever dropped, the completed 'vrg' AdminSigning session
    // (from sign(), above) would drive finalizeRegistrantApproval -> the unchanged register(), so a
    // rejection that advanced the session would CREATE THE VERY Registrant THE OFFICER REFUSED —
    // silently, with the request row still reading Status = 'r'. That failure would be invisible
    // to anyone reading only RegistrationRequest.Status.
    //
    // result.sign/result.decision were already validated above, before sign() — do not re-check
    // them here.
    if (result.isAccepted && task.signatureType === 'registrant') {
      try {
        await this.finalizeRegistrantApproval(taskRow.Id as string, result.decision!, result.sign!)
      } catch (err) {
        this.rethrow(err, 'completeSignature (finalize registrant)')
      }
    }

    // Mark the task complete (unconditional — both accept and reject close the task).
    const tid = await allocateTid(this.ctx!.db, 'signature-tasks')
    try {
      await this.ctx!.db.exec(
				`update Task
				with context IsMutationValid = true, Tid = ${tid}
					set IsCompleted = 1
				where Id = :id`,
        {
          id: taskRow.Id as string,
        }
      )
    } catch (err) {
      this.rethrow(err, 'completeSignature')
    }
  }

  /**
   * D-01/D-08 — Finalize a ballot after the signing threshold is reached.
   *
   * Ordering (Ballot-first, D-08):
   *   1. Read ProposedBallot row.
   *   2. INSERT Ballot header (BALLOT_HEADER_TID for digest parity with submit — Pitfall 2).
   *   3. For each question: AdminSigning('ceb') + sign() + INSERT Question.
   *   4. For each option of each question: AdminSigning('ceb') + sign() + INSERT Option.
   *
   * D-04: ProposedBallot is NOT deleted.
   * Pitfall 3: Ballot.MutationValid gates on BallotDeadline > now (schema-enforced).
   */
  private async finalizeBallot (
    taskId: string,
    headerNonce: string,
    sign?: (digest: Uint8Array) => Promise<Signature>
  ): Promise<void> {
    // Resolve the BallotId by joining to BallotSignatureTaskExtension.
    const extRow = await this.ctx!.db
      .prepare('select BallotId from BallotSignatureTaskExtension where TaskId = :taskId')
      .get({ taskId })
    if (!extRow) {
      throw new Error(`SignatureTasksEngine.finalizeBallot: no BallotSignatureTaskExtension for taskId=${taskId}`)
    }
    const ballotId = extRow.BallotId as string

    // Step 1: read ProposedBallot
    const pbRow = await this.ctx!.db
      .prepare(
        `select Id, ElectionId, AuthorityId, Description, Districts, Questions
           from ProposedBallot where Id = :ballotId`
      )
      .get({ ballotId }) as {
        Id: string
        ElectionId: string
        AuthorityId: string
        Description: string
        Districts: string
        Questions: string | null
      } | undefined

    if (!pbRow) {
      throw new Error(`SignatureTasksEngine.finalizeBallot: ProposedBallot not found for id=${ballotId}`)
    }

    const now = nowCanonicalDatetime()

    // Step 2: INSERT Ballot row FIRST (Ballot-first, D-08).
    // Bind the SAME BALLOT_HEADER_TID constant used at submit so Ballot.MutationValid's
    // Digest(context.Tid, …) matches the AdminSigning.Digest baked in at submitBallotForConfirmation
    // (Pitfall 2). The same nonce (headerNonce) + same Description/Districts from ProposedBallot
    // reproduces the byte-identical digest tuple.
    await this.ctx!.db.exec(
      `insert into Ballot (Id, ElectionId, AuthorityId, Description, Districts)
       with context SigningNonce = :nonce, Tid = :headerTid, now = :now
       values (:id, :electionId, :authorityId, :description, :districts)`,
      {
        nonce: headerNonce,
        headerTid: BALLOT_HEADER_TID,
        id: pbRow.Id,
        electionId: pbRow.ElectionId,
        authorityId: pbRow.AuthorityId,
        description: pbRow.Description,
        districts: pbRow.Districts,
        now,
      }
    )

    // Resolve AdminEffectiveAt for per-question/option AdminSigning inserts.
    const adminRow = await this.ctx!.db
      .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
      .get({ authorityId: pbRow.AuthorityId })
    if (!adminRow) {
      throw new Error(`SignatureTasksEngine.finalizeBallot: CurrentAdmin not found for authorityId=${pbRow.AuthorityId}`)
    }
    const adminEffectiveAt = adminRow.EffectiveAt as string | number

    const questions = parseJsonOr<Question[]>(pbRow.Questions, [], 'ProposedBallot.Questions')

    // Step 3+4: per-question and per-option promotion (D-08 question + option path).
    for (const q of questions) {
      // Resolve defaults JS-side (mirrors seedQuestion's Pitfall 4 fix — avoids binding NULL into
      // default-valued columns, which trips the Quereus 3.3.0 NULL-bug):
      const dependsOn = q.dependsOn ? JSON.stringify(q.dependsOn) : null
      const optionRange = q.optionRange ? JSON.stringify(q.optionRange) : '{1, 1}'
      const scoreRange = q.scoreRange ? JSON.stringify(q.scoreRange) : null
      const grouping = q.group ?? null
      const sequence = q.sequence ?? null
      // Required is now `integer default 1` (37-04 / D-05b re-attach fix — was
      // `boolean default true`). Bind an integer 0/1 (not a JS boolean) into
      // BOTH the Digest call below and the Question INSERT so the recomputed
      // Question.MutationValid Digest matches the AdminSigning Digest — the
      // same single-source-of-truth pattern as the number-column Digest
      // coercion class (see schema-type-regression.spec.ts).
      const required = (q.required ?? true) ? 1 : 0
      // Select beachhead — only 'select' type supported (Pitfall 5 / quereus#21 deferral).
      const questionType = (q.type === 'select') ? 'select' : q.type

      // Step 3a: per-question AdminSigning('ceb') with 12-arg Question digest
      // (matches Question.MutationValid at qsql:725-734).
      //
      // 39-03 (DEBT-11, D-06 resolution 1): when the caller supplies a reusable
      // per-digest `sign` callback (mirrors seedElectionRevisionSigning's own
      // compute-Digest-via-SQL -> await sign(bytes) -> bind pattern), produce a
      // REAL secp256k1 signature over this row's own canonical Digest and bind
      // IsPlaceholderSignature = false so AdminSigning.SignatureValid (999.1-07)
      // actually verifies it. Only fall back to the legacy placeholder when no
      // callback is supplied (documented category-① path for callers that have
      // not yet threaded one — e.g. `debugSeedPendingTasks`).
      const qDigestArgs = {
        ballotId,
        code: q.code,
        title: q.title,
        instructions: q.instructions,
        dependsOn,
        type: questionType,
        optionRange,
        scoreRange,
        grouping,
        sequence,
        required,
      }
      const {
        userId: qUserId,
        signerKey: qSignerKey,
        signature: qSignature,
        isPlaceholder: qIsPlaceholder,
      } = await this.resolveRowSignature(
        'select Digest(1, :ballotId, :code, :title, :instructions, :dependsOn, :type, :optionRange, :scoreRange, :grouping, :sequence, :required) as d',
        qDigestArgs,
        'Question',
        sign
      )
      const qNonce = (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
      await this.ctx!.db.exec(
        `insert into AdminSigning (
          Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
        )
        with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = :isPlaceholderSignature
        values (
          :nonce, :authorityId, :adminEffectiveAt, 'ceb',
          Digest(1, :ballotId, :code, :title, :instructions, :dependsOn, :type, :optionRange, :scoreRange, :grouping, :sequence, :required),
          :userId, :signerKey, :signature
        )`,
        {
          nonce: qNonce,
          authorityId: pbRow.AuthorityId,
          adminEffectiveAt,
          ...qDigestArgs,
          userId: qUserId,
          signerKey: qSignerKey,
          signature: qSignature,
          isPlaceholderSignature: qIsPlaceholder,
          now,
        }
      )

      // Step 3b: sign to create AdminSignature (threshold=1 auto-completes)
      // 999.1 R-02/R-04 (DEBT-11): same real-vs-placeholder branch as above — the
      // OfficerSignature counter-signature verifies against this SAME AdminSigning
      // Digest (OfficerSignature.SignatureValid), so reuse the identical signature
      // bytes when real-signed.
      const qSig = {
        signerUserId: qUserId ?? '',
        signerKey: qSignerKey,
        signature: qSignature,
      }
      await this.signingEngine!.sign(qNonce, qSig, { isPlaceholderSignature: qIsPlaceholder })

      // Step 3c: INSERT Question row (Ballot must already exist — BallotIdValid constraint, D-08)
      await this.ctx!.db.exec(
        `insert into Question (
          BallotId, Code, Title, Instructions, DependsOn, Type,
          OptionRange, ScoreRange, Grouping, Sequence, Required
        )
        with context SigningNonce = :nonce, Tid = 1, now = :now
        values (
          :ballotId, :code, :title, :instructions, :dependsOn, :type,
          :optionRange, :scoreRange, :grouping, :sequence, :required
        )`,
        {
          nonce: qNonce,
          ballotId,
          code: q.code,
          title: q.title,
          instructions: q.instructions,
          dependsOn,
          type: questionType,
          optionRange,
          scoreRange,
          grouping,
          sequence,
          required,
          now,
        }
      )

      // Step 4: per-option promotion — INSERT AFTER the parent Question (D-08, CLOSED).
      //
      // D-08 was previously deferred because Option.Sequence was declared `Sequence number`,
      // and Quereus 3.3.0 coerces any JS integer bound to a `number`-typed column to a blob
      // in vtab storage. The deferred MutationValid CHECK then read that blob and recomputed a
      // different Digest than the integer-valued Digest stored in AdminSigning at INSERT time,
      // failing the constraint. The schema fix (Option.Sequence → `integer null`, matching the
      // Question table and the table's own SequenceValid `typeof = 'integer'` check) makes an
      // integer round-trip as an integer, so the AdminSigning Digest and the deferred
      // MutationValid Digest now match. (The `number`→`integer null` change is a no-cost
      // correction — no Option rows were ever persisted before this fix.)
      //
      // Option.MutationValid digest: Digest(context.Tid, new.BallotId, new.QuestionCode,
      //   new.Code, new.Sequence, new.Title, new.Details, new.InfoURL, new.Image, new.Video).
      // Each Option INSERT is a separate db.exec call (parent Ballot/Question already committed).
      const qOptions = q.options ?? []
      for (let oi = 0; oi < qOptions.length; oi++) {
        const o = qOptions[oi]!
        const oSequence = oi
        const oDetails = o.details ?? null
        const oInfoURL = o.infoURL ?? null
        const oImage = o.image ? JSON.stringify(o.image) : null
        const oVideo = o.video ? JSON.stringify(o.video) : null

        // Step 4a: per-option AdminSigning('ceb') with the 10-arg Option digest
        //
        // 39-03 (DEBT-11, D-06 resolution 1): same real-vs-placeholder branch as the
        // Question path above — real-sign when the caller supplied a `sign` callback,
        // else fall back to the documented placeholder.
        const oDigestArgs = {
          ballotId,
          questionCode: q.code,
          code: o.code,
          sequence: oSequence,
          title: o.title,
          details: oDetails,
          infoURL: oInfoURL,
          image: oImage,
          video: oVideo,
        }
        const {
          userId: oUserId,
          signerKey: oSignerKey,
          signature: oSignature,
          isPlaceholder: oIsPlaceholder,
        } = await this.resolveRowSignature(
          'select Digest(1, :ballotId, :questionCode, :code, :sequence, :title, :details, :infoURL, :image, :video) as d',
          oDigestArgs,
          'Option',
          sign
        )
        const oNonce = (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
        try {
          await this.ctx!.db.exec(
            `insert into AdminSigning (
              Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
            )
            with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = :isPlaceholderSignature
            values (
              :nonce, :authorityId, :adminEffectiveAt, 'ceb',
              Digest(1, :ballotId, :questionCode, :code, :sequence, :title, :details, :infoURL, :image, :video),
              :userId, :signerKey, :signature
            )`,
            {
              nonce: oNonce,
              authorityId: pbRow.AuthorityId,
              adminEffectiveAt,
              ...oDigestArgs,
              userId: oUserId,
              signerKey: oSignerKey,
              signature: oSignature,
              isPlaceholderSignature: oIsPlaceholder,
              now,
            }
          )
        } catch (err) {
          this.rethrow(err, 'finalizeBallot (option AdminSigning)')
        }

        // Step 4b: sign to create AdminSignature (threshold=1 auto-completes)
        // 999.1 R-02/R-04 (DEBT-11): reuse the same real signature bytes as the
        // AdminSigning row above (OfficerSignature verifies against that same Digest).
        const oSig = {
          signerUserId: oUserId ?? '',
          signerKey: oSignerKey,
          signature: oSignature,
        }
        await this.signingEngine!.sign(oNonce, oSig, { isPlaceholderSignature: oIsPlaceholder })

        // Step 4c: INSERT Option row (Ballot + parent Question already exist — constraints satisfied)
        try {
          await this.ctx!.db.exec(
            `insert into Option (
              BallotId, QuestionCode, Code, Sequence, Title, Details, InfoURL, Image, Video
            )
            with context SigningNonce = :nonce, Tid = 1, now = :now
            values (
              :ballotId, :questionCode, :code, :sequence, :title, :details, :infoURL, :image, :video
            )`,
            {
              nonce: oNonce,
              ballotId,
              questionCode: q.code,
              code: o.code,
              sequence: oSequence,
              title: o.title,
              details: oDetails,
              infoURL: oInfoURL,
              image: oImage,
              video: oVideo,
              now,
            }
          )
        } catch (err) {
          this.rethrow(err, 'finalizeBallot (option)')
        }
      }
    }
    // D-04: ProposedBallot is NOT deleted — retained for history.
  }

  /**
   * WR-19 (T-48-34-01..-05) — the single payload-acceptability gate for a registrant approval.
   * Called from TWO sites: `completeSignature`, BEFORE `signingEngine.sign()` consumes the
   * officer's real header signature (the fix), and again from `finalizeRegistrantApproval` itself,
   * as defence in depth for any future caller that reaches finalize directly. One gate, two call
   * sites, zero duplicated SQL or message text — a grep gate (`registrant-approval.spec.ts`'s own
   * regression coverage plus this plan's acceptance criteria) keeps them from drifting apart.
   *
   * Resolves the request by joining the extension row — finalizeBallot's own opening shape.
   * SubmittedAt/ReceivedAt are read here too: the decision UPDATE further down (in
   * finalizeRegistrantApproval) must explicitly rebind them (a partial UPDATE that leaves them
   * unbound — or even self-referencing, `SubmittedAt = SubmittedAt` — makes Quereus re-validate the
   * unqualified SubmittedAtValid/ReceivedAtValid CHECKs against a Z-STRIPPED reconstruction of the
   * row, a real, empirically-confirmed defect class this phase discovered; T-42-06 documents the
   * same stripping for plain reads). restoreCanonicalDatetime (below) reconstructs the exact
   * fixed-3-digit-millisecond, Z-suffixed byte form every write in this codebase produces via
   * toIsoZDatetime, which SubmittedAt must match byte-for-byte — RegistrationRequest.SignatureValid
   * is UNQUALIFIED (re-evaluates on every update, not just insert) and recomputes
   * Digest(Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid, SubmittedAt) against
   * the REQUESTER's original signature, so a merely Z-suffixed-but-truncated SubmittedAt would
   * silently break that verification.
   *
   * Refuses:
   *  - a missing extension row, a non-pending RegistrationRequest, or an unparseable Payload;
   *  - CR-02 (T-48-31-01): init.registrant.authorityId is chosen by the UNAUTHENTICATED requester
   *    (D-02) and covered only by the requester's own signature. RegistrationEngine.register()'s
   *    only cross-authority guard compares the payload against an ELECTION's authority
   *    (register(), registration-engine.ts's electionAuthorityId check) and cannot see the
   *    authority THIS request was addressed to. The only authority this approval may mint a
   *    Registrant under is extRow.AuthorityId — the one whose officer is signing DG-2 in
   *    finalizeRegistrantApproval;
   *  - CR-03 (T-48-31-02): init.registrant.id is also requester-chosen. register() is unconditional
   *    (see finalizeRegistrantApproval's own comment for why the old convergence guard is gone
   *    rather than merely relocated) — refuse the id collision here, exactly like CR-02 above.
   *
   * WR-19 is closed by WHERE this gate is called from completeSignature (before sign()), not by
   * anything in this method's own body — this method's refusals are the same whether they run
   * before or after a signature was spent. WR-05 is NOT fixed by this gate: signingEngine.sign()
   * is still not idempotent on (SigningNonce, UserId), so a finalize failure this gate cannot
   * foresee — a register() CHECK failure, a storage error, arising AFTER this gate passes but
   * before finalize completes — still leaves the task un-retryable via accept, recoverable only by
   * rejecting.
   */
  private async resolveAcceptableRegistrantApproval (taskId: string): Promise<{
    requestId: string
    authorityId: string
    init: RegisterInit
    submittedAt: string
    receivedAt: string
  }> {
    const ctx = this.ctx!
    const extRow = await ctx.db
      .prepare(
        `select E.RequestId, R.AuthorityId, R.Payload, R.Status, R.SubmittedAt, R.ReceivedAt
           from RegistrantSignatureTaskExtension E
             join RegistrationRequest R on R.Id = E.RequestId
           where E.TaskId = :taskId`
      )
      .get({ taskId }) as {
        RequestId: string
        AuthorityId: string
        Payload: string
        Status: string
        SubmittedAt: string
        ReceivedAt: string
      } | undefined
    if (!extRow) {
      throw new Error(`SignatureTasksEngine.resolveAcceptableRegistrantApproval: no RegistrantSignatureTaskExtension for taskId=${taskId}`)
    }
    const requestId = extRow.RequestId
    const submittedAt = restoreCanonicalDatetime(extRow.SubmittedAt)
    const receivedAt = restoreCanonicalDatetime(extRow.ReceivedAt)

    // A decided request is not re-decidable — DecisionValid enforces this too; this engine-side
    // check exists only to produce an attributable error, not as the actual boundary.
    if (extRow.Status !== 'p') {
      throw new Error(
        `SignatureTasksEngine.resolveAcceptableRegistrantApproval: RegistrationRequest ${requestId} is not pending (Status=${extRow.Status})`
      )
    }

    const init = parseJsonOr<RegisterInit | undefined>(extRow.Payload, undefined, 'RegistrationRequest.Payload')
    if (!init) {
      throw new Error(`SignatureTasksEngine.resolveAcceptableRegistrantApproval: RegistrationRequest ${requestId} Payload failed to parse`)
    }

    if (init.registrant?.authorityId !== extRow.AuthorityId) {
      throw new Error(
        `SignatureTasksEngine.resolveAcceptableRegistrantApproval: RegistrationRequest ${requestId} payload registers under authority ${String(init.registrant?.authorityId)}, not the addressed authority ${extRow.AuthorityId}`
      )
    }

    const existingRegistrant = await ctx.db
      .prepare('select 1 from Registrant where Id = :id')
      .get({ id: init.registrant.id })
    if (existingRegistrant) {
      throw new Error(
        `SignatureTasksEngine.resolveAcceptableRegistrantApproval: RegistrationRequest ${requestId} payload names an already-existing Registrant record that this approval did not create`
      )
    }

    return { requestId, authorityId: extRow.AuthorityId, init, submittedAt, receivedAt }
  }

  /**
   * D-05/D-07 — the registrant accept ceremony. `RegistrationEngine.register()` is reused
   * COMPLETELY UNCHANGED — it was always correct, and the defect this phase corrects was only
   * ever that the voter app supplied a founding-officer key it held. This method changes WHO
   * DRIVES `register()`, not what `register()` does. A second `register()`-shaped write path
   * (an inline `insert into Registrant`, a copy of `register()`'s body, etc.) must never be
   * created here.
   */
  private async finalizeRegistrantApproval (
    taskId: string,
    decision: RegistrationRequestDecision,
    sign: (digest: Uint8Array) => Promise<Signature>
  ): Promise<void> {
    const ctx = this.ctx!

    // T-48-34-05: defence in depth — completeSignature already calls this SAME gate BEFORE
    // signingEngine.sign() (T-48-34-01/02), so by the time execution reaches here the payload has
    // already been proven acceptable. This second call exists so a future caller that reaches
    // finalizeRegistrantApproval directly gets the SAME refusals from the SAME producer — never a
    // duplicated or drifted copy of the CR-02/CR-03 checks.
    const { requestId, authorityId, init, submittedAt, receivedAt } = await this.resolveAcceptableRegistrantApproval(taskId)

    const tid = await allocateTid(ctx.db, 'registration-request')

    // D-07: derive VerificationCid through 48-06's injected-digest helper — never a hand-rolled JS
    // hash. The callback runs the SAME select cid(Digest(:canonical)) call shape
    // computeRegistrantPrivateCid uses.
    const cid = await verificationCid(decision.checklist, async (canonical: string) => {
      const row = await ctx.db.prepare('select cid(Digest(:canonical)) as c').get({ canonical })
      if (!row || row.c == null) {
        throw new Error('SignatureTasksEngine.finalizeRegistrantApproval: cid(Digest(...)) returned null — crypto plugin not registered?')
      }
      return row.c as string
    })

    // DecidedAt must carry a trailing 'Z' (DecidedAtValid's like('%Z', ...)) — toIsoZDatetime, NEVER
    // nowCanonicalDatetime() (48-02 hygiene item 3).
    const decidedAt = toIsoZDatetime(Date.now())
    const decidingOfficerUserId = ctx.user?.id ?? null

    // DG-2, field for field: Digest(context.Tid, new.Id, new.Status, new.VerificationCid,
    // new.DecidedAt, new.DecidingOfficerUserId, new.RejectionReason). rejectionReason binds null and
    // the UPDATE below leaves the column null, so the digested tuple and the stored row agree.
    // `decidingOfficerUserId` is a DELIBERATE defensive rename — bare `userId` is one of
    // seedSignedMutation's eight reserved bind names and would be silently overwritten by the
    // helper's own ceremony binds (the real Phase 42-03 bug; registration-engine.ts NOTE 1).
    //
    // T-42-03: RegistrationRequest.DecisionValid contains a subquery, so it is a DEFERRED CHECK —
    // Quereus re-derives `new.DecidedAt` from a Temporal.PlainDateTime-coerced snapshot (Z
    // stripped, fractional seconds at MINIMAL precision) when it re-evaluates at COMMIT. The
    // digest bound into AdminSigning.Digest (below, via seedSignedMutation) MUST use that SAME
    // coerced form or DecisionValid's re-derivation will never match the stored Digest — this is
    // the prior-attempt trap: it surfaces as "CHECK constraint failed: DecisionValid" and reads
    // like a signature bug, not a datetime-formatting one. The STORED DecidedAt column (the UPDATE
    // below) still uses the RAW toIsoZDatetime value — only the DIGEST argument is coerced.
    const decidedAtForDigest = toDeferredCheckDatetime(decidedAt)
    const digestExpr = 'select Digest(:tid, :requestId, :status, :verificationCid, :decidedAt, :decidingOfficerUserId, :rejectionReason) as d'
    const digestParams = {
      tid,
      requestId,
      status: 'a',
      verificationCid: cid,
      decidedAt: decidedAtForDigest,
      decidingOfficerUserId,
      rejectionReason: null,
    }

    // The reviewing officer's OWN reusable per-digest callback produces a real signature over
    // DG-2 — this is the D-07 weld: VerificationCid rides inside the SAME digest as Status/
    // DecidedAt/DecidingOfficerUserId/RejectionReason, so the officer's real signature
    // transitively covers the checklist. This runs under a 'vrg'-scoped AdminSigning ceremony —
    // AdminSigning.UserIdValid requires merely that the signer be some officer at that authority —
    // it does not require a 'vrg'-scoped officer specifically (Phase 999.1).
    const decisionNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, sign)

    // register()-then-decide ordering: register() opens its own BEGIN/COMMIT envelope and cannot
    // share a transaction with the decision UPDATE below, so the two are ordered register()-then-
    // decide. register() is now UNCONDITIONAL — the CR-03 existence refusal in
    // resolveAcceptableRegistrantApproval already ruled out an id collision, so there is nothing
    // left to converge on here.
    //
    // T-48-11-11 (superseded, and superseded AGAIN by WR-19/T-48-34): the previous existence-gated
    // guard around this call was justified as making a RETRIED approval converge instead of
    // colliding on the Registrant primary key. That reasoning is still correct as far as it goes —
    // completeSignature calls sign() (this task's header signature) BEFORE
    // finalizeRegistrantApproval runs, and OfficerSignature's primary key is (SigningNonce, UserId)
    // with a fixed per-task SigningNonce, so a retried approval used to collide on that PK long
    // before it would ever reach this guard — but its conclusion no longer applies to a REFUSED
    // approval as of this plan: resolveAcceptableRegistrantApproval is now ALSO called from
    // completeSignature, before sign() ever runs, so a payload this method would refuse never
    // reaches that PK-collision ordering at all — the officer's signature is never spent, and a
    // retried accept raises the SAME refusal rather than a UNIQUE constraint error. Removing the
    // guard here therefore removes no behaviour that was reachable; it only stops an id collision
    // from being laundered into a silent no-op success. WR-05 (a finalize failure AFTER this gate
    // passes leaves this task un-retryable) is a separate, still-open concern this change does not
    // fix.
    // RegistrationEngine.register() — reused COMPLETELY UNCHANGED, with the reviewing officer's
    // own device-signer callback. No wrapper, no reimplementation, no inline Registrant insert.
    await new RegistrationEngine(ctx).register(init, sign)

    await ctx.db.exec(
      // SubmittedAt/ReceivedAt are explicitly rebound (restoreCanonicalDatetime, above) rather than
      // left untouched or self-referenced (`SubmittedAt = SubmittedAt`) — empirically, EITHER of
      // those leaves Quereus's unqualified SubmittedAtValid/ReceivedAtValid CHECKs evaluating a
      // Z-stripped reconstruction of the row on this UPDATE (a real, previously-undiscovered defect
      // class this plan surfaced; T-42-06 documents the same stripping for plain reads elsewhere).
      `update RegistrationRequest
       with context SigningNonce = :signingNonce, Tid = ${tid}
       set Status = 'a', VerificationCid = :verificationCid, DecidedAt = :decidedAt, DecidingOfficerUserId = :decidingOfficerUserId,
           SubmittedAt = :submittedAt, ReceivedAt = :receivedAt
       where Id = :requestId`,
      {
        signingNonce: decisionNonce,
        verificationCid: cid,
        decidedAt,
        decidingOfficerUserId,
        submittedAt,
        receivedAt,
        requestId,
      }
    )
  }

  /**
   * D-03 — Return the engine-authoritative `AdminSigning.Digest` bytes for the
   * pending task. The screen passes these bytes to the device-signer callback
   * and never recomputes any canonical form itself.
   *
   * Look-up mirrors the task-row query used by `completeSignature` (same
   * `(userId, signatureType, IsCompleted=0)` filter). Then reads
   * `AdminSigning.Digest` for that nonce and converts via `digestToBytes`
   * (the same helper used throughout the engine for the Digest → Uint8Array
   * conversion, WR-01 single source of truth).
   *
   * No key material enters this method — only bytes are returned (D-01/D-03).
   */
  async getSignatureDigest (task: SignatureTask): Promise<Uint8Array> {
    this.requireCtx('getSignatureDigest')
    // D-05 / CR-01: For ballot tasks, scope the lookup by the ballot id
    // carried on the BallotSignatureTask so that with >=2 pending ballot
    // tasks the correct AdminSigning.Digest is returned — not an arbitrary
    // LIMIT-1 row.
    let taskRow: { Id: string; SigningNonce: string } | undefined
    if (task.signatureType === 'ballot') {
      const ballotId = (task as BallotSignatureTask).ballot.proposed.id
      taskRow = await this.ctx!.db
        .prepare(
          `select Task.Id, Task.SigningNonce from Task
            join BallotSignatureTaskExtension E on E.TaskId = Task.Id
            where Task.UserId = :userId
              and Task.Type = 'signature'
              and Task.SignatureType = :signatureType
              and Task.IsCompleted = 0
              and E.BallotId = :ballotId
            limit 1`
        )
        .get({
          userId: task.userId,
          signatureType: task.signatureType,
          ballotId,
        }) as { Id: string; SigningNonce: string } | undefined
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.getSignatureDigest: no pending ballot task for user=${task.userId} ballotId=${ballotId}`
        )
      }
    } else if (task.signatureType === 'registrant') {
      // L-3 (48-11): the SHARPER of the two disambiguation defects — left unscoped, an officer
      // with two pending registration requests would be shown, and would SIGN, the digest
      // belonging to the WRONG request. Scope by requestId exactly like the 'ballot' branch above.
      const requestId = (task as RegistrantSignatureTask).requestId
      taskRow = await this.ctx!.db
        .prepare(
          `select Task.Id, Task.SigningNonce from Task
            join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id
            where Task.UserId = :userId
              and Task.Type = 'signature'
              and Task.SignatureType = :signatureType
              and Task.IsCompleted = 0
              and E.RequestId = :requestId
            limit 1`
        )
        .get({
          userId: task.userId,
          signatureType: task.signatureType,
          requestId,
        }) as { Id: string; SigningNonce: string } | undefined
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.getSignatureDigest: no pending registrant task for user=${task.userId} requestId=${requestId}`
        )
      }
    } else {
      taskRow = await this.ctx!.db
        .prepare(
          `select Id, SigningNonce from Task
            where UserId = :userId
              and Type = 'signature'
              and SignatureType = :signatureType
              and IsCompleted = 0
            limit 1`
        )
        .get({
          userId: task.userId,
          signatureType: task.signatureType,
        }) as { Id: string; SigningNonce: string } | undefined
      if (!taskRow) {
        throw new Error(
          `SignatureTasksEngine.getSignatureDigest: no pending task for user=${task.userId} signatureType=${task.signatureType}`
        )
      }
    }
    const nonce = taskRow.SigningNonce as string
    const signingRow = await this.ctx!.db
      .prepare('select Digest from AdminSigning where Nonce = :nonce')
      .get({ nonce })
    if (!signingRow) {
      throw new Error(
        `SignatureTasksEngine.getSignatureDigest: no AdminSigning row for nonce=${nonce}`
      )
    }
    try {
      return digestToBytes(signingRow.Digest)
    } catch (err) {
      this.rethrow(err, 'getSignatureDigest')
    }
  }

  buildCompleteSignature (): ISignatureTasksCompleteSignatureBuilder {
    return new CompleteSignatureBuilder(this)
  }

  // ---------- helpers ----------

  /**
   * IN-01 (39-REVIEW): shared real-vs-placeholder signature resolution for
   * finalizeBallot's per-Question and per-Option AdminSigning rows. Extracted
   * from what was previously two near-identical inline `let`-block copies —
   * behavior-preserving: the digest SQL and arg map passed in by each call
   * site are unchanged from the original inline code, so the signed digest
   * bytes and persisted Digest remain byte-for-byte identical to before.
   *
   * When `sign` is supplied, computes the row's canonical Digest via SQL,
   * invokes the caller's per-digest signer, and returns a REAL signature with
   * `isPlaceholder: false`. Otherwise falls back to the legacy placeholder
   * (documented category-① path — e.g. `debugSeedPendingTasks`).
   */
  private async resolveRowSignature (
    digestSql: string,
    digestArgs: Record<string, SqlValue>,
    rowLabel: string,
    sign?: (digest: Uint8Array) => Promise<Signature>
  ): Promise<{ userId: string | null; signerKey: string; signature: string; isPlaceholder: boolean }> {
    let userId = this.ctx!.user?.id ?? null
    let signerKey = this.ctx!.user?.activeKeys?.[0]?.key ?? '0'.repeat(66)
    let signature = '0'.repeat(128)
    let isPlaceholder = true
    if (sign) {
      const digestRow = await this.ctx!.db.prepare(digestSql).get(digestArgs)
      if (!digestRow || digestRow.d == null) {
        throw new Error(`SignatureTasksEngine.finalizeBallot: ${rowLabel} Digest() returned null`)
      }
      const digestBytes = digestToBytes(digestRow.d)
      const realSig = await sign(digestBytes)
      userId = realSig.signerUserId
      signerKey = realSig.signerKey
      signature = realSig.signature
      isPlaceholder = false
    }
    return { userId, signerKey, signature, isPlaceholder }
  }

  private requireCtx (method: string): void {
    if (!this.ctx) {
      throw new Error(
				`SignatureTasksEngine.${method}: no EngineContext bound — construct with (networkRef, ctx) for DB-backed methods`
      )
    }
  }

  private rethrow (err: unknown, method: string): never {
    if (err instanceof QuereusError) {
      throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
    } else if (err instanceof MisuseError) {
      throw new Error(`API misuse: ${err.message}`)
    } else if (err instanceof Error) {
      throw new Error(`SignatureTasksEngine.${method}: ${err.message}`)
    } else {
      throw new Error(
				`SignatureTasksEngine.${method}: unknown error: ${String(err)}`
      )
    }
  }
}
