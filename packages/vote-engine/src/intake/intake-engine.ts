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
import type { EngineContext } from '../types.js'
import { intakeQueryPortFromDb } from './query-port.js'
import { pickCurrentEncryptionKey, readUsableEncryptionKeys, resolveIntakeRecipients } from './recipients.js'
import { IntakeError } from './types.js'
import type {
  IntakeRecipientSet,
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

    return { userId, authorityId, hasLocalKey, localPublicKey, published, isCurrent, isIntakeRecipient }
  }

  /** `resolveIntakeRecipients` over this engine's own DB handle (D-04/D-32). */
  async listIntakeRecipients (authorityId: string): Promise<IntakeRecipientSet> {
    this.requireCtx('listIntakeRecipients')
    return resolveIntakeRecipients(intakeQueryPortFromDb(this.ctx!.db), authorityId)
  }
}
