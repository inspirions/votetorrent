import type { NetworkInit, NetworkReference } from '../network/models'
import type { INetworkEngine } from '../network/types'
import type { User } from '../user/models'
import type { IBuilder } from '../common/builder.js'
import type { Signature } from '../common/signature.js'

export interface INetworksEngine {
  clearRecentNetworks(): Promise<void>
  create(networkInit: NetworkInit, user: User): Promise<INetworkEngine>
  getRecentNetworks(): Promise<NetworkReference[]>
  open(
    ref: NetworkReference,
    user: User | undefined,
    storeAsRecent?: boolean
  ): Promise<INetworkEngine>
  buildCreate(): INetworksCreateBuilder
  /**
   * D-35/62-16: export the network's founding bundle (one row each of User,
   * UserKey, Authority, Admin, Officer and Network, read verbatim from the
   * exporting device's database), signed by a founding officer's own
   * unexpired key. Rejects with a `FoundingBundleExportError` (vote-engine)
   * for the engine's own refusals, including the two signature self-checks,
   * and never returns a partial bundle. A signer error carrying a string
   * `code` (user cancel, lockout, key invalidated) is rethrown unchanged.
   */
  exportFoundingBundle(networkHash: string, exporter: FoundingBundleExporter): Promise<FoundingBundleExport>
  /**
   * D-35/D-38/D-39/62-16: import a founding bundle produced by
   * `exportFoundingBundle` on a second device. Verifies the bundle in a
   * fixed fail-closed order BEFORE any database is opened; never throws for
   * a bundle or target problem — every failure is returned, categorized by
   * `FOUNDING_FAILURE_CATEGORY` (vote-engine).
   */
  importFoundingBundle(
    bundleText: string,
    user: User | undefined,
    options?: FoundingBundleImportOptions
  ): Promise<FoundingBundleImportResult>
  /**
   * 62-102: validity check for the import screen. Parses and verifies a
   * bundle WITHOUT anchors and WITHOUT opening any database; never throws.
   * Deliberately returns neither the digest nor the fingerprint, so a screen
   * cannot show the value the importing officer must type in from the
   * exporter (the anchor must be an independent, out-of-band input).
   */
  inspectFoundingBundle(bundleText: string): Promise<FoundingBundleInspection>
}

export interface INetworksCreateBuilder extends IBuilder<{ networkInit: NetworkInit; user: User }, INetworkEngine> {
  fromPayload(payload: { networkInit: NetworkInit; user: User }): this
}

// ---------------------------------------------------------------------------
// D-35/D-38/D-39 (62-16): founding-bundle contract. Types only — no runtime
// values. Created by 62-16; consumed verbatim by 62-23 (wave 5). Names and
// semantics are locked — see 62-16-PLAN.md <interfaces>.
// ---------------------------------------------------------------------------

/** The six tables a founding bundle carries, in replay order. */
export type FoundingBundleTable = 'User' | 'UserKey' | 'Authority' | 'Admin' | 'Officer' | 'Network'

/** A single cell value carried by a founding-bundle row. */
export type FoundingBundleValue = string | number | null

/** A single founding-bundle row: column name to cell value. */
export type FoundingBundleRow = Readonly<Record<string, FoundingBundleValue>>

/** Every founding table's rows, keyed by table name. Exactly one row per table on a valid bundle. */
export type FoundingBundleRows = Readonly<Record<FoundingBundleTable, readonly FoundingBundleRow[]>>

/** Derived from the six founding rows — the human- and UI-facing summary of the network being shared. */
export interface FoundingBundleDescriptor {
  readonly networkId: string
  /** = H16(networkId) = strandId (D-39). */
  readonly networkHash: string
  readonly relays: readonly string[]
  readonly name: string
  readonly primaryAuthorityId: string
  readonly primaryAuthorityDomainName: string
  readonly imageUrl?: string
}

/** The founding officer's signature over the bundle's signing digest. */
export interface FoundingBundleExporterSignature {
  /** Hex-encoded public key. */
  readonly signerKey: string
  /** Hex-encoded signature. */
  readonly signature: string
  readonly userId: string
}

