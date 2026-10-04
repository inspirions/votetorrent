import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { InviteShareError, inviteShareErrorKey, parseInviteShare, resolveInviteFromShare } from '../invite-share';

function kp() {
	const priv = secp256k1.utils.randomSecretKey();
	return { invitePrivate: bytesToHex(priv), inviteKey: bytesToHex(secp256k1.getPublicKey(priv)) };
}
function share(over: Record<string, unknown> = {}) {
	const k = kp();
	return { k, text: JSON.stringify({ ...k, expiration: 'x', type: 'k', name: 'Ada Secret', ...over }) };
}

describe('parseInviteShare', () => {
	it('parses the onSend JSON share', () => {
		const { k, text } = share();
		expect(parseInviteShare(`  ${text}\n`)).toEqual({ invitePrivate: k.invitePrivate, inviteKey: k.inviteKey, type: 'k', name: 'Ada Secret' });
	});
	it('parses a raw 64-hex private key with no type', () => {
		const k = kp();
		expect(parseInviteShare(` ${k.invitePrivate} `)).toEqual({ invitePrivate: k.invitePrivate, inviteKey: k.inviteKey });
	});
	it('rejects malformed input', () => {
		const k = kp();
		expect(parseInviteShare('')).toBeUndefined();
		expect(parseInviteShare('not json')).toBeUndefined();
		expect(parseInviteShare('zz'.repeat(32))).toBeUndefined();
		expect(parseInviteShare('ab'.repeat(31))).toBeUndefined();
		expect(parseInviteShare(JSON.stringify({ invitePrivate: 'ab'.repeat(31) }))).toBeUndefined();
		expect(parseInviteShare(JSON.stringify({ invitePrivate: k.invitePrivate, inviteKey: kp().inviteKey }))).toBeUndefined();
	});
});

describe('resolveInviteFromShare', () => {
	it('malformed', async () => {
		const resolve = jest.fn();
		await expect(resolveInviteFromShare({ resolveInviteSlotCid: resolve }, 'junk', 'k')).rejects.toMatchObject({ code: 'malformed' });
		expect(resolve).not.toHaveBeenCalled();
	});
	it('wrong-type without calling the resolver', async () => {
		const resolve = jest.fn();
		const { text } = share({ type: 'of' });
		await expect(resolveInviteFromShare({ resolveInviteSlotCid: resolve }, text, 'k')).rejects.toMatchObject({ code: 'wrong-type' });
		expect(resolve).not.toHaveBeenCalled();
	});
	it('not-found with fixed message that leaks neither key nor name', async () => {
		const { k, text } = share();
		const err = await resolveInviteFromShare({ resolveInviteSlotCid: async () => undefined }, text, 'k').catch((e) => e);
		expect(err).toBeInstanceOf(InviteShareError);
		expect(err.code).toBe('not-found');
		expect(err.message).not.toContain(k.inviteKey);
		expect(err.message).not.toContain('Ada Secret');
	});
	it('success', async () => {
		const { k, text } = share();
		const resolve = jest.fn(async () => 'cid-1');
		const out = await resolveInviteFromShare({ resolveInviteSlotCid: resolve }, text, 'k');
		expect(out.slotCid).toBe('cid-1');
		expect(out.invitePrivate).toBe(k.invitePrivate);
		expect(resolve).toHaveBeenCalledWith(k.inviteKey, 'k');
	});
});

describe('inviteShareErrorKey', () => {
	it('maps codes and ignores other errors', () => {
		expect(inviteShareErrorKey(new InviteShareError('malformed'))).toBe('invitationAcceptMalformed');
		expect(inviteShareErrorKey(new InviteShareError('wrong-type'))).toBe('invitationAcceptWrongType');
		expect(inviteShareErrorKey(new InviteShareError('not-found'))).toBe('invitationAcceptNotFound');
		expect(inviteShareErrorKey(new Error('x'))).toBeUndefined();
	});
});
