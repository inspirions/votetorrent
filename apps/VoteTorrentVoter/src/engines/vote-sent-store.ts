/**
 * vote-sent-store.ts — which ballots of a saved vote have reached the network, and in which block.
 *
 * Non-secret: a ballot id and a block cid say nothing about the choices (the block's voter list is
 * public on the strand once it commits). Kept apart from the vote marker so a sent vote never
 * rewrites the record the receipt reads. The strand stays the authority: `sendSavedVote` asks the
 * replicated VoteBlockVoter rows before it pools a ballot, so a lost write here can never cause a
 * second vote.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const VOTE_SENT_KEY_PREFIX = 'votetorrent.voteSent.';

export interface VoteSentState {
	electionRevision: number
	/** ballotId -> VoteBlock.Cid */
	ballots: Record<string, string>
}

export function voteSentKey(electionId: string): string {
	return `${VOTE_SENT_KEY_PREFIX}${electionId}`;
}

function isSentState(value: unknown): value is VoteSentState {
	const v = value as VoteSentState;
	return v !== null && typeof v === 'object' && Number.isInteger(v.electionRevision) && v.ballots !== null && typeof v.ballots === 'object'
		&& Object.values(v.ballots).every(cid => typeof cid === 'string' && cid.length > 0);
}

/** The sent ballots for this election revision; an unreadable or older-revision record reads as none sent. */
export async function readVoteSent(electionId: string, electionRevision: number): Promise<Record<string, string>> {
	try {
		const raw = await AsyncStorage.getItem(voteSentKey(electionId));
		if (raw === null) return {};
		const parsed: unknown = JSON.parse(raw);
		return isSentState(parsed) && parsed.electionRevision === electionRevision ? {...parsed.ballots} : {};
	} catch {
		return {};
	}
}

export async function recordVoteSent(electionId: string, electionRevision: number, ballotId: string, cid: string): Promise<void> {
	const ballots = await readVoteSent(electionId, electionRevision);
	ballots[ballotId] = cid;
	const state: VoteSentState = {electionRevision, ballots};
	await AsyncStorage.setItem(voteSentKey(electionId), JSON.stringify(state));
}
