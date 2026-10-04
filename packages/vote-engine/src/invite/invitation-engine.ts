import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { MisuseError, QuereusError } from '@quereus/quereus'
import type { EngineContext } from '../types.js'
import { digestToBytes, inviteResultSignedBytes, nowCanonicalDatetime, toCanonicalDatetime, verifyAdHocInviteSignature } from '../utils.js'
import { allocateTid } from '../database/tid-allocator.js'
import type {
  IInvitationEngine,
  InviteStatus,
  SentOfficerInvite,
  SentAuthorityInvite,
  SentKeyholderInvite,
  KeyholderAcceptProvisioning,
  InviteType,
} from '@votetorrent/vote-core'

/**
 * Real InvitationEngine — Phase 15 (D-08 / SWAP-04).
 *
 * Reads InviteSlot and InviteResult rows from the shared EngineContext
 * database. The write-side (`respondToInvite`) is BLOCKED — it requires the
 * full secp256k1 invite-signing pipeline (D-08) and will be implemented in a
 * future phase.
 *
 * title/scopes storage gap (Q4 option 3): InviteSlot stores only `Name`.
 * `OfficerInit.title` and `.scopes` are required fields on the TypeScript type
 * but are not stored in InviteSlot. We return empty defaults ('', []) until a
 * future schema extension stores them in InviteSlot.
 * See .planning/phases/15-real-engine-di-swap/15-RESEARCH.md Q4 option 3.
 */
export class InvitationEngine implements IInvitationEngine {
  constructor (private readonly ctx: EngineContext) {}

  /**
   * Resolve the InviteSlot Cid for an invitee's share by (InviteKey, Type). Returns the Cid only
   * when exactly one row matches (fail closed).
   */
  async resolveInviteSlotCid (inviteKey: string, type: InviteType): Promise<string | undefined> {
    try {
      const cids: string[] = []
      for await (const row of this.ctx.db.eval(
        'SELECT Cid FROM InviteSlot WHERE InviteKey = :inviteKey AND Type = :slotType',
        { inviteKey, slotType: type }
      )) {
        cids.push(row.Cid as string)
      }
      return cids.length === 1 ? cids[0] : undefined
    } catch (err) {
      this.rethrow(err, 'resolveInviteSlotCid')
    }
  }

