/**
 * election-read.ts — the voter's election/ballot read surface over the REAL engine chain
 * (`getEngine('elections')` -> `getElections()` -> `openElection()` -> `getElectionDetails()` /
 * `getBallots()` / `getBallotDetails()`), replacing the in-memory `mockData.ts` fixture the
 * Home/Ballot screens used to read.
 *
 * Only what the engine can source is filled in: id, title, the lifecycle state derived from the
 * election's timeline at read time, the countdown to the event that ends that state, and the
 * keyholder count. Voting progress, keys released, validation checks/fingerprint and
 * certification have NO engine source yet and are left absent — never faked (the `__DEV__`
 * override in `VoterAppProvider` is the only thing that ever fills them, from
 * `devLifecycleFixtures.ts`).
 */
import type {
	Ballot,
	ElectionSummary,
	IElectionEngine,
	IElectionsEngine,
	Question,
} from '@votetorrent/vote-core'
import { deriveTimeline } from '../timeline'
import type { TimelineStageId, TimelineViewModelConfident } from '../timeline'
import type { LifecycleContent, LifecycleState, Office, VoterBallot, VoterElection } from '../providers/types'

export interface ElectionReadDeps {
	getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>
	/** Election to fall back to when the network lists none (the `__DEV__` seeded election). */
	fallbackElectionId?: string
}

/** No election to read on the current network — callers render an unavailable state. */
export class NoElectionError extends Error {
	constructor () {
		super('No election is available on the current network')
		this.name = 'NoElectionError'
	}
}

/**
 * D-02's election-identity rule, a pure helper so it is testable without rendering. Shared by
 * Home, Ballot, Timeline and Keyholders so every surface reads the SAME election.
 * `ElectionsEngine.getElections()` filters `where E.Date >= :now` (elections-engine.ts:474), so
 * every summary this function ever receives is already in the FUTURE — picking the summary
 * nearest to now is therefore picking the soonest upcoming election, not "most recent" in the
 * sense of "just happened". Ties broken by ascending `id` for determinism. The single-summary
 * case (today's dev seed and every current deployment) is identical under either reading; the
 * multi-election surface (an election picker) is a deferred phase — see 59-CONTEXT.md Deferred
 * Ideas.
 *
 * `fallbackId` is passed as `__DEV__ ? seededElectionId : undefined` at the call site so the
 * `__DEV__` gate lives in one visible place: `seededElectionId` is `undefined` in every release
 * build (`providers/types.ts:203-209`), so relying on it alone would render an empty tab in
 * production.
 */
export function pickElectionId (summaries: ElectionSummary[], fallbackId: string | undefined): string | undefined {
	if (summaries.length === 0) {
		return fallbackId
	}
	if (summaries.length === 1) {
		return summaries[0].id
	}

	const nowMs = Date.now()
	let best: ElectionSummary | undefined
	let bestDiff = Number.POSITIVE_INFINITY
	for (const summary of summaries) {
		const diff = Math.abs(summary.date - nowMs)
		if (diff < bestDiff || (diff === bestDiff && best !== undefined && summary.id < best.id)) {
			best = summary
			bestDiff = diff
		}
	}
	return best?.id
}

async function openCurrentElection (deps: ElectionReadDeps): Promise<{ electionId: string, engine: IElectionEngine }> {
	const electionsEngine = await deps.getEngine<IElectionsEngine>('elections')
	const electionId = pickElectionId(await electionsEngine.getElections(), deps.fallbackElectionId)
	if (!electionId) {
		throw new NoElectionError()
	}
	return { electionId, engine: await electionsEngine.openElection(electionId) }
}

/**
 * Timeline stage (the last event whose instant has passed) -> card state. Voting closes at
 * `accruingVotes` (doc/election.md), so the three stages from there up to `tallyingStarts` are the
 * locked, keys-releasing window; tallying through certification is validation.
 * `ReviewSelections` and `ValidationDetails` are never derived — they are not points on the
 * timeline, only `__DEV__` review states.
 */
const STAGE_LIFECYCLE: Record<TimelineStageId, LifecycleState> = {
	registrationEnds: 'Upcoming',
	ballotsFinal: 'Upcoming',
	votingStarts: 'Open',
	accruingVotes: 'ReleasingKeys',
	hashingVotes: 'ReleasingKeys',
	releasingKeys: 'ReleasingKeys',
	tallyingStarts: 'Validation',
	validation: 'Validation',
	certificationStarts: 'Validation',
	closed: 'Complete',
}

/** The event that ENDS each derived state — its instant is the card's countdown target. */
const STATE_ENDED_BY: Partial<Record<LifecycleState, TimelineStageId>> = {
	Upcoming: 'votingStarts',
	Open: 'accruingVotes',
	ReleasingKeys: 'tallyingStarts',
	Validation: 'closed',
}

