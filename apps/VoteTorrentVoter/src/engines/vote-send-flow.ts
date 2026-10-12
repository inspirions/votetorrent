/**
 * vote-send-flow.ts — the Send button behind the vote receipt (spike 102, applied).
 *
 * Wires `sendSavedVote` to this phone: the joined network's node (its control connection carries
 * the pool traffic), the authority's rendezvous (the first of the addresses the join left behind,
 * the same for every voter who joined with that code), the sealed vote record (opened with one
 * fingerprint prompt) and the voting key (one prompt per block). Every dependency is injectable so
 * the flow is tested without a device. Nothing is logged.
 */
import {multiaddr} from '@multiformats/multiaddr';
import {createLibp2pRendezvousClient} from '@votetorrent/vote-engine/rn';
import type {SecretWrapPrompt} from '@votetorrent/attestation-native';
import {revealVoteReceipt} from './vote-receipt';
import type {VoteRecordEnvelope} from './vote-record-vault';
import {readJoinBootstrap} from './join-bootstrap';
import {resolveVoteSigningProducer} from './attestation-producer';
import type {AttestationProducer} from './attestation-producer';
import {digestBytesFromBase64Url} from './vote-casting';
import {VOTE_SENDING_PORT_ENGINE} from './vote-sending-port';
import {sendSavedVote} from './vote-sending';
import type {BallotSendStatus, SendSavedVoteResult, VoteSendingPort} from './vote-sending';
import {readVoteSent, recordVoteSent} from './vote-sent-store';

export type VoteSendFlowResult =
	| {kind: 'done', ballots: Array<{ballotId: string, status: BallotSendStatus}>}
	| {kind: 'no-network' | 'no-rendezvous' | 'canceled' | 'biometric-unavailable' | 'unreadable' | 'failed'}
	| {kind: 'voting-closed' | 'election-key-missing' | 'window-unreadable'}

export interface VoteSendFlowDeps {
	electionId: string
	envelope: VoteRecordEnvelope
	getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>
	/** the running CadreNode, or null before it boots */
	node: {getControlNode(): unknown} | null
	recordPrompt: SecretWrapPrompt
	consentPrompt: SecretWrapPrompt
	nowMs: () => number
	onStatus?: (ballotId: string, status: BallotSendStatus) => void
	signal?: AbortSignal
	producer?: AttestationProducer
	readRendezvousAddrs?: () => Promise<string[]>
	toDialTarget?: (addr: string) => unknown
	send?: typeof sendSavedVote
}

export async function runVoteSendFlow(deps: VoteSendFlowDeps): Promise<VoteSendFlowResult> {
	const control = deps.node?.getControlNode() ?? null;
	if (control === null || control === undefined) return {kind: 'no-network'};
	const addrs = await (deps.readRendezvousAddrs ?? readJoinBootstrap)();
	if (addrs.length === 0) return {kind: 'no-rendezvous'};

	const opened = await revealVoteReceipt(deps.electionId, deps.envelope, deps.recordPrompt);
	if (opened.kind !== 'ok') return {kind: opened.kind === 'canceled' || opened.kind === 'biometric-unavailable' || opened.kind === 'unreadable' ? opened.kind : 'failed'};

	let port: VoteSendingPort;
	try {
		port = await deps.getEngine<VoteSendingPort>(VOTE_SENDING_PORT_ENGINE);
	} catch {
		return {kind: 'no-network'};
	}
	const producer = resolveVoteSigningProducer(deps.producer);
	const signConsent = async (digest: string): Promise<string> => {
		const signed = await producer.signDeviceKeyDigest(digestBytesFromBase64Url(digest), {prompt: deps.consentPrompt});
		return signed.signature;
	};
	let target: unknown;
	try {
		target = (deps.toDialTarget ?? ((a: string) => multiaddr(a)))(addrs[0]!);
	} catch {
		return {kind: 'no-rendezvous'};
	}
	let result: SendSavedVoteResult;
	try {
		result = await (deps.send ?? sendSavedVote)({
			port,
			sentStore: {read: readVoteSent, record: recordVoteSent},
			record: opened.record,
			rendezvous: createLibp2pRendezvousClient(control as Parameters<typeof createLibp2pRendezvousClient>[0], target),
			signConsent,
			nowMs: deps.nowMs,
			onStatus: deps.onStatus,
			signal: deps.signal,
		});
	} catch {
		return {kind: 'failed'};
	}
	if (!result.ok) {
		return {kind: result.reason};
	}
	return {kind: 'done', ballots: result.ballots};
}