  /**
   * Return all pending officer InviteSlot rows (Type = 'of') that have no
   * matching InviteResult row.
   */
  async getPendingOfficerInvites (): Promise<Array<InviteStatus<SentOfficerInvite>>> {
    const out: Array<InviteStatus<SentOfficerInvite>> = []
    try {
      for await (const row of this.ctx.db.eval(
        `SELECT Cid, Name FROM InviteSlot
         WHERE Type = 'of'
           AND NOT EXISTS (SELECT 1 FROM InviteResult IR WHERE IR.SlotCid = Cid)
           AND Expiration > :now`,
        { now: nowCanonicalDatetime() }
      )) {
        out.push({
          // InviteSlot stores only Name; title/scopes deferred — see 15-RESEARCH.md Q4 option 3
          invite: { name: row.Name as string, type: 'of' as const, title: '', scopes: [] },
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getPendingOfficerInvites')
    }
  }

  /**
   * Return all pending authority InviteSlot rows (Type = 'au') that have no
   * matching InviteResult row.
   */
  async getPendingAuthorityInvites (): Promise<Array<InviteStatus<SentAuthorityInvite>>> {
    const out: Array<InviteStatus<SentAuthorityInvite>> = []
    try {
      for await (const row of this.ctx.db.eval(
        `SELECT Cid, Name FROM InviteSlot
         WHERE Type = 'au'
           AND NOT EXISTS (SELECT 1 FROM InviteResult IR WHERE IR.SlotCid = Cid)
           AND Expiration > :now`,
        { now: nowCanonicalDatetime() }
      )) {
        out.push({
          invite: { name: row.Name as string, type: 'au' as const },
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getPendingAuthorityInvites')
    }
  }

  /**
   * Return the officer InviteSlot with the given Cid, joined with any
   * InviteResult row. Returns `undefined` when no matching row exists.
   *
   * `result` is populated only when `IsAccepted` is non-null (i.e. a
   * corresponding InviteResult row exists).
   */
  async getOfficerInvite (id: string): Promise<InviteStatus<SentOfficerInvite> | undefined> {
    try {
      const row = await this.ctx.db
        .prepare(
          `SELECT IS_.Cid, IS_.Name, IR.IsAccepted, IR.InviteSignature, IR.InvokedId
           FROM InviteSlot IS_
           LEFT JOIN InviteResult IR ON IR.SlotCid = IS_.Cid
           WHERE IS_.Cid = :id AND IS_.Type = 'of'`
        )
        .get({ id }) as {
          Cid: string
          Name: string
          IsAccepted: boolean | null
          InviteSignature: string | null
          InvokedId: string | null
        } | undefined

      if (!row) return undefined

      return {
        // InviteSlot stores only Name; title/scopes deferred — see 15-RESEARCH.md Q4 option 3
        invite: { name: row.Name, type: 'of' as const, title: '', scopes: [] },
        result: row.IsAccepted !== null
          ? {
            // WR-02: Quereus/SQLite returns boolean columns as 0/1 on the
            // on-device path. Normalize to a real boolean (the field is typed
            // boolean) so strict comparisons (=== true) downstream are correct.
            isAccepted: row.IsAccepted === true || (row.IsAccepted as unknown) === 1,
            invitationSignature: row.InviteSignature ?? '',
            invokedId: row.InvokedId ?? undefined,
          }
          : undefined,
      }
    } catch (err) {
      this.rethrow(err, 'getOfficerInvite')
    }
  }

  /**
   * Return the authority InviteSlot with the given Cid, joined with any
   * InviteResult row. Returns `undefined` when no matching row exists.
   *
   * `result` is populated only when `IsAccepted` is non-null.
   */
  async getAuthorityInvite (id: string): Promise<InviteStatus<SentAuthorityInvite> | undefined> {
    try {
      const row = await this.ctx.db
        .prepare(
          `SELECT IS_.Cid, IS_.Name, IR.IsAccepted, IR.InviteSignature, IR.InvokedId
           FROM InviteSlot IS_
           LEFT JOIN InviteResult IR ON IR.SlotCid = IS_.Cid
           WHERE IS_.Cid = :id AND IS_.Type = 'au'`
        )
        .get({ id }) as {
          Cid: string
          Name: string
          IsAccepted: boolean | null
          InviteSignature: string | null
          InvokedId: string | null
        } | undefined

      if (!row) return undefined

      return {
        invite: { name: row.Name, type: 'au' as const },
        result: row.IsAccepted !== null
          ? {
            // WR-02: Quereus/SQLite returns boolean columns as 0/1 on the
            // on-device path. Normalize to a real boolean (the field is typed
            // boolean) so strict comparisons (=== true) downstream are correct.
            isAccepted: row.IsAccepted === true || (row.IsAccepted as unknown) === 1,
            invitationSignature: row.InviteSignature ?? '',
            invokedId: row.InvokedId ?? undefined,
          }
          : undefined,
      }
    } catch (err) {
      this.rethrow(err, 'getAuthorityInvite')
    }
  }

  /**
   * Return the keyholder InviteSlot with the given Cid, joined with any
   * InviteResult row. Returns `undefined` when no matching row exists.
   *
   * `result` is populated only when `IsAccepted` is non-null (i.e. a
   * corresponding InviteResult row exists).
   *
   * SentKeyholderInvite is `{ name }` only — keyholder invites have no
   * type/title/scopes officer fields. The Type='k' filter scopes the read to
   * keyholder slots so officer ('of') / authority ('au') slots are excluded.
   */
  async getKeyholderInvite (id: string): Promise<InviteStatus<SentKeyholderInvite> | undefined> {
    try {
      const row = await this.ctx.db
        .prepare(
          `SELECT IS_.Cid, IS_.Name, IR.IsAccepted, IR.InviteSignature, IR.InvokedId
           FROM InviteSlot IS_
           LEFT JOIN InviteResult IR ON IR.SlotCid = IS_.Cid
           WHERE IS_.Cid = :id AND IS_.Type = 'k'`
        )
        .get({ id }) as {
          Cid: string
          Name: string
          IsAccepted: boolean | null
          InviteSignature: string | null
          InvokedId: string | null
        } | undefined

      if (!row) return undefined

      return {
        invite: { name: row.Name },
        result: row.IsAccepted !== null
          ? {
            // WR-02: Quereus/SQLite returns boolean columns as 0/1 on the
            // on-device path. Normalize to a real boolean (the field is typed
            // boolean) so strict comparisons (=== true) downstream are correct.
            isAccepted: row.IsAccepted === true || (row.IsAccepted as unknown) === 1,
            invitationSignature: row.InviteSignature ?? '',
            invokedId: row.InvokedId ?? undefined,
          }
          : undefined,
      }
    } catch (err) {
      this.rethrow(err, 'getKeyholderInvite')
    }
  }

  /**
   * Accept or decline an invitation, writing a real local InviteResult row.
   *
   * INV-04 (accept): writes InviteResult with IsAccepted=true, non-null Digest,
   * and a real ephemeral-key InviteSignature over H(SlotCid, Digest, true).
   *
   * INV-05 / D-09 (signed decline): writes InviteResult with IsAccepted=false,
   * Digest=null, and a REAL ephemeral-key InviteSignature over H(SlotCid, null, false).
   * A decline is a cryptographically authenticated "no" — not a bare flag.
   *
   * InviteSignature byte form (A1 LOCKED — do not deviate):
   *   signedBytes = TextEncoder.encode([slotCid, digestToken, String(accept)].join('|'))
   *   sig = bytesToHex(secp256k1.sign(sha256(signedBytes), invitePrivBytes))
   *   — noble v2 defaults (prehash:true); NEVER { prehash: false }
   *   where digestToken = digest for accept, 'null' for decline
   *
   * The device user's private key MUST NOT enter this method (T-21-04-05).
   * Only the ephemeral one-time invite key (from D-06 paste) is permitted.
   *
   * Phase-22 cross-device P2P transport: disabled boundary (D-08). The
   * cross-device "send over network" hop is deferred to the P2P transport
   * phase. Only the local InviteResult write is real in this phase.
   *
   * 62-02 (D-21, D-26): a Type 'k' (keyholder) ACCEPT is now ATOMIC and requires `keyholder`
   * provisioning. `InviteResult`, the fresh `User` (D-21: never the officer's identity), its
   * `UserKey` (the provisioned signing key), the `Keyholder` row and the signed
   * `KeyholderDkgBinding` row (D-26) are all written inside ONE `BEGIN`/`COMMIT` — a failed accept
   * leaves no orphan row behind (the 62-09 crossnote's non-atomicity is fixed). `keyholder.sign` is
   * called BEFORE the transaction opens (never hold a transaction open across a signing prompt);
   * the returned `signerKey` is verified against `keyholder.signingKey.key` before anything is
   * written. Decline and every non-'k' accept are UNCHANGED (single InviteResult write, no
   * transaction). INTERIM STATE: the Authority keyholder-accept screen does not yet pass
   * provisioning (62-26 wires it), so a real keyholder accept in the app fails closed with the
   * message thrown below — by design, not a bug.
   */
  async respondToInvite (
    invitationId: string,
    accept: boolean,
    invitePrivate?: string,
    digest?: string,
    invokedId?: string,
    keyholder?: KeyholderAcceptProvisioning,
  ): Promise<void> {
    // invitationId is the InviteSlot Cid in the thin IInvitationEngine surface
    // (as used by the accept/decline screens per D-06 paste flow).
    const slotCid = invitationId

    try {
      // Step 1: Resolve the slot to confirm it exists (fail fast with a clear error).
      // InviteKey is also read here (999.1 R-03) — it is the verifying key for the
      // engine-side InviteResult.InviteSignature check below. Type/Name/ElectionId/
      // InviteSignature (of the InviteSlot itself) are read for the keyholder
      // accept-time User+Keyholder minting below (second-keyholder-invite-unique fix).
      const slotRow = await this.ctx.db
        .prepare('SELECT Cid, InviteKey, Type, Name, ElectionId, InviteSignature FROM InviteSlot WHERE Cid = :slotCid')
        .get({ slotCid }) as {
          Cid: string
          InviteKey: string
          Type: string
          Name: string
          ElectionId: string | null
          InviteSignature: string | null
        } | undefined
      if (!slotRow) {
        throw new Error(`InviteSlot not found for Cid: ${slotCid}`)
      }

      // second-keyholder-invite-unique fix: an accepted keyholder ('k') invite mints a
      // NEW User (there is no existing identity for a name-only invitee pre-acceptance)
      // — reserve its id up front, mirroring NetworkEngine.respondToInvite's authority-
      // invite id reservation, so the same id can be persisted into
      // InviteResult.InvokedId AND used for the User/Keyholder INSERTs below.
      const isKeyholderAccept = accept && slotRow.Type === 'k'
      const mintedUserId = isKeyholderAccept ? (invokedId ?? crypto.randomUUID()) : undefined

      // Step 2: Determine Digest column value.
      // Accept (INV-04): Digest must be non-null (DigestValid schema constraint).
      //   Use the caller-supplied digest if provided; otherwise fall back to a
      //   content-addressed placeholder (the slotCid suffices for test / offline paths).
      // Decline (INV-05): Digest must be null (DigestValid: not IsAccepted => Digest is null).
      const digestValue = accept
        ? (digest ?? slotCid)  // non-null for accept; caller-supplied or placeholder
        : null                  // must be null for decline — schema DigestValid enforces this

      // Step 3: Determine the digest TOKEN for the signed payload.
      // The signed token for decline is the LITERAL string 'null' (not empty string, not undefined)
      // so that the pipe-join arity stays stable — matching the A1 LOCKED encoding from
      // plan 21-02's <a1_resolution> and the decline test fixture.
      const digestToken = digestValue ?? 'null'

      // Step 4: Produce the ephemeral-key InviteSignature (A1 LOCKED encoding).
      // If the caller supplies invitePrivate (from D-06 paste), use it to produce a
      // signature verifiable against the slot's InviteKey. Otherwise generate a fresh
      // ephemeral key pair so the signature is still a real secp256k1 value (not a
      // placeholder) but without slot-key binding — this path serves the offline /
      // test use-case where the private key is not available at the call site.
      // SECURITY: The device user's private key MUST NOT be passed here (T-21-04-05).
      let invitePrivBytes: Uint8Array
      if (invitePrivate !== undefined) {
        // Real app path (D-06): use the ephemeral invite key from the pasted share.
        invitePrivBytes = hexToBytes(invitePrivate)
      } else {
        // Test / offline path: generate a fresh one-time key so the signature
        // is cryptographically valid (real secp256k1) even without slot binding.
        invitePrivBytes = secp256k1.utils.randomSecretKey()
      }

      // A1 LOCKED ENCODING (verbatim from plan 21-02 <a1_resolution>):
      //   signedBytes = TextEncoder.encode([slotCid, digestToken, String(accept)].join('|'))
      //   sig = bytesToHex(secp256k1.sign(sha256(signedBytes), invitePrivBytes))
      //   noble v2 defaults: prehash:true means actual signed domain = sha256(sha256(signedBytes))
      //   NEVER pass { prehash: false } — WR-10
      const signedBytes = inviteResultSignedBytes({ slotCid, digestToken, accept })
      const inviteSignature = bytesToHex(secp256k1.sign(sha256(signedBytes), invitePrivBytes))

      // 999.1 R-03: verify the signature engine-side against the exact A1
      // LOCKED byte domain above (NOT SQL Digest() — Pitfall 2), using the
      // slot's own InviteKey. When `invitePrivate` was not supplied (the
      // documented offline/test path above), the signature is intentionally
      // NOT bound to the slot's key — there is no real signature to verify
      // (a legitimate no-signature-required path, not a fabricated `true`;
      // see the doc comment on invitePrivBytes above), so IsSignatureValid
      // stays `true` for that branch only.
      const isSignatureValid = invitePrivate !== undefined
        ? verifyAdHocInviteSignature(signedBytes, inviteSignature, slotRow.InviteKey)
        : true

      // 62-02 (D-21, D-26): a Type 'k' accept needs provisioning validated and its binding
      // digest signed BEFORE anything is written — never hold a transaction open across a
      // signing prompt, and never write a partial accept for a provisioning that turns out to
      // be malformed or falsely attributed.
      let keyholderWrite: {
        electionId: string
        revision: number
        boundAt: string
        bindingSignature: string
        userId: string
      } | undefined

      if (isKeyholderAccept) {
        if (!keyholder || !mintedUserId) {
          throw new Error(
            'Accepting a keyholder invitation needs a keyholder signing key and a key-generation receiving key, and none was provided'
          )
        }
        const keyholderUserId = mintedUserId
        if (
          typeof keyholder.dkgPublicKey !== 'string' ||
          keyholder.dkgPublicKey.length !== 66 ||
          !/^(02|03)[0-9a-f]{64}$/.test(keyholder.dkgPublicKey)
        ) {
          throw new Error('respondToInvite: keyholder.dkgPublicKey must be a 66-char lowercase hex compressed secp256k1 point (02/03 prefix)')
        }
        if (keyholder.signingKey.type !== 'M' && keyholder.signingKey.type !== 'P') {
          throw new Error(`respondToInvite: keyholder.signingKey.type must be 'M' or 'P' (got ${String(keyholder.signingKey.type)})`)
        }
        if (!slotRow.ElectionId) {
          throw new Error(`respondToInvite: keyholder InviteSlot ${slotCid} has no ElectionId`)
        }
        const revRow = await this.ctx.db
          .prepare('SELECT Revision FROM ElectionRevision WHERE ElectionId = :electionId')
          .get({ electionId: slotRow.ElectionId }) as { Revision: number } | undefined
        if (!revRow) {
          throw new Error(`respondToInvite: no ElectionRevision found for election ${slotRow.ElectionId}`)
        }

        const boundAt = new Date().toISOString()
        const bindingDigestRow = await this.ctx.db
          .prepare(
            "select Digest('KeyholderDkgBinding', :electionId, :revision, :userId, :inviteSlotCid, :dkgPublicKey, :boundAt) as d"
          )
          .get({
            electionId: slotRow.ElectionId,
            revision: revRow.Revision,
            userId: keyholderUserId,
            inviteSlotCid: slotCid,
            dkgPublicKey: keyholder.dkgPublicKey,
            boundAt,
          })
        if (!bindingDigestRow || bindingDigestRow.d == null) {
          throw new Error('respondToInvite: Digest() returned null for KeyholderDkgBinding — crypto plugin not registered?')
        }
        const bindingSig = await keyholder.sign(digestToBytes(bindingDigestRow.d as string))
        if (bindingSig.signerKey !== keyholder.signingKey.key) {
          throw new Error('respondToInvite: keyholder.sign() returned a signerKey that does not match keyholder.signingKey.key')
        }
        keyholderWrite = {
          electionId: slotRow.ElectionId,
          revision: revRow.Revision,
          boundAt,
          bindingSignature: bindingSig.signature,
          userId: keyholderUserId,
        }
      }

      // Step 5: write InviteResult (mirrors network-engine.ts:1046-1060, non-authority branch).
      // The AdminSigning row was already committed by saveInviteWithSigning on the send side —
      // this is the receive-side local write only. A keyholder accept wraps this in the SAME
      // transaction as the User/UserKey/Keyholder/KeyholderDkgBinding inserts below (D-26
      // lockstep); every other accept/decline keeps the pre-62-02 single-statement shape.
      const inviteResultSql = `insert into InviteResult (
          SlotCid,
          IsAccepted,
          Digest,
          InviteSignature,
          InvokedId
        )
        with context IsSigningValid = true, IsSignatureValid = :isSignatureValid
        values (
          :slotCid,
          :isAccepted,
          :digest,
          :inviteSignature,
          :invokedId
        )`
      const inviteResultParams = {
        slotCid,
        isAccepted: accept,
        digest: digestValue,
        inviteSignature,
        invokedId: mintedUserId ?? invokedId ?? null,
        isSignatureValid,
      }

      if (!keyholderWrite) {
        await this.ctx.db.exec(inviteResultSql, inviteResultParams)

        // Phase-22 boundary (D-08): cross-device P2P network send is deferred.
        // The local InviteResult write above is the only real action this phase.
        // Transport-level authenticity for the cross-device exchange will be
        // implemented in the P2P transport phase.
        return
      }

      // D-21/D-26 atomic keyholder accept: InviteResult + User + UserKey + Keyholder +
      // KeyholderDkgBinding, all in ONE BEGIN/COMMIT, so a failed accept (e.g. an invokedId
      // collision on User) leaves ZERO rows behind — fixing the 62-09 crossnote's documented
      // non-atomicity (a failed mint used to orphan the InviteResult write).
      const tid = await allocateTid(this.ctx.db, 'user')
      await this.ctx.db.exec('BEGIN')
      try {
        await this.ctx.db.exec(inviteResultSql, inviteResultParams)

          await this.ctx.db.exec(
            `insert into User (
              Id,
              Name,
              ImageRef
            )
            with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :userInviteSignature, Tid = ${tid}
            values (:userId, :userName, null)`,
            {
              inviteSlotCid: slotCid,
              userInviteSignature: slotRow.InviteSignature,
              userId: keyholderWrite.userId,
              userName: slotRow.Name,
            }
          )

          // D-21: a fresh identity's ONLY key is the caller-provisioned keyholder signing key —
          // the bootstrap UserKey context form (never the officer's key, never SignatureValid-
          // checked beyond the bootstrap branch), mirroring NetworksEngine.create's founding key.
          await this.ctx.db.exec(
            `insert into UserKey (
              UserId,
              Type,
              PubKey,
              Expiration
            )
            with context UserKey = null, Signature = null, Tid = ${tid}, now = :now, IsSignatureValid = true
            values (:userId, :keyType, :keyValue, :expiration)`,
            {
              userId: keyholderWrite.userId,
              keyType: keyholder!.signingKey.type,
              keyValue: keyholder!.signingKey.key,
              expiration: toCanonicalDatetime(keyholder!.signingKey.expiration),
              now: nowCanonicalDatetime(),
            }
          )

          await this.ctx.db.exec(
            `insert into Keyholder (
              ElectionId,
              ElectionRevision,
              UserId
            )
            with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
            values (:electionId, :revision, :userId)`,
            { electionId: keyholderWrite.electionId, revision: keyholderWrite.revision, userId: keyholderWrite.userId }
          )

          await this.ctx.db.exec(
            `insert into KeyholderDkgBinding (
              ElectionId,
              ElectionRevision,
              UserId,
              InviteSlotCid,
              DkgPublicKey,
              BoundAt,
              SignerKey,
              Signature
            )
            values (:electionId, :revision, :userId, :inviteSlotCid, :dkgPublicKey, :boundAt, :signerKey, :signature)`,
            {
              electionId: keyholderWrite.electionId,
              revision: keyholderWrite.revision,
              userId: keyholderWrite.userId,
              inviteSlotCid: slotCid,
              dkgPublicKey: keyholder!.dkgPublicKey,
              boundAt: keyholderWrite.boundAt,
              signerKey: keyholder!.signingKey.key,
              signature: keyholderWrite.bindingSignature,
            }
          )

        await this.ctx.db.exec('COMMIT')
      } catch (innerErr) {
        try {
          await this.ctx.db.exec('ROLLBACK')
        } catch {
          // already rolled back by the failed statement — ignore, the original error is what matters.
        }
        throw innerErr
      }

    } catch (err) {
      this.rethrow(err, 'respondToInvite')
    }
  }

  // ---------- helpers ----------

  private rethrow (err: unknown, method: string): never {
    if (err instanceof QuereusError) {
      throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
    } else if (err instanceof MisuseError) {
      throw new Error(`API misuse: ${err.message}`)
    } else if (err instanceof Error) {
      throw new Error(`InvitationEngine.${method}: ${err.message}`)
    } else {
      throw new Error(`InvitationEngine.${method}: unknown error: ${String(err)}`)
    }
  }
}