/** Card state + countdown target for a confident timeline view at `nowMs`. */
export function lifecycleFromTimeline (
	view: TimelineViewModelConfident,
	nowMs: number
): { lifecycleState: LifecycleState } & Pick<LifecycleContent, 'countdownTarget'> {
	const lifecycleState = view.currentStageId === null ? 'Upcoming' : STAGE_LIFECYCLE[view.currentStageId]
	const endStage = STATE_ENDED_BY[lifecycleState]
	const endMs = endStage === undefined ? null : view.rows.find(row => row.stageId === endStage)?.instantMs ?? null
	return endMs !== null && endMs > nowMs
		? { lifecycleState, countdownTarget: new Date(endMs).toISOString() }
		: { lifecycleState }
}

/**
 * Reads the current election and derives its card state at `nowMs`. Rejects with
 * `NoElectionError` when there is nothing to read, and with a plain `Error` when the election's
 * timeline is indeterminate (the Timeline tab's own D-03 rule: never a guessed state).
 */
export async function readVoterElection (deps: ElectionReadDeps, nowMs: number): Promise<VoterElection> {
	const { electionId, engine } = await openCurrentElection(deps)
	const details = await engine.getElectionDetails()
	const view = deriveTimeline({
		timeline: details.current.timeline,
		now: nowMs,
		election: { ballotDeadline: details.election.ballotDeadline, date: details.election.date },
	})
	if (view.indeterminate) {
		throw new Error(`Election ${electionId} has an indeterminate timeline: ${view.reason}`)
	}
	const keyholders = details.current.keyholders ?? []
	return {
		id: electionId,
		title: details.election.title,
		...lifecycleFromTimeline(view, nowMs),
		...(keyholders.length > 0 ? { keysTotal: keyholders.length } : {}),
	}
}

/**
 * Flattens the election's ballots into the voter's single office list: `select` questions only
 * (the rest are counted in `unsupportedQuestionCount`), ballots in id order, questions grouped by
 * `group` in first-appearance order and ordered by `sequence` within a group (declaration order
 * breaks ties and orders unsequenced questions).
 */
export function toVoterBallot (electionId: string, ballots: Ballot[]): VoterBallot {
	const entries: Array<{ office: Office, question: Question, index: number }> = []
	let unsupportedQuestionCount = 0
	for (const ballot of [...ballots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		for (const question of ballot.questions) {
			if ((question.type ?? 'select') !== 'select') {
				unsupportedQuestionCount++
				continue
			}
			const group = question.group?.trim()
			entries.push({
				question,
				index: entries.length,
				office: {
					id: `${ballot.id}:${question.code}`,
					title: question.title,
					...(group ? { group } : {}),
					voteFor: Math.max(1, question.optionRange?.max ?? 1),
					candidates: question.options.map(option => ({
						id: `${ballot.id}:${question.code}:${option.code}`,
						name: option.title,
						...(option.details ? { party: option.details } : {}),
					})),
				},
			})
		}
	}

	const groupRank = new Map<string | undefined, number>()
	for (const { office } of entries) {
		if (!groupRank.has(office.group)) groupRank.set(office.group, groupRank.size)
	}
	entries.sort((a, b) =>
		groupRank.get(a.office.group)! - groupRank.get(b.office.group)! ||
		(a.question.sequence ?? Number.POSITIVE_INFINITY) - (b.question.sequence ?? Number.POSITIVE_INFINITY) ||
		a.index - b.index
	)

	return { electionId, offices: entries.map(entry => entry.office), unsupportedQuestionCount }
}

/**
 * Reads the current election's ballot. Only officer-CONFIRMED ballots are offered to a voter;
 * `includeProposed` (passed `__DEV__` by the provider) also admits proposed-but-unconfirmed ones,
 * which is all the dev seed can produce without running the officer confirmation ceremony.
 */
export async function readVoterBallot (deps: ElectionReadDeps, options: { includeProposed: boolean }): Promise<VoterBallot> {
	const { electionId, engine } = await openCurrentElection(deps)
	const summaries = await engine.getBallots()
	const offered = options.includeProposed
		? summaries
		: (
				await Promise.all(
					summaries.map(async summary => ((await engine.getBallotConfirmationState(summary.id)).confirmed ? summary : null))
				)
			).filter((summary): summary is (typeof summaries)[number] => summary !== null)
	const ballots = await Promise.all(offered.map(async summary => (await engine.getBallotDetails(summary.id)).ballot))
	return toVoterBallot(electionId, ballots)
}
