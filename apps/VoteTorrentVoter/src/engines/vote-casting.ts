/**
 * vote-casting.ts - the Submit gate for local vote casting (Phase 63). `evaluateVoteEligibility`
 * decides whether Submit may sign; a later plan adds `castVote` to this file and signs only on the
 * producer instance this gate returns.
 *
 * Eight ordered gates, every dependency injected. The cheap, pure gates (1-5) run before any
 * native or engine call, so an unready ballot never touches the keystore:
 *   1. window open, from `readVoteContext` at the injected clock only (D-01);
 *   2. every ballot confirmed, and at least one ballot (D-03);
 *   3. no unsupported question and no `dependsOn` question (D-05, R-2);
 *   4. selections usable, required questions answered, `optionRange.min` met for answered
 *      questions (D-04, R-2);
 *   5. an all-blank ballot is eligible when nothing is required (R-3);
 *   6. a registered device: the P-256 device key, the exact `Association.DeviceKey` lookup, an
 *      active Registrant of the election's authority (D-06);
 *   7. `checkVotingKey` after the lookup hit (D-07, R-1);
 *   8. the local vote-record guard (D-20, D-21).
 *
 * Fail-closed: any read failure refuses with a closed reason and never enables Submit. The only
 * rejection is a producer override that cannot sign, which is a programming error.
 *
 * It never signs: this function only provisions and reads the key. It never uses the secp256k1
 * device user, because that key is not the one an Association names and would read "not
 * registered" forever. It never touches AsyncStorage: the saved-vote state arrives only through
 * the store's guard. It does not log; the closed reason is the only diagnostic.
 *
 * R-1: the D-06 lookup is the exact `Association.DeviceKey` match, so a rotated Android key reads
 * as not-registered. `checkVotingKey` runs after a hit as defence in depth, and no other lookup
 * route exists.
 */
import { checkVotingKey } from '@votetorrent/vote-engine/rn'
import type { IAssociationEngine, IRegistrationEngine } from '@votetorrent/vote-core'
import { readVoteContext, toVoterBallot } from './election-read'
import type { ElectionReadDeps, VoteContext } from './election-read'
import { resolveVoteSigningProducer } from './attestation-producer'
import type { AttestationProducer, VoteSigningProducer } from './attestation-producer'
import { guard as readVoteGuard } from './vote-record-store'
import type { VoteGuardResult } from './vote-record-store'
import type { LifecycleState } from '../providers/types'

export const VOTE_INELIGIBLE_REASONS = [
	'election-unavailable',
	'window-closed',
	'ballot-unconfirmed',
	'no-ballots',
	'unsupported-question',
	'dependent-question',
	'selection-invalid',
	'required-unanswered',
	'below-minimum',
	'device-check-failed',
	'not-registered',
	'registration-ambiguous',
	'device-key-rotated',
	'unreadable-key',
	'already-saved',
] as const

export type VoteIneligibleReason = (typeof VOTE_INELIGIBLE_REASONS)[number]

export interface VoteQuestionRef {
	officeId: string
	ballotId: string
	questionCode: string
}

/** ballotId -> questionCode -> optionCodes (distinct, ascending). Blank questions are absent. */
export type VoteSelections = Record<string, Record<string, string[]>>

export type VoteSelectionResult =
	| { ok: true, selections: VoteSelections, blankQuestions: VoteQuestionRef[] }
	| { ok: false, reason: 'selection-invalid' | 'required-unanswered' | 'below-minimum', questions: VoteQuestionRef[] }

export interface VotingIdentity {
	registrantId: string
	privateCid: string
	publicCid: string | null
	attestationCid: string | null
	/** The raw string `provisionDeviceKey` returned (SPKI base64 on Android). */
	currentDeviceKey: string
	/** `checkVotingKey`'s compressed key, the value the voter entry carries. */
	compressedDeviceKey: string
}

export interface VoteEligibilityDeps {
	getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>
	fallbackElectionId?: string
	/** `useVoterApp().nowMs()`, read fresh by the caller per evaluation. */
	nowMs: number
	/** `Office.id` -> selected `Candidate.id[]`. */
	selectionMap: Readonly<Record<string, readonly string[]>>
	/** DI seam; always passes through `resolveVoteSigningProducer`. */
	producer?: AttestationProducer
	readContext?: (deps: ElectionReadDeps, nowMs: number) => Promise<VoteContext>
	guard?: (electionId: string, currentRevision: number) => Promise<VoteGuardResult>
}

