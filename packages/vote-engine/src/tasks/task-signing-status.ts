import type { Database } from '@quereus/quereus'
import type { SignatureTask, BallotSignatureTask, RegistrantSignatureTask } from '@votetorrent/vote-core'

/**
 * task-signing-status.ts — 62-12 (Surface 5, D-09/D-10/D-11).
 *
 * `findPendingTaskNonce` is deliberately a byte-for-byte copy of the three lookup branches
 * `SignatureTasksEngine.getSignatureDigest` uses (`signature-tasks-engine.ts`), so that a
 * `SigningStatus` read through this module always describes exactly the session the officer
 * would sign if they acted on their own pending task right now. Do NOT refactor
 * `getSignatureDigest` to share this helper in this plan — 62-13 edits `getSignatureDigest`'s
 * file next and the diff must stay small; that refactor, if wanted, belongs to a future plan.
 *
 * This module is READ-ONLY: it never inserts, updates or deletes a row, and `findPendingTaskNonce`
 * returns `undefined` instead of throwing when no pending row is found (unlike
 * `getSignatureDigest`, which throws — this module's caller, `getTaskSigningStatus`, needs a
 * fail-open `null`, never an exception, per 62-12's display-only contract).
 *
 * Known residual (not fixed here, inherited from `getSignatureDigest`): the third (non-ballot,
 * non-registrant) branch is ambiguous when a user has two pending tasks of the same
 * `signatureType` — it returns an arbitrary `limit 1` row in that case, exactly as
 * `getSignatureDigest` already does.
 */
export async function findPendingTaskNonce (
  db: Database,
  task: SignatureTask
): Promise<string | undefined> {
  if (task.signatureType === 'ballot') {
    const ballotId = (task as BallotSignatureTask).ballot.proposed.id
    const row = await db
      .prepare(
        `select Task.SigningNonce from Task
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
      }) as { SigningNonce: string } | undefined
    return row?.SigningNonce
  }

  if (task.signatureType === 'registrant') {
    const requestId = (task as RegistrantSignatureTask).requestId
    const row = await db
      .prepare(
        `select Task.SigningNonce from Task
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
      }) as { SigningNonce: string } | undefined
    return row?.SigningNonce
  }

  const row = await db
    .prepare(
      `select SigningNonce from Task
        where UserId = :userId
          and Type = 'signature'
          and SignatureType = :signatureType
          and IsCompleted = 0
        limit 1`
    )
    .get({
      userId: task.userId,
      signatureType: task.signatureType,
    }) as { SigningNonce: string } | undefined
  return row?.SigningNonce
}
