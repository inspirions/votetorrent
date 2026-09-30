/**
 * storage-scope.ts — the scope keys `CadreNodeConfig.storage.provider` is called with.
 *
 * A provider is a factory cadre-core invokes once per **scope**: once for the control
 * database and once for each strand. A strand's scope key is its strand id; the control
 * database's scope key is what this module mints.
 *
 * WHY THE CONTROL SCOPE CARRIES THE PARTY ID. The control database holds the party's
 * own records — its strands, owner keys, peers, invitations, revocations. Two parties
 * on one device must therefore not share one control store, or a node started for
 * party B reads party A's rows as if party A had written them for B. Every other
 * party-scoped store in this codebase already knows this: `PersistentTrustedOwnerStore`,
 * `PersistentBootstrapPeerStore` and `PersistentEnrolledMachineStore` each take a
 * `partyId` and fail closed on a mismatch. Putting the party id in the key here means
 * no embedder has to know it belongs there, and none can get it wrong.
 *
 * WHY IT IS ENCODED. A party id is arbitrary text — nothing in cadre-core validates
 * its shape, and the React Native reference app lets a user type one into Settings.
 * Scope keys reach real namespaces unescaped: cadre-cli builds `${config.path}/${scope}`,
 * React Native a LevelDB filename, the browser an IndexedDB database name. A party id
 * containing `/` or `..` would escape the CLI's storage directory. Lowercase hex keeps
 * every key inside `[a-z0-9._-]`, the charset embedders rely on.
 *
 * WHY THE CHARSET HAS NO UPPERCASE. Windows (NTFS) and macOS (APFS/HFS+ by default)
 * compare file names without regard to case, while everything above the filesystem
 * compares with it. Two keys differing only in case — `control-YWFA` and `control-YWFa`,
 * the base64url keys of party ids `aa@` and `aaZ`, or strand ids `strand-ABC` and
 * `strand-abc` — would be two stores in memory and one folder on disk. With no uppercase
 * letter in the charset, two different keys are two different names on every
 * filesystem.
 *
 * THE STRAND ARM OF THAT CHARSET RULE IS ENFORCED HERE. A strand's scope key is
 * `StrandRow.Id`, and a strand row replicated into the control database by another
 * node in the party carries whatever id THAT node wrote. `assertStrandScopeKey`
 * (below) is the check that makes the charset true of strand keys too; it runs
 * unconditionally at the top of `StrandInstanceManager.startStrand`, so no strand id
 * reaches an embedder's provider — or a libp2p protocol prefix — unvalidated. A
 * mixed-case id is refused, not lowercased: lowercasing would silently merge two
 * distinct strands into one store. Ids cadre-core mints come from `strand-id.ts`, which
 * is built on the same predicate.
 */
/**
 * The storage scope key for a party's control database.
 *
 * Returns `control-` followed by the lowercase hexadecimal encoding of `partyId`'s
 * UTF-8 bytes, so the whole key stays within `[a-z0-9._-]` and is safe to use directly
 * as a file name, directory name or database name — and two party ids give two names
 * even on a filesystem that ignores case. See the module comment for why the encoding
 * is load-bearing rather than decorative.
 *
 * To read a party id back off a device — from, say, a LevelDB file named
 * `sereus-control-7061727479` — in a browser or Node console, with no dependency on
 * this package:
 * ```js
 * const hex = key.slice(key.indexOf('control-') + 'control-'.length);
 * new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)))
 * ```
 * The `TextDecoder` step is not optional: each hex pair is one BYTE, so a party id with
 * any non-ASCII character in it decodes to mojibake without it.
 *
 * NOTE: the key is twice the party id's UTF-8 byte length plus 8, so a party id over
 * ~120 bytes overflows the 255-byte limit filesystems put on one path component. Party
 * ids today are UUIDs (an 80-character key); if long party ids ever appear, hash the
 * party id rather than encoding it.
 */
export declare function controlStorageScope(partyId: string): string;
/**
 * Whether a scope key names a control database rather than a strand.
 *
 * A prefix test, and a sound one: a strand scope key can never begin `control-`,
 * because {@link isValidStrandScopeKey} rejects that prefix and
 * {@link assertStrandScopeKey} runs on every strand launch.
 */
export declare function isControlStorageScope(scope: string): boolean;
/**
 * Whether a strand id is usable as a storage scope key and as a libp2p network name.
 *
 * A strand id is not minted locally in the general case — a strand row replicates in
 * from another node in the party carrying whatever id THAT node wrote — and both
 * places it lands turn it straight into a name: the embedder's storage provider
 * (a directory under cadre-cli's storage path, a LevelDB filename, an IndexedDB
 * database name) and the strand node's protocol prefix `/optimystic/strand-<id>`.
 *
 * Valid means all of:
 * - non-empty, and at most {@link MAX_STRAND_SCOPE_KEY_LENGTH} characters;
 * - within `[a-z0-9._-]`, so no separator, drive letter, NUL or non-ASCII text, and no
 *   uppercase letter, so no two valid ids name one folder on a filesystem that ignores
 *   case;
 * - not `.` or `..`, which the charset admits but every filesystem reads as a
 *   directory rather than a name;
 * - not `control-`-prefixed, which would let a strand's store masquerade as a
 *   party's control database (see {@link isControlStorageScope}).
 */
export declare function isValidStrandScopeKey(strandId: string): boolean;
/**
 * Thrown when a strand id cannot be used as a storage scope key or network name.
 *
 * NOT retryable: the id is a property of the strand row, so every later attempt on
 * the same row fails identically. Callers that poll — `CadreNode.handleStrandAdded`
 * via `StrandWatcher` — suppress the strand rather than scheduling a retry.
 */
export declare class InvalidStrandIdError extends Error {
    readonly strandId: string;
    constructor(strandId: string);
}
/** {@link isValidStrandScopeKey} as an assertion, throwing {@link InvalidStrandIdError}. */
export declare function assertStrandScopeKey(strandId: string): void;
/**
 * The charset half of the rule on its own, for the CONTROL key.
 *
 * {@link assertStrandScopeKey} cannot serve here: it rejects the `control-` prefix by
 * design. Asserted at the seam that calls the provider (`CadreNode.resolveControlStorage`)
 * rather than inside {@link controlStorageScope}, so the guarantee belongs to the call
 * that hands a key out and not to one particular way of minting one.
 */
export declare function assertScopeKeyCharset(scope: string): void;