export interface VoteEligible {
	eligible: true
	context: VoteContext
	selections: VoteSelections
	blankQuestions: VoteQuestionRef[]
	voter: VotingIdentity
	/** The instance whose `provisionDeviceKey()` produced `voter.currentDeviceKey`; sign on it. */
	producer: VoteSigningProducer
	replacesStale: boolean
}

export interface VoteIneligible {
	eligible: false
	reason: VoteIneligibleReason
	questions: VoteQuestionRef[]
	ballotIds: string[]
	lifecycleState: LifecycleState | null
}

export type VoteEligibility = VoteEligible | VoteIneligible

function compareText (a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function compareRefs (a: VoteQuestionRef, b: VoteQuestionRef): number {
	return compareText(a.ballotId, b.ballotId) || compareText(a.questionCode, b.questionCode)
}

/**
 * Maps the UI selection map to structured codes through the confirmed ballots' offices
 * (`Office.ballotId` / `questionCode`, `Candidate.optionCode`); an id is never split. Pure: never
 * mutates its input and never throws on map contents.
 */
export function resolveVoteSelections (
	context: Pick<VoteContext, 'electionId' | 'ballots'>,
	selectionMap: Readonly<Record<string, readonly string[]>>
): VoteSelectionResult {
	const offices = toVoterBallot(context.electionId, context.ballots).offices
	const byId = new Map(offices.map(o => [o.id, o]))
	const codesByOffice = new Map<string, string[]>()
	const invalid = new Map<string, VoteQuestionRef>()

	for (const [officeId, ids] of Object.entries(selectionMap)) {
		const office = byId.get(officeId)
		if (!Array.isArray(ids)) {
			if (office !== undefined) invalid.set(officeId, { officeId, ballotId: office.ballotId, questionCode: office.questionCode })
			else invalid.set(officeId, { officeId, ballotId: '', questionCode: '' })
			continue
		}
		if (ids.length === 0) continue
		if (office === undefined) {
			// An unknown office carries no question ref.
			invalid.set(officeId, { officeId, ballotId: '', questionCode: '' })
			continue
		}
		const ref = { officeId, ballotId: office.ballotId, questionCode: office.questionCode }
		const codes = new Set<string>()
		let bad = false
		for (const id of ids) {
			const candidate = office.candidates.find(c => c.id === id)
			if (candidate === undefined) {
				bad = true
				break
			}
			codes.add(candidate.optionCode)
		}
		if (bad || codes.size > office.voteFor) {
			invalid.set(officeId, ref)
			continue
		}
		codesByOffice.set(officeId, [...codes].sort(compareText))
	}

	if (invalid.size > 0) {
		const questions = [...invalid.values()].filter(r => r.ballotId !== '').sort(compareRefs)
		return { ok: false, reason: 'selection-invalid', questions }
	}

	const selections: VoteSelections = {}
	for (const ballot of context.ballots) selections[ballot.id] = {}
	const blank: Array<{ ref: VoteQuestionRef, required: boolean }> = []
	for (const o of offices) {
		const ref = { officeId: o.id, ballotId: o.ballotId, questionCode: o.questionCode }
		const codes = codesByOffice.get(o.id)
		if (codes === undefined || codes.length === 0) {
			blank.push({ ref, required: o.required })
			continue
		}
		selections[o.ballotId][o.questionCode] = codes
	}

	const missing = blank.filter(b => b.required).map(b => b.ref).sort(compareRefs)
	if (missing.length > 0) return { ok: false, reason: 'required-unanswered', questions: missing }

	const belowMin: VoteQuestionRef[] = []
	for (const o of offices) {
		const codes = codesByOffice.get(o.id)
		if (codes === undefined || codes.length === 0) continue
		const q = context.ballots.find(b => b.id === o.ballotId)?.questions.find(x => x.code === o.questionCode)
		const min = q?.optionRange?.min
		if (typeof min === 'number' && codes.length < min) {
			belowMin.push({ officeId: o.id, ballotId: o.ballotId, questionCode: o.questionCode })
		}
	}
	if (belowMin.length > 0) return { ok: false, reason: 'below-minimum', questions: belowMin.sort(compareRefs) }

	return { ok: true, selections, blankQuestions: blank.map(b => b.ref).sort(compareRefs) }
}

function findUnvotableReason (context: VoteContext): { reason: 'unsupported-question' | 'dependent-question', questions: VoteQuestionRef[] } | null {
	if (context.unsupportedQuestionCount > 0) return { reason: 'unsupported-question', questions: [] }
	const questions: VoteQuestionRef[] = []
	for (const ballot of context.ballots) {
		for (const q of ballot.questions) {
			if (q.dependsOn != null) questions.push({ officeId: ballot.id + ':' + q.code, ballotId: ballot.id, questionCode: q.code })
		}
	}
	return questions.length > 0 ? { reason: 'dependent-question', questions: questions.sort(compareRefs) } : null
}

async function resolveVotingRegistrant (
	producer: VoteSigningProducer,
	getEngine: VoteEligibilityDeps['getEngine'],
	authorityId: string
): Promise<
	| { ok: true, voter: VotingIdentity }
	| { ok: false, reason: 'device-check-failed' | 'not-registered' | 'registration-ambiguous' | 'device-key-rotated' | 'unreadable-key' }
> {
	let publicKey: string
	try {
		const provisioned = await producer.provisionDeviceKey()
		publicKey = provisioned.publicKey
	} catch {
		return { ok: false, reason: 'device-check-failed' }
	}
	if (typeof publicKey !== 'string' || publicKey === '') return { ok: false, reason: 'device-check-failed' }

	const matches: Array<{ row: { registrantId: string, deviceKey: string, attestationCid?: string | null }, registrant: { id: string, privateCid: string, publicCid?: string | null } }> = []
	try {
		const rows = await (await getEngine<IAssociationEngine>('association')).getAssociationsByDeviceKey(publicKey)
		if (rows.length === 0) return { ok: false, reason: 'not-registered' }
		const registration = await getEngine<IRegistrationEngine>('registration')
		for (const row of rows) {
			const registrant = await registration.getRegistrant(row.registrantId)
			if (registrant !== undefined && registrant.status === 'a' && registrant.authorityId === authorityId) {
				matches.push({ row, registrant })
			}
		}
	} catch {
		return { ok: false, reason: 'device-check-failed' }
	}

	if (matches.length === 0) return { ok: false, reason: 'not-registered' }
	if (matches.length > 1) return { ok: false, reason: 'registration-ambiguous' }
	const match = matches[0]

	const check = checkVotingKey(publicKey, match.row.deviceKey)
	if (!check.ok) return { ok: false, reason: check.reason }

	return {
		ok: true,
		voter: {
			registrantId: match.registrant.id,
			privateCid: match.registrant.privateCid,
			publicCid: match.registrant.publicCid ?? null,
			attestationCid: match.row.attestationCid ?? null,
			currentDeviceKey: publicKey,
			compressedDeviceKey: check.compressedKey,
		},
	}
}

export async function evaluateVoteEligibility (deps: VoteEligibilityDeps): Promise<VoteEligibility> {
	const refuse = (
		reason: VoteIneligibleReason,
		extras: { questions?: VoteQuestionRef[], ballotIds?: string[], lifecycleState?: LifecycleState | null } = {}
	): VoteIneligible => ({
		eligible: false,
		reason,
		questions: extras.questions ?? [],
		ballotIds: extras.ballotIds ?? [],
		lifecycleState: extras.lifecycleState ?? null,
	})

	const read = deps.readContext ?? readVoteContext
	let context: VoteContext
	try {
		context = await read({ getEngine: deps.getEngine, fallbackElectionId: deps.fallbackElectionId }, deps.nowMs)
	} catch {
		return refuse('election-unavailable')
	}
	const lifecycleState = context.lifecycleState

	if (!context.open) return refuse('window-closed', { lifecycleState })
	if (context.unconfirmedBallotIds.length > 0) return refuse('ballot-unconfirmed', { ballotIds: [...context.unconfirmedBallotIds], lifecycleState })
	if (context.ballots.length === 0) return refuse('no-ballots', { lifecycleState })

	const unvotable = findUnvotableReason(context)
	if (unvotable !== null) return refuse(unvotable.reason, { questions: unvotable.questions, lifecycleState })

	const resolved = resolveVoteSelections(context, deps.selectionMap)
	if (!resolved.ok) return refuse(resolved.reason, { questions: resolved.questions, lifecycleState })

	const producer = resolveVoteSigningProducer(deps.producer)
	const registrant = await resolveVotingRegistrant(producer, deps.getEngine, context.authorityId)
	if (!registrant.ok) return refuse(registrant.reason, { lifecycleState })

	let saved: VoteGuardResult
	try {
		saved = await (deps.guard ?? readVoteGuard)(context.electionId, context.revision)
	} catch {
		return refuse('already-saved', { lifecycleState })
	}
	if (saved !== 'ok' && saved !== 'stale') return refuse('already-saved', { lifecycleState })

	return {
		eligible: true,
		context,
		selections: resolved.selections,
		blankQuestions: resolved.blankQuestions,
		voter: registrant.voter,
		producer,
		replacesStale: saved === 'stale',
	}
}
