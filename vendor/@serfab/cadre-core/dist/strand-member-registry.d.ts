import type { Database } from '@quereus/quereus';
import type { MemberRegistration } from './types.js';
import type { MemberRegistry, MemberVerifier } from './enrollment.js';
import type { Ed25519KeyPair } from './ed25519-key.js';
/**
 * The canonical payload a joining member signs to prove ownership of its strand
 * member key, verified by {@link StrandMemberVerifier.verifyMember}.
 *
 * Binds the member key to the strand id so a registration signature cannot be
 * replayed against a different strand. Peer-id binding is intentionally NOT part
 * of this payload — `MemberPeer` rows carry their OWN per-peer self-proofs
 * (`MemberKey || '|' || PeerId`, signed by the member) and are written by the
 * dedicated `registerMemberPeer` writer; see {@link StrandMemberRegistry}.
 */
export declare function memberRegistrationPayload(registration: MemberRegistration): string;
/** How a {@link StrandMemberRegistry} admits a member into the strand. */
export type StrandAdmission = {
    /** Redeem a specific single-use invite (the invitee-side join). */
    readonly mode: 'invite';
    /** The `Invite.Key` (invite public key, base64url) to redeem. */
    readonly inviteKey: string;
    /** The matching invite private seed (base64url), received out-of-band. */
    readonly invitePrivateKey: string;
} | {
    /** Admit directly by manager signature (the manager-side join). */
    readonly mode: 'manager';
    /** The admitting manager's strand keypair. */
    readonly managerKeyPair: Ed25519KeyPair;
};
/**
 * Strand-`Database`-backed {@link MemberVerifier} — the reconciliation that lets
 * {@link EnrollmentService} make real authorization decisions against a strand's
 * `Invite`/`ConsumedInvite`/`Member` tables instead of a placeholder.
 *
 * Each instance is scoped to ONE strand's database (the `Strand.*` tables live
 * inside the connected strand DB), so the `strandId` arguments on the interface
 * are accepted for signature compatibility but the queries run against this db.
 */
export declare class StrandMemberVerifier implements MemberVerifier {
    private readonly db;
    constructor(db: Database);
    /**
     * Verify the member's self-proof over {@link memberRegistrationPayload} against
     * the registration's own `key` (the member's ed25519 public key). This is the
     * off-engine counterpart to the on-engine signature checks — a pre-flight gate
     * before the constraint-enforced write.
     */
    verifyMember(registration: MemberRegistration, signature: string): Promise<boolean>;
    /**
     * A member is authorized to join when either it has already consumed an invite
     * (a `ConsumedInvite` row bears its key) OR the strand has at least one
     * outstanding `Invite` it could redeem.
     *
     * Strand invites are anonymous — `Invite.Key` is an invite public key, not a
     * member key, so an un-consumed invite cannot be bound to a specific member
     * here. This check is therefore a "door is open" pre-flight; the binding,
     * single-use, and cryptographic gates are all enforced by the deferred
     * `Strand.*` constraints when the member is actually written.
     *
     * "Outstanding" is {@link listOutstandingInvites}: an `Invite` that is neither
     * already consumed, nor cancelled by a manager, nor expired. All three exclusions
     * mirror gates the actual write would hit (`ConsumedInvite`'s primary key,
     * `NotCancelled`, `NotExpired`), so this pre-flight does not report a door the
     * constraints will slam. A raw `Invite` count would over-report on all three.
     */
    isAuthorizedToJoin(_strandId: string, memberKey: string): Promise<boolean>;
}
/**
 * Strand-`Database`-backed {@link MemberRegistry} — writes real `Strand.Member`
 * (and, in invite mode, `Strand.ConsumedInvite`) rows through the signed writer
 * primitives, so {@link EnrollmentService.registerMember} performs the actual
 * per-strand join handshake rather than returning "MemberRegistry not configured".
 *
 * The {@link StrandAdmission} chosen at construction selects which branch of
 * `Member.Authorized` is taken:
 * - `invite`  → {@link consumeInvite} (atomic `Member` + `ConsumedInvite`), the
 *   invitee-side flow that redeems a single-use invite.
 * - `manager` → {@link addMemberByManager}, the manager-side flow that
 *   seats a member already trusted by a manager.
 *
 * Scoped to one strand's db; the `strandId` argument is accepted for interface
 * compatibility but writes target this db's `Strand.*` tables.
 *
 * NOTE: `peerIds` are NOT written as `MemberPeer` rows here. The signed peer path
 * now exists as the standalone `registerMemberPeer` writer (each peer self-proof is
 * signed by the member's own key), but wiring the enrollment `peerIds` through it is
 * a deliberate follow-on — the member self-proof available here does not carry the
 * per-peer signatures `MemberPeer.Authorized` requires. A non-empty `peerIds` is
 * logged and otherwise ignored so the member still lands; peer rows are reconciled
 * separately via `registerMemberPeer`.
 */
export declare class StrandMemberRegistry implements MemberRegistry {
    private readonly db;
    private readonly admission;
    constructor(db: Database, admission: StrandAdmission);
    registerMember(strandId: string, memberKey: string, peerIds: string[]): Promise<void>;
    isMemberRegistered(_strandId: string, memberKey: string): Promise<boolean>;
}
