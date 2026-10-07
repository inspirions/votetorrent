// src/intake/intake-engine.ts — Phase 62 Plan 14 (D-03, D-04, D-29, D-32, D-46)
//
// Officer key registration and status, recipient listing, sealer/opener
// factories, and the intake policy read/write. Every catch block re-throws
// an `IntakeError` unchanged and routes anything else through the shared
// `rethrow` helper (ceremony-helpers.ts), matching every other
// registration-domain engine in this package.
//
// Task 1 lands officer key registration/status and recipient listing. Task 2
// adds the sealer/opener factories and the intake policy read/write.

import type { Scope } from '@votetorrent/vote-core'
import {
  ENCRYPTION_KEY_ALG,
  encryptionPublicKeyFromSecret,
  generateEncryptionKeyPair,
  officerEncryptionKeyAlias,
  OFFICER_ENCRYPTION_KEY_POLICY
} from '../crypto/index.js'
import type { IKeyVault } from '../crypto/index.js'
import { digestToBytes } from '../utils.js'
import { requireCtx as requireCtxHelper, rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { readAuthorityThreshold } from '../signing/threshold.js'
import { allocateTid } from '../database/tid-allocator.js'
import type { EngineContext } from '../types.js'
import { intakeQueryPortFromDb } from './query-port.js'
import { pickCurrentEncryptionKey, readUsableEncryptionKeys, resolveIntakeRecipients } from './recipients.js'
import { createIntakeOpener, createIntakeSealer } from './sealing.js'
import { isValidRestBridgeUrl, readIntakePolicyFrom } from './policy.js'
import { IntakeError, REASSOCIATION_MODES } from './types.js'
import type {
  AuthorityIntakePolicyInput,
  AuthorityIntakePolicyView,
  IntakeOpener,
  IntakeRecipientSet,
  IntakeSealer,
  IntakeSignCallback,
  OfficerEncryptionKeyRegistration,
  OfficerEncryptionKeyStatus
} from './types.js'

function describeThrown (err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

export class IntakeEngine {
  constructor (private readonly ctx?: EngineContext) {}

  // ---------- ceremony-helper delegators (WR-04 shared-copy convention) ----------

  private requireCtx (method: string): void {
    requireCtxHelper(this.ctx, 'IntakeEngine', method)
  }

  private rethrow (err: unknown, method: string): never {
    return rethrowHelper(err, 'IntakeEngine', method)
  }

  private requireUserId (): string {
    const userId = this.ctx?.user?.id
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new IntakeError('invalid-argument', 'IntakeEngine: no ctx.user bound')
    }
    return userId
  }

  /** Authority-scoped current-officer check; `scope`, when given, additionally requires it in O.Scopes. */
  private async isCurrentOfficer (authorityId: string, userId: string, scope?: Scope): Promise<boolean> {
    const ctx = this.ctx!
    const scopeClause = scope !== undefined
      ? 'and exists (select 1 from json_each(O.Scopes) where value = :scopeCode)'
      : ''
    const row = await ctx.db
      .prepare(
        `select 1 as found
           from Officer O
           join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
          where O.AuthorityId = :authorityId and O.UserId = :userId ${scopeClause}
          limit 1`
      )
      .get({ authorityId, userId, scopeCode: scope ?? null })
    return row != null
  }

  // ---------- D-04 officer encryption-key registration ----------

  /**
   * D-04: an officer publishes their own secp256k1 encryption public key as
   * a self-signed `UserEncryptionKey` row. The vault write ALWAYS precedes
   * the row insert — a published key always has a held secret. Idempotent:
   * a second call for an already-published key reuses the vault secret and
   * reports `'already-registered'`.
   *
   * One key per officer per vault alias: a newer row from another device of
   * the SAME officer becomes current and this device's key stops receiving
   * NEW envelopes; deleting the vault alias to re-register loses access to
   * every envelope already wrapped to the old key (D-07 keeps them forever).
   */
  async registerOfficerEncryptionKey (
    authorityId: string,
    vault: IKeyVault,
    sign: IntakeSignCallback
  ): Promise<OfficerEncryptionKeyRegistration> {
    this.requireCtx('registerOfficerEncryptionKey')
    const ctx = this.ctx!
    const userId = this.requireUserId()
    if (typeof authorityId !== 'string' || authorityId.length === 0) {
      throw new IntakeError('invalid-argument', 'registerOfficerEncryptionKey: authorityId must be a non-empty string')
    }

    // No vault access before this check (T-62-14 custody ordering).
    if (!(await this.isCurrentOfficer(authorityId, userId))) {
      throw new IntakeError(
        'not-a-current-officer',
        'registerOfficerEncryptionKey: caller is not a current officer of this authority'
      )
    }

    let alias: string
    try {
      alias = officerEncryptionKeyAlias(userId)
    } catch (err) {
      throw new IntakeError('invalid-argument', `registerOfficerEncryptionKey: invalid vault alias (${describeThrown(err)})`)
    }

    let publicKey: string
    let secretCopy: Uint8Array | null = null
    try {
      const existing = await vault.hasSecret(alias)
      if (existing) {
        const secret = await vault.getSecret(alias)
        if (secret === null) {
          throw new IntakeError('vault-error', 'registerOfficerEncryptionKey: vault reports the alias exists but returned no secret')
        }
        secretCopy = secret
        publicKey = encryptionPublicKeyFromSecret(secret)
      } else {
        // The vault write ALWAYS precedes the row insert, so a published key
        // always has a held secret (D-04 custody invariant).
        const generated = generateEncryptionKeyPair()
        await vault.putSecret(alias, generated.secretKey, OFFICER_ENCRYPTION_KEY_POLICY)
        secretCopy = generated.secretKey
        publicKey = generated.publicKey
      }
    } catch (err) {
      if (err instanceof IntakeError) throw err
      throw new IntakeError('vault-error', `registerOfficerEncryptionKey: ${describeThrown(err)}`)
    } finally {
      // Best-effort local-copy zeroization once the public key is derived.
      // Never calls deleteSecret — the vault's own copy is never touched here.
      secretCopy?.fill(0)
    }

    const existingRow = await ctx.db
      .prepare('select RegisteredAt from UserEncryptionKey where UserId = :userId and PubKey = :pubKey')
      .get({ userId, pubKey: publicKey })
    if (existingRow) {
      return {
        userId,
        authorityId,
        publicKey,
        registeredAt: existingRow.RegisteredAt as string,
        status: 'already-registered'
      }
    }

    const registeredAt = new Date().toISOString()
    try {
      const digestRow = await ctx.db
        .prepare("select Digest('UserEncryptionKey', :userId, :alg, :pubKey, :registeredAt) as d")
        .get({ userId, alg: ENCRYPTION_KEY_ALG, pubKey: publicKey, registeredAt })
      if (!digestRow || digestRow.d == null) {
        throw new Error('registerOfficerEncryptionKey: Digest() returned null — crypto plugin not registered?')
      }
      const digestBytes = digestToBytes(digestRow.d)
      const signature = await sign(digestBytes)
      await ctx.db.exec(
        `insert into UserEncryptionKey (UserId, Alg, PubKey, RegisteredAt, SignerKey, Signature)
         values (:userId, :alg, :pubKey, :registeredAt, :signerKey, :signature)`,
        {
          userId,
          alg: ENCRYPTION_KEY_ALG,
          pubKey: publicKey,
          registeredAt,
          signerKey: signature.signerKey,
          signature: signature.signature
        }
      )
    } catch (err) {
      if (err instanceof IntakeError) throw err
      this.rethrow(err, 'registerOfficerEncryptionKey')
    }

    return { userId, authorityId, publicKey, registeredAt, status: 'registered' }
  }

  /** Read-only snapshot of the caller's own officer encryption key for `authorityId`. */
  async getOfficerEncryptionKeyStatus (authorityId: string, vault: IKeyVault): Promise<OfficerEncryptionKeyStatus> {
    this.requireCtx('getOfficerEncryptionKeyStatus')
    const ctx = this.ctx!
    const userId = this.requireUserId()
    if (typeof authorityId !== 'string' || authorityId.length === 0) {
      throw new IntakeError('invalid-argument', 'getOfficerEncryptionKeyStatus: authorityId must be a non-empty string')
    }

    let alias: string
    try {
      alias = officerEncryptionKeyAlias(userId)
    } catch (err) {
      throw new IntakeError('invalid-argument', `getOfficerEncryptionKeyStatus: invalid vault alias (${describeThrown(err)})`)
    }

    let hasLocalKey = false
    let localPublicKey: string | null = null
    try {
      hasLocalKey = await vault.hasSecret(alias)
      if (hasLocalKey) {
        const secret = await vault.getSecret(alias)
        if (secret === null) {
          throw new IntakeError('vault-error', 'getOfficerEncryptionKeyStatus: vault reports the alias exists but returned no secret')
        }
        localPublicKey = encryptionPublicKeyFromSecret(secret)
        secret.fill(0)
      }
    } catch (err) {
      if (err instanceof IntakeError) throw err
      throw new IntakeError('vault-error', `getOfficerEncryptionKeyStatus: ${describeThrown(err)}`)
    }

    const port = intakeQueryPortFromDb(ctx.db)

    let published = false
    if (localPublicKey !== null) {
      const row = await ctx.db
        .prepare('select 1 as found from UserEncryptionKey where UserId = :userId and PubKey = :pubKey')
        .get({ userId, pubKey: localPublicKey })
      published = row != null
    }

    const { usable } = await readUsableEncryptionKeys(port, userId)
    const current = pickCurrentEncryptionKey(usable)
    const isCurrent = localPublicKey !== null && current !== undefined && current.publicKey === localPublicKey
    const isIntakeRecipient = isCurrent && (await this.isCurrentOfficer(authorityId, userId))

    let isContested = false
    if (isCurrent && localPublicKey !== null) {
      const recipientSet = await resolveIntakeRecipients(port, authorityId)
      isContested = recipientSet.contestedKeys.some(
        (entry) => entry.publicKey === localPublicKey && entry.userIds.some((id) => id !== userId)
      )
    }

    return { userId, authorityId, hasLocalKey, localPublicKey, published, isCurrent, isIntakeRecipient, isContested }
  }

  /** `resolveIntakeRecipients` over this engine's own DB handle (D-04/D-32). */
  async listIntakeRecipients (authorityId: string): Promise<IntakeRecipientSet> {
    this.requireCtx('listIntakeRecipients')
    return resolveIntakeRecipients(intakeQueryPortFromDb(this.ctx!.db), authorityId)
  }

  // ---------- D-03/D-04 sealer/opener factories ----------

  createSealer (authorityId: string): IntakeSealer {
    this.requireCtx('createSealer')
    return createIntakeSealer({ port: intakeQueryPortFromDb(this.ctx!.db), authorityId })
  }

  createOpener (vault: IKeyVault): IntakeOpener {
    this.requireCtx('createOpener')
    return createIntakeOpener({ vault, userId: this.requireUserId() })
  }

  // ---------- D-29/D-46 intake policy ----------

  async readIntakePolicy (authorityId: string): Promise<AuthorityIntakePolicyView> {
    this.requireCtx('readIntakePolicy')
    return readIntakePolicyFrom(intakeQueryPortFromDb(this.ctx!.db), authorityId)
  }

  /**
   * D-29: an officer holding `'vrg'` sets the authority's REST bridge URL
   * and/or re-association mode as a new revision, under a `'vrg'`
   * AdminSigning ceremony — mirroring `RegistrationEngine.registerBridgeKey`
   * field for field. Every check below runs BEFORE the first write, so a
   * refusal never leaves an orphan ceremony session.
   */
  async setIntakePolicy (input: AuthorityIntakePolicyInput, sign: IntakeSignCallback): Promise<AuthorityIntakePolicyView> {
    this.requireCtx('setIntakePolicy')
    const ctx = this.ctx!
    const userId = this.requireUserId()
    const { authorityId } = input

    if (typeof authorityId !== 'string' || authorityId.length === 0) {
      throw new IntakeError('invalid-policy', 'setIntakePolicy: authorityId must be a non-empty string')
    }
    const hasUrl = Object.prototype.hasOwnProperty.call(input, 'restBridgeUrl')
    const hasMode = Object.prototype.hasOwnProperty.call(input, 'reassociationMode')
    if (!hasUrl && !hasMode) {
      throw new IntakeError('invalid-policy', 'setIntakePolicy: at least one of restBridgeUrl/reassociationMode must be given')
    }
    if (hasUrl && input.restBridgeUrl !== null && input.restBridgeUrl !== undefined && !isValidRestBridgeUrl(input.restBridgeUrl)) {
      throw new IntakeError('invalid-policy', 'setIntakePolicy: restBridgeUrl must be null or a valid https URL')
    }
    if (hasMode && !(REASSOCIATION_MODES as readonly string[]).includes(input.reassociationMode as string)) {
      throw new IntakeError('invalid-policy', 'setIntakePolicy: reassociationMode must be "manual" or "automatic"')
    }

    // Tier 2 pre-check (tier 1 is the schema's own ceremony CHECK).
    if (!(await this.isCurrentOfficer(authorityId, userId, 'vrg' as Scope))) {
      throw new IntakeError('not-authorized', "setIntakePolicy: caller does not hold 'vrg' at this authority")
    }

    // Like registerBridgeKey, this table has no co-sign Task path, and
    // adding one needs a schema change frozen after 62-03 (D-22). Refusing
    // before any write leaves no orphan ceremony.
    const threshold = await readAuthorityThreshold(ctx.db, authorityId, 'vrg' as Scope)
    if (threshold > 1) {
      throw new IntakeError(
        'threshold-requires-co-sign',
        "setIntakePolicy: the 'vrg' threshold at this authority is above 1 — co-sign is not yet supported for this table"
      )
    }

    const current = await readIntakePolicyFrom(intakeQueryPortFromDb(ctx.db), authorityId)
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      throw new IntakeError(
        'policy-revision-conflict',
        `setIntakePolicy: expectedRevision ${input.expectedRevision} does not match current revision ${current.revision}`
      )
    }

    const nextUrl = hasUrl ? (input.restBridgeUrl ?? null) : current.restBridgeUrl
    const nextMode = hasMode ? (input.reassociationMode ?? current.reassociationMode) : current.reassociationMode

    if (!current.isDefault && nextUrl === current.restBridgeUrl && nextMode === current.reassociationMode) {
      return current
    }

    const revision = current.revision + 1
    const setAt = new Date().toISOString()
    // The SAME durable allocator namespace registerBridgeKey uses.
    const tid = await allocateTid(ctx.db, 'registration-request')
    const digestExpr = "select Digest(:tid, 'AuthorityIntakePolicy', :rowAuthorityId, :revision, :restBridgeUrl, :reassociationMode, :setAt) as d"
    const digestParams = {
      tid,
      rowAuthorityId: authorityId,
      revision,
      restBridgeUrl: nextUrl,
      reassociationMode: nextMode,
      setAt
    }

    try {
      const nonce = await seedSignedMutation(ctx, authorityId, 'vrg' as Scope, tid, digestExpr, digestParams, sign)
      await ctx.db.exec(
        `insert into AuthorityIntakePolicy (AuthorityId, Revision, RestBridgeUrl, ReassociationMode, SetAt)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:rowAuthorityId, :revision, :restBridgeUrl, :reassociationMode, :setAt)`,
        {
          rowAuthorityId: authorityId,
          revision,
          restBridgeUrl: nextUrl,
          reassociationMode: nextMode,
          setAt,
          signingNonce: nonce
        }
      )
    } catch (err) {
      if (err instanceof IntakeError) throw err
      // A concurrent officer may have won the PK race (same idiom as
      // registerBridgeKey) — the unused ceremony session is harmless.
      const reread = await readIntakePolicyFrom(intakeQueryPortFromDb(ctx.db), authorityId)
      if (reread.revision >= revision) {
        throw new IntakeError('policy-revision-conflict', 'setIntakePolicy: a concurrent write won the revision race')
      }
      this.rethrow(err, 'setIntakePolicy')
    }

    return readIntakePolicyFrom(intakeQueryPortFromDb(ctx.db), authorityId)
  }
}
