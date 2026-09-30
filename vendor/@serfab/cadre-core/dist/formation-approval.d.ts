/**
 * Abort an unanswered approval request after this long when no `timeoutMs` is supplied.
 * Exported because the formation responder's provisioning budget has to contain it:
 * `formationDeadlines` (`strand-formation-deadlines.ts`) adds it as a flat term, since an HTTP
 * call to the hook does not cross the link between the two parties' machines.
 */
export declare const DEFAULT_APPROVAL_TIMEOUT_MS = 10000;
/**
 * Everything ONE approval is bound to — the five fields inside the approver's signed digest
 * (see `formationVouchMessage`), plus the hook to ask.
 *
 * Every field is fixed BEFORE the hook is contacted: the JOINER mints the nonce (and signs its
 * own consent over it) before its contact message is sent, and the redeeming node knows the
 * strand, the joiner's key, and the disclosure text it is about to write. That ordering is
 * what makes the resulting signature usable — an approval signed over a nonce the node did not
 * insert fails `FormationUsage.Authorized` at commit.
 */
export interface FormationApprovalRequest {
    /** Invitation token being redeemed. */
    token: string;
    /** Single-use nonce for THIS redemption, already minted by the JOINING peer. */
    usageStampId: string;
    /** The strand (network) being joined. */
    strandId: string;
    /** The joining peer's own ed25519 public key (written to `FormationUsage.PeerKey`). */
    peerKey: string;
    /**
     * The EXACT text that will be written to `FormationUsage.Disclosure`. The approver signs
     * these bytes verbatim and MUST NOT re-serialize them — the redeeming node computes this
     * string once and uses the identical string for both the signature and the insert.
     */
    disclosure: string;
    /**
     * The invite's `ValidationUrl` (the hook to contact). NOT part of the signed digest: it says
     * where to ask, not what is being approved.
     */
    validationUrl: string;
}
/**
 * The five signed fields on their own — what `formationVouchMessage` consumes, and the exact
 * JSON body posted to the hook. Derived from {@link FormationApprovalRequest} by subtraction so
 * a field added to the request must be consciously routed here (or the build breaks) rather
 * than silently dropping out of the digest.
 *
 * This is what an APPROVER receives: a hook is posted these five fields and nothing else, so it
 * has no `validationUrl` to supply and should type its request body as this, not as the full
 * {@link FormationApprovalRequest}.
 */
export type FormationVouchFields = Omit<FormationApprovalRequest, 'validationUrl'>;
/** An approver's answer: which key vouched, and its signature over the request's digest. */
export interface FormationApproval {
    /** Public key the approval claims; must match an enrolled `ValidationKey` row. */
    validationKey: string;
    /** base64url ed25519 signature over `formationVouchMessage(request)`. */
    validationSignature: string;
}
/**
 * Something that can obtain an approval for a redemption. The HTTP hook
 * ({@link createHttpFormationApprover}) is the production implementation; tests and embedded
 * deployments can supply their own.
 *
 * Rejects with a {@link FormationApprovalError} — never resolves to a "no". A caller that
 * receives a resolved {@link FormationApproval} may still find it does not verify; use
 * {@link verifyFormationApproval} before writing.
 */
export interface FormationApprover {
    /**
     * `signal` is the caller's cancellation (the formation responder's work budget expiring):
     * a pre-aborted or mid-flight abort rejects with an `unavailable`
     * {@link FormationApprovalError} without (further) contacting the hook. Optional so
     * signal-unaware implementations stay assignable.
     */
    requestApproval(request: FormationApprovalRequest, signal?: AbortSignal): Promise<FormationApproval>;
}
/**
 * Why an approval could not be obtained. The cases route differently: `refused` is a
 * final answer, `unavailable` may succeed on a later attempt, and `malformed` /
 * `unenrolled` / `misconfigured` are operator errors that retrying never fixes.
 *
 * `unenrolled` is thrown by the redeeming node's LOCAL enrollment pre-check (the recorder
 * asking its control database whether the approval's key is an enrolled `ValidationKey`
 * row), never by the HTTP client — a hook cannot know or report it.
 */