/** The frozen founding-bundle envelope. */
export interface FoundingBundle {
  readonly format: 'votetorrent-founding-bundle'
  readonly formatVersion: 1
  readonly descriptor: FoundingBundleDescriptor
  /** computeSchemaHash() */
  readonly schemaHash: string
  /** 19-char canonical datetime, self-asserted, signed. */
  readonly exportedAt: string
  readonly manifest: Readonly<Record<FoundingBundleTable, number>>
  /** computeContentDigest(rows), base64url. */
  readonly digest: string
  readonly rows: FoundingBundleRows
  readonly exporter: FoundingBundleExporterSignature
}

/** The app-supplied signer for `exportFoundingBundle`. */
export interface FoundingBundleExporter {
  readonly userId: string
  /** Hex public key; must be one of userId's UserKey rows, unexpired. */
  readonly signerKey: string
  readonly sign: (digest: Uint8Array) => Promise<Signature>
}

/** The result of a successful `exportFoundingBundle` call. */
export interface FoundingBundleExport {
  readonly bundle: FoundingBundle
  /** serializeFoundingBundle(bundle): what 62-23 shares via the OS share sheet. */
  readonly text: string
  readonly fileName: string
  /** 62-102: foundingBundleFingerprint(bundle.digest), for the exporter to read out to the importing officer. */
  readonly fingerprint: string
}

/** 62-102: result of `inspectFoundingBundle`. The ok branch deliberately carries no digest or fingerprint. */
export type FoundingBundleInspection =
  | { readonly ok: true; readonly networkName: string }
  | {
      readonly ok: false
      readonly reason: FoundingBundleFailureReason
      readonly category: FoundingBundleFailureCategory
      readonly detail: string
    }

/** Every way `exportFoundingBundle` can refuse. */
export type FoundingBundleExportErrorCode =
  | 'network-not-open'
  | 'genesis-unreadable'
  | 'admin-revised'
  | 'not-founding-officer'
  | 'signer-key-invalid'
  | 'signature-self-check'

/** Every way `verifyFoundingBundle`/`importFoundingBundle` can refuse a bundle or target. */
export type FoundingBundleFailureReason =
  | 'malformed'
  | 'format-version-mismatch'
  | 'schema-hash-mismatch'
  | 'manifest-mismatch'
  | 'digest-mismatch'
  | 'row-inconsistent'
  | 'descriptor-mismatch'
  | 'exporter-not-founding-officer'
  | 'signature-invalid'
  | 'anchor-required'
  | 'anchor-mismatch'
  | 'replay-rejected'
  | 'target-conflict'
  | 'target-open-failed'
  | 'target-replay-failed'

/** UI-facing bucket every `FoundingBundleFailureReason` maps to (fixed by `FOUNDING_FAILURE_CATEGORY` in vote-engine). */
export type FoundingBundleFailureCategory = 'invalid-bundle' | 'error'

/** Out-of-band anchors a caller may supply to `verifyFoundingBundle`/`importFoundingBundle` (Phase 50 VerifySnapshotOptions pattern). */
export interface FoundingBundleImportOptions {
  /**
   * At least one anchor (this, `expectedDigest` or `expectedFingerprint`) is
   * REQUIRED by `importFoundingBundle`: without one it returns
   * `anchor-required` (D-36 out-of-band confirmation; initial/G2 WR-03).
   * There is no bypass flag; the app passes `expectedFingerprint`.
   */
  readonly expectedNetworkHash?: string
  readonly expectedDigest?: string
  /** The fingerprint the importing officer typed from the exporter's screen (case, spaces and dashes are ignored). */
  readonly expectedFingerprint?: string
  /** Forwarded to open(). */
  readonly getPeerCount?: () => number
}

/** The non-throwing result of `importFoundingBundle`. */
export type FoundingBundleImportResult =
  | {
      readonly ok: true
      readonly outcome: 'replayed' | 'already-present'
      /** 62-102: the bundle's fingerprint, for the record. */
      readonly fingerprint: string
      readonly networkRef: NetworkReference
      readonly network: INetworkEngine
    }
  | {
      readonly ok: false
      readonly reason: 'already-joined'
      readonly category: 'already-joined'
      readonly networkRef: NetworkReference
    }
  | {
      readonly ok: false
      readonly reason: FoundingBundleFailureReason
      readonly category: FoundingBundleFailureCategory
      readonly detail: string
    }
