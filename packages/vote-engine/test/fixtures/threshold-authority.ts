// 62-07 (D-08..D-12): a reusable multi-holder authority fixture for threshold co-signing
// tests, reused by 62-11 (ceb/vrg end-to-end) and 62-13 (rad fan-out + D-12 producer audit).
//
// IMPORTANT (schema constraint, votetorrent.qsql Officer.InsertValid "first authority" arm):
// every Officer insert this fixture performs uses the unsigned, no-invite arm, which requires
// `(select count(*) from Authority) = 1`. ALL officer inserts below therefore run BEFORE
// anything in a test creates a SECOND Authority. If 62-03's Officer.InsertValid change
// narrows this arm further (D-48), it must keep accepting this shape: a founding-style insert
// while exactly one Authority exists.
//
// The fixture never logs keys or signatures (T-62-07-08).

import type { Database } from '@quereus/quereus'
import type { Scope, Signature, ThresholdPolicy, User } from '@votetorrent/vote-core'
import { BALLOT_HEADER_TID } from '../../src/election/election-engine.js'
import { allocateTid } from '../../src/database/tid-allocator.js'
import { nowCanonicalDatetime } from '../../src/utils.js'
import {
  addTestAuthority,
  addTestElection,
  makeDistinctTestUser,
  makeTestSignCallback,
  seedUserInvite,
  signTestDigest,
  createTestNetwork,
  type TestAuthorityContext,
  type TestElectionContext,
} from './test-context.js'

export interface ThresholdOfficer {
  user: User
  scopes: Scope[]
  sign: (digest: Uint8Array) => Promise<Signature>
}

export interface ThresholdAuthorityOptions {
  holderCount?: number
  holderScopes?: Scope[]
  thresholdPolicies?: ThresholdPolicy[]
  nonHolderScopes?: Scope[]
}

export interface ThresholdAuthorityFixture {
  /** Founder context; ctx.user is holders[0].user. */
  elec: TestElectionContext
  authorityId: string
  adminEffectiveAt: string | number
  /** holders[0] is the founder; every holder holds every `holderScopes` entry. */
  holders: ThresholdOfficer[]
  /** A CURRENT officer holding only `nonHolderScopes`. */
  nonHolder: ThresholdOfficer
  /** A User row that is NOT an Officer. */
  outsider: User
}

const DEFAULT_HOLDER_SCOPES: Scope[] = ['rn', 'rad', 'vrg', 'iad', 'uai', 'mel', 'ceb']
const DEFAULT_THRESHOLD_POLICIES: ThresholdPolicy[] = [
  { policy: 'rad', threshold: 1 },
  { policy: 'ceb', threshold: 2 },
  { policy: 'vrg', threshold: 2 },
]
const DEFAULT_NON_HOLDER_SCOPES: Scope[] = ['mel']

/** Insert a User row via the invite-bound InsertValid arm (seedUserInvite + raw insert), mirroring
 *  authority.spec.ts's `seedExtraUser` shape. */
async function insertFixtureUser (auth: TestAuthorityContext, user: User): Promise<void> {
  const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, user)
  const tid = Date.now() + Math.floor(Math.random() * 1_000_000)
  await auth.ctx.db.exec(
    `insert into User (Id, Name, ImageRef)
     with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${tid}
     values (:userId, :userName, :userImageRef)`,
    {
      userId: user.id,
      userName: user.name,
      userImageRef: user.imageRef ? JSON.stringify(user.imageRef) : null,
      inviteSlotCid,
      inviteSignature,
    }
  )
}

/** Insert an Officer row via the unsigned "first authority" InsertValid arm — see this file's
 *  header comment for why every call must happen before a second Authority exists. */
async function insertFixtureOfficer (
  db: Database,
  authorityId: string,
  adminEffectiveAt: string | number,
  userId: string,
  title: string,
  scopes: Scope[]
): Promise<void> {
  const tid = await allocateTid(db, 'officer-fixture')
  await db.exec(
    `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
     with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = :tid
     values (:authorityId, :adminEffectiveAt, :userId, :title, :scopes)`,
    {
      authorityId,
      adminEffectiveAt,
      userId,
      title,
      scopes: JSON.stringify(scopes),
      tid,
    }
  )
}

/**
 * Build a multi-holder authority: a founding officer (holders[0]) plus `holderCount - 1`
 * additional officers who ALL hold `holderScopes`, one officer holding only `nonHolderScopes`,
 * and one plain User who is not an officer at all.
 *
 * Defaults: holderCount 4 (founder + 3), holderScopes the full 7-scope set, thresholdPolicies
 * `{rad:1, ceb:2, vrg:2}`, nonHolderScopes `['mel']`.
 */