export type FormationApprovalFailure = 
/** The hook answered, and the answer is no. */
'refused'
/** Could not get an answer (network error, timeout, non-2xx status, redirect). */
 | 'unavailable'
/** Got an answer that is not a usable approval (not JSON, missing/blank fields, oversized). */
 | 'malformed'
/** The approval's `validationKey` is not an enrolled `ValidationKey` row (local pre-check). */
 | 'unenrolled'
/** The `ValidationUrl` or the runtime is unusable (bad scheme, no `fetch`). */
 | 'misconfigured';
/**
 * Failure to obtain an approval, carrying the {@link FormationApprovalFailure} category the
 * caller switches on to pick the rejection reason a would-be joiner is told.
 */
export declare class FormationApprovalError extends Error {
    readonly failure: FormationApprovalFailure;
    constructor(failure: FormationApprovalFailure, message: string, options?: {
        cause?: unknown;
    });
}
/**
 * Approver side: produce the approval for a request. Used by tests, and by anyone writing a
 * hook in TypeScript.
 *
 * `privateKeyB64`'s public half must be the key enrolled as the `ValidationKey` row the
 * redeeming node's control database will verify against — pass that same public key as
 * `validationKey` (derive it with `ed25519PublicKeyFromPrivate` if you only hold the seed).
 * Signing with a key that is not enrolled produces a perfectly valid signature that the
 * database still rejects.
 *
 * Takes the five signed fields, not a full {@link FormationApprovalRequest}: an approver is
 * posted only those five and has no `validationUrl` to hand back. A redeeming node holding a
 * whole request can still pass it straight in.
 *
 * @param fields - The redemption being approved (the five signed fields).
 * @param validationKey - base64url ed25519 public key that this approval claims.
 * @param privateKeyB64 - base64url 32-byte ed25519 seed to sign with.
 */
export declare function signFormationApproval(fields: FormationVouchFields, validationKey: string, privateKeyB64: string): FormationApproval;
/**
 * Redeeming side: does this approval actually verify against the bytes we are about to write?
 *
 * A LOCAL PRE-CHECK, not the authority. It turns a bad approval into a legible rejection
 * instead of an opaque `CHECK constraint failed: Authorized` at commit, and it catches the
 * ordinary drift case (the hook signed a different nonce/strand/peer than the one we hold).
 * It cannot substitute for the database check: this verifies against the key the approval
 * itself names, whereas `FormationUsage.Authorized` verifies against the STORED
 * `ValidationKey` row — which is what stops a redeemer approving itself with a key of its own
 * choosing.
 *
 * Returns a boolean and never throws (same contract as `verifyPeerAuthorization`): malformed
 * base64url, a garbage key, or any crypto failure resolves to `false`, logged at debug.
 */
export declare function verifyFormationApproval(fields: FormationVouchFields, approval: FormationApproval): boolean;
/**
 * Ask an outside approval service, over HTTP, whether a would-be joiner may redeem an
 * invitation. Contacted by the INVITING party's node (the formation responder) during
 * redemption — never by the joiner, which neither mints the nonce nor performs the write.
 *
 * Wire contract (documented for hook operators in `docs/api.md`):
 *
 * - `POST <ValidationUrl>`, `content-type: application/json`, `accept: application/json`.
 * - Body is exactly the five signed fields — `{ token, usageStampId, strandId, peerKey,
 *   disclosure }` — and nothing else. No owner keys, no bootstrap addresses, no membership
 *   keys ever reach the hook.
 * - `200` with `{ "validationKey": "...", "validationSignature": "..." }` is an approval.
 * - `401` / `403` is a refusal; any other non-2xx, a network error, a timeout, or a redirect
 *   is `unavailable`; a 2xx that is not a usable approval is `malformed`.
 *
 * Cross-platform by construction: global `fetch` + `AbortController` only, no `node:` imports.
 */
export declare function createHttpFormationApprover(options?: {
    /**
     * Abort the request after this long, INCLUDING the body read. Default 10s. Must stay under
     * the responder's provisioning budget — a hook that stalls must not stall formation.
     */
    timeoutMs?: number;
    /** Injectable for tests / non-standard runtimes. Defaults to `globalThis.fetch`. */
    fetchImpl?: typeof fetch;
}): FormationApprover;
