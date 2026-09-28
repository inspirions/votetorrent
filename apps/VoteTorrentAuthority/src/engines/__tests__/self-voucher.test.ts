/**
 * RED → GREEN test for isSelfVouched (QUICK-260928-jwi).
 *
 * This mirrors cadre-core 1.6.0's private CadreNode#hasAnchoredVoucher(row) — checks 2-4 of
 * the authorized-membership predicate (complete voucher, owner anchored locally, signature
 * verifies) — applied to THIS peer's own CadrePeer row. It exists because
 * listAuthorizedMembers()/isAuthorizedMember() unconditionally exclude self (check 1,
 * cadre-node.js:6058 `row.peerId !== selfPeerId`), and isMember(self) skips the voucher
 * check entirely (true before any owner ever vouches).
 *
 * @serfab/cadre-core is ESM-only, so it is registered `{ virtual: true }` here exactly like
 * replication-proof-runner.test.ts.
 */

// `mock`-prefixed so jest's hoisted module factory can reference it.
const mockVerify = jest.fn();

jest.mock(
  '@serfab/cadre-core',
  () => ({
    verifyCadrePeerVoucher: (...a: unknown[]) => mockVerify(...a),
  }),
  { virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { isSelfVouched, type SelfVoucherNode } from '../self-voucher';

const SELF_PEER_ID = 'selfPeer';
const OWNER_KEY = 'ownerKeyB64';
const OTHER_OWNER_KEY = 'someOtherOwnerKeyB64';
const STAMP_ID = 'stamp-1';
const SIG = 'sigB64';

type Row = {
  peerId: string;
  multiaddr: string | null;
  stampId: string | null;
  vouchOwner: string | null;
  vouchSig: string | null;
};

const selfRowVouched: Row = {
  peerId: SELF_PEER_ID,
  multiaddr: null,
  stampId: STAMP_ID,
  vouchOwner: OWNER_KEY,
  vouchSig: SIG,
};

function makeNode(opts: {
  rows?: Row[] | (() => Promise<Row[]>);
  ownerSet?: Set<string>;
  noDb?: boolean;
  noStore?: boolean;
}): SelfVoucherNode {
  const queryCadrePeers = jest.fn(async () => {
    if (typeof opts.rows === 'function') {
      return opts.rows();
    }
    return opts.rows ?? [];
  });
  return {
    getControlDatabase: () => (opts.noDb ? null : { queryCadrePeers }),
    getTrustedOwnerStore: () =>
      opts.noStore ? null : { has: (k: string) => (opts.ownerSet ?? new Set([OWNER_KEY])).has(k) },
  } as unknown as SelfVoucherNode & { __queryCadrePeers: jest.Mock };
}

beforeEach(() => {
  mockVerify.mockReset();
  mockVerify.mockReturnValue(true);
});

describe('isSelfVouched', () => {
  it('resolves true when the self row is fully vouched by an anchored owner and verify succeeds', async () => {
    const node = makeNode({ rows: [selfRowVouched] });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(true);

    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenCalledWith(SELF_PEER_ID, STAMP_ID, OWNER_KEY, SIG);
  });

  it('resolves false when queryCadrePeers returns only OTHER peers fully vouched rows', async () => {
    const node = makeNode({
      rows: [
        {
          peerId: 'someOtherPeer',
          multiaddr: null,
          stampId: STAMP_ID,
          vouchOwner: OWNER_KEY,
          vouchSig: SIG,
        },
      ],
    });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('resolves false and does not call verify when stampId is null', async () => {
    const node = makeNode({ rows: [{ ...selfRowVouched, stampId: null }] });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('resolves false and does not call verify when vouchOwner is null', async () => {
    const node = makeNode({ rows: [{ ...selfRowVouched, vouchOwner: null }] });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('resolves false and does not call verify when vouchSig is null', async () => {
    const node = makeNode({ rows: [{ ...selfRowVouched, vouchSig: null }] });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('resolves false and does not call verify when the self row is complete but its owner is not anchored', async () => {
    const node = makeNode({ rows: [selfRowVouched], ownerSet: new Set([OTHER_OWNER_KEY]) });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('resolves false when the self row is complete, owner is anchored, but verify returns false', async () => {
    mockVerify.mockReturnValue(false);
    const node = makeNode({ rows: [selfRowVouched] });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });

  it('resolves false without throwing when getControlDatabase() returns null', async () => {
    const node = makeNode({ noDb: true });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
  });

  it('resolves false without throwing and never calls queryCadrePeers when getTrustedOwnerStore() returns null', async () => {
    const queryCadrePeers = jest.fn(async () => [selfRowVouched]);
    const node: SelfVoucherNode = {
      getControlDatabase: () => ({ queryCadrePeers }),
      getTrustedOwnerStore: () => null,
    };

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(queryCadrePeers).not.toHaveBeenCalled();
  });

  it('rejects (does not swallow) when queryCadrePeers rejects', async () => {
    const err = new Error('control DB not readable yet');
    const node = makeNode({
      rows: () => Promise.reject(err),
    });

    await expect(isSelfVouched(node, SELF_PEER_ID)).rejects.toBe(err);
  });
});