export async function createThresholdAuthority (opts?: ThresholdAuthorityOptions): Promise<ThresholdAuthorityFixture> {
  const holderCount = opts?.holderCount ?? 4
  const holderScopes = opts?.holderScopes ?? DEFAULT_HOLDER_SCOPES
  const thresholdPolicies = opts?.thresholdPolicies ?? DEFAULT_THRESHOLD_POLICIES
  const nonHolderScopes = opts?.nonHolderScopes ?? DEFAULT_NON_HOLDER_SCOPES

  const net = await createTestNetwork({
    network: {
      admin: {
        officers: [
          {
            init: {
              name: 'Admin A',
              title: 'Chair',
              scopes: holderScopes,
            },
          },
        ],
        effectiveAt: Date.now(),
        thresholdPolicies,
      },
    },
  })
  const auth = await addTestAuthority(net)
  const elec = await addTestElection(auth)

  const authorityId = elec.authority.id
  const adminRow = await elec.ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId })
  if (!adminRow) throw new Error('createThresholdAuthority: CurrentAdmin not found')
  const adminEffectiveAt = adminRow.EffectiveAt as string | number

  const holders: ThresholdOfficer[] = [
    { user: elec.user, scopes: holderScopes, sign: makeTestSignCallback(elec.user) },
  ]

  // Every Officer insert below MUST run before anything creates a second Authority (first-
  // authority InsertValid arm — see file header).
  for (let i = 1; i < holderCount; i++) {
    const user = makeDistinctTestUser()
    await insertFixtureUser(auth, user)
    await insertFixtureOfficer(elec.ctx.db, authorityId, adminEffectiveAt, user.id, `Officer ${i}`, holderScopes)
    holders.push({ user, scopes: holderScopes, sign: makeTestSignCallback(user) })
  }

  const nonHolderUser = makeDistinctTestUser()
  await insertFixtureUser(auth, nonHolderUser)
  await insertFixtureOfficer(elec.ctx.db, authorityId, adminEffectiveAt, nonHolderUser.id, 'Non-holder Officer', nonHolderScopes)
  const nonHolder: ThresholdOfficer = {
    user: nonHolderUser,
    scopes: nonHolderScopes,
    sign: makeTestSignCallback(nonHolderUser),
  }

  const outsider = makeDistinctTestUser()
  await insertFixtureUser(auth, outsider)

  return { elec, authorityId, adminEffectiveAt, holders, nonHolder, outsider }
}

/** Read AdminSigning.Digest for `nonce` and sign it for real with `user`'s fixture private key. */
export async function signSessionDigest (db: Database, nonce: string, user: User): Promise<Signature> {
  const row = await db.prepare('select Digest from AdminSigning where Nonce = :nonce').get({ nonce })
  if (!row || row.Digest == null) {
    throw new Error(`signSessionDigest: no AdminSigning.Digest for nonce ${nonce}`)
  }
  return signTestDigest(user, row.Digest as string)
}

/**
 * Insert an UNSIGNED placeholder AdminSigning('ceb') header row for `ballotId`, mirroring
 * `ElectionEngine.submitBallotForConfirmation`'s Step 4 exactly (election-engine.ts:897-921) —
 * same Digest field order, same BALLOT_HEADER_TID constant. Creates NO Task.
 */
export async function insertBallotHeaderSession (
  fx: ThresholdAuthorityFixture,
  ballotId: string,
  initiatorUserId: string
): Promise<{ nonce: string }> {
  const db = fx.elec.ctx.db
  const ballotRow = await db
    .prepare('select ElectionId, AuthorityId, Description, Districts from ProposedBallot where Id = :ballotId')
    .get({ ballotId }) as { ElectionId: string, AuthorityId: string, Description: string, Districts: string } | undefined
  if (!ballotRow) throw new Error(`insertBallotHeaderSession: ProposedBallot not found: ${ballotId}`)

  const nonce = crypto.randomUUID()
  const now = nowCanonicalDatetime()
  const signerKey = '0'.repeat(66)
  const placeholderSig = '0'.repeat(128)

  await db.exec(
    `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
     with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
     values (:nonce, :authorityId, :adminEffectiveAt, 'ceb',
             Digest(:headerTid, :id, :electionId, :authorityId, :description, :districts),
             :userId, :signerKey, :signature)`,
    {
      nonce,
      authorityId: fx.authorityId,
      adminEffectiveAt: fx.adminEffectiveAt,
      headerTid: BALLOT_HEADER_TID,
      id: ballotId,
      electionId: ballotRow.ElectionId,
      description: ballotRow.Description,
      districts: ballotRow.Districts,
      userId: initiatorUserId,
      signerKey,
      signature: placeholderSig,
      now,
    }
  )

  return { nonce }
}

/** A `BallotSignatureTaskExtension` insert callback shaped for `fanOutSignatureTasks`'s
 *  `insertExtension` contract — `(taskId, recipientUserId) => Promise<void>`. */
export function ballotExtensionInserter (db: Database, ballotId: string): (taskId: string, recipientUserId: string) => Promise<void> {
  return async (taskId: string): Promise<void> => {
    await db.exec(
      `insert into BallotSignatureTaskExtension (TaskId, BallotId) with context Tid = :tid values (:taskId, :ballotId)`,
      { taskId, ballotId, tid: BALLOT_HEADER_TID }
    )
  }
}
