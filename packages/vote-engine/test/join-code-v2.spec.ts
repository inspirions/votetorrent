/**
 * join-code-v2.spec.ts — phase 64 plan 04: the flattened `vtjoin2.` join code (D-01) and the
 * typed decode reasons (D-07), proven against inputs minted by cadre-core's REAL encoder.
 *
 *   JV-1..JV-9  codec behaviour
 *   JV-10       the committed real-encoder fixtures
 *   JV-11       source hygiene (no console, no byte-codec identifiers) with positive controls
 */
import { expect } from 'chai'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeCadreInvitation, encodeCadreInvitation } from '@serfab/cadre-core'
import {
  CADRE_INVITATION_PREFIX_EXPECTED,
  decodeNetworkJoinCode,
  encodeNetworkJoinCode,
  looksLikeJoinCode,
  NETWORK_JOIN_CODE_PREFIX,
  NETWORK_JOIN_CODE_PREFIX_V2,
  type NetworkJoinCode
} from '../src/networks/join-code.js'
import { foundingBundleFingerprint } from '../src/networks/founding-bundle.js'
import {
  mintInvitation,
  randomCadreInvitation,
  randomJoinAnchor
} from './fixtures/join-code-fixtures.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function asciiEscape (json: string): string {
  return json.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function b64u (text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const rawV2 = (obj: unknown): string => NETWORK_JOIN_CODE_PREFIX_V2 + b64u(asciiEscape(JSON.stringify(obj)))
const rawV2Json = (jsonText: string): string => NETWORK_JOIN_CODE_PREFIX_V2 + b64u(jsonText)
const rawV1 = (obj: unknown): string => NETWORK_JOIN_CODE_PREFIX + b64u(asciiEscape(JSON.stringify(obj)))

function windows16 (s: string): string[] {
  const out: string[] = []
  for (let i = 0; i + 16 <= s.length; i++) out.push(s.slice(i, i + 16))
  return out
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

function makeV2 (members = 1, name?: string) {
  const inv = randomCadreInvitation({ members })
  const anchor = randomJoinAnchor(name === undefined ? {} : { name })
  const mint = mintInvitation(inv)
  const code: NetworkJoinCode = { v: 2, invitation: mint, ...anchor }
  const body = {
    v: 2,
    invitation: inv as unknown as Record<string, unknown>,
    networkHash: anchor.networkHash,
    name: anchor.name,
    genesis: { ...anchor.genesis },
    digest: anchor.digest
  }
  return { inv, anchor, mint, code, body }
}

describe('64-04: vtjoin2. join code (JV)', () => {
  it('JV-1 a v2 code from a real cadre-core mint round-trips byte-identically', () => {
    const { inv, anchor, mint, code } = makeV2(2)
    const text = encodeNetworkJoinCode(code)
    expect(text).to.match(/^vtjoin2\.[A-Za-z0-9_-]+$/)
    const decoded = decodeNetworkJoinCode(text)
    if (!decoded.ok) throw new Error('JV-1: expected ok')
    expect(decoded.code.v).to.equal(2)
    expect(decoded.code.networkHash).to.equal(anchor.networkHash)
    expect(decoded.code.name).to.equal(anchor.name)
    expect(decoded.code.genesis).to.deep.equal(anchor.genesis)
    expect(decoded.code.digest).to.equal(anchor.digest)
    expect(decoded.fingerprint).to.equal(foundingBundleFingerprint(anchor.digest))
    expect(decoded.code.invitation === mint, 'invitation is byte-identical to the mint').to.equal(true)
    expect(decodeCadreInvitation(decoded.code.invitation)).to.deep.equal(inv)
  })

  it('JV-2 whitespace, tabs and CRLF anywhere still decode', () => {
    const text = encodeNetworkJoinCode(makeV2().code)
    const mangled = ` \t${text.slice(0, 30)}\r\n${text.slice(30, 200)}\n ${text.slice(200, 700)}\t\r\n${text.slice(700)}  \n`
    expect(decodeNetworkJoinCode(mangled).ok).to.equal(true)
  })

  it('JV-3 a non-ASCII name round-trips and the code text stays printable ASCII', () => {
    const { code } = makeV2(1, 'Élections — Zürich 選挙 🗳')
    const text = encodeNetworkJoinCode(code)
    expect(text).to.match(/^[\x21-\x7e]+$/)
    const decoded = decodeNetworkJoinCode(text)
    expect(decoded.ok && decoded.code.name).to.equal(code.name)
  })

  it('JV-4 each refusal case is malformed', () => {
    const { mint, body } = makeV2(1)
    const mut = (fn: (b: any) => void): string => { const b = clone(body) as any; fn(b); return rawV2(b) } // eslint-disable-line @typescript-eslint/no-explicit-any
    const json = JSON.stringify(body)
    const cases: Array<[string, string]> = [
      ['top-level extra key', mut((b) => { b.extra = 1 })],
      ['top-level missing digest', mut((b) => { delete b.digest })],
      ['__proto__ at top level', rawV2Json(json.replace(/^\{/, '{"__proto__":{},'))],
      ['__proto__ in invitation', rawV2Json(json.replace('"invitation":{', '"invitation":{"__proto__":{},'))],
      ['__proto__ in invite', rawV2Json(json.replace('"invite":{', '"invite":{"__proto__":{},'))],
      ['__proto__ in genesis', rawV2Json(json.replace('"genesis":{', '"genesis":{"__proto__":{},'))],
      ['constructor key in invitation', mut((b) => { b.invitation.constructor = 'x' })],
      ['invitation extra key', mut((b) => { b.invitation.extra = 1 })],
      ['invitation missing members', mut((b) => { delete b.invitation.members })],
      ['invite extra key', mut((b) => { b.invitation.invite.extra = 1 })],
      ['invite missing stampId', mut((b) => { delete b.invitation.invite.stampId })],
      ['genesis extra key', mut((b) => { b.genesis.x = 'y' })],
      ['genesis missing signerKey', mut((b) => { delete b.genesis.signerKey })],
      ['nested invitation.v = 2', mut((b) => { b.invitation.v = 2 })],
      ['invitation as a string (the v1 nesting)', mut((b) => { b.invitation = mint })],
      ['ownerKeys empty', mut((b) => { b.invitation.ownerKeys = [] })],
      ['ownerKeys of 17', mut((b) => { b.invitation.ownerKeys = Array.from({ length: 17 }, (_, i) => 'k' + i) })],
      ['members of 9', mut((b) => { b.invitation.members = Array.from({ length: 9 }, (_, i) => '/ip4/10.0.0.' + i + '/tcp/1') })],
      ['a non-string member', mut((b) => { b.invitation.members = [42] })],
      ['an empty partyId', mut((b) => { b.invitation.partyId = '' })],
      ['a 1025-char issuerSig', mut((b) => { b.invitation.invite.issuerSig = 'a'.repeat(1025) })],
      ['a 1025-char networkHash', mut((b) => { b.networkHash = 'a'.repeat(1025) })],
      ['name of 257 chars', mut((b) => { b.name = 'n'.repeat(257) })],
      ['totalUses 0', mut((b) => { b.invitation.invite.totalUses = 0 })],
      ['totalUses 1.5', mut((b) => { b.invitation.invite.totalUses = 1.5 })],
      ['totalUses as a string', mut((b) => { b.invitation.invite.totalUses = '1000' })],
      ['grantsOwner as a string', mut((b) => { b.invitation.invite.grantsOwner = 'false' })],
      ['peerId 42', mut((b) => { b.invitation.invite.peerId = 42 })],
      ['expiresAt empty', mut((b) => { b.invitation.invite.expiresAt = '' })],
      ['non-printable-ASCII partyId', mut((b) => { b.invitation.partyId = 'é' })],
      ['control char in invitePrivateKey', mut((b) => { b.invitation.invitePrivateKey = 'a\u0001b' })],
      ['top-level v 1 under the vtjoin2. prefix', mut((b) => { b.v = 1 })],
      ['an array body', rawV2([1, 2])],
      ['a non-JSON body', NETWORK_JOIN_CODE_PREFIX_V2 + b64u('not json at all')],
      ['a char outside the base64url alphabet', NETWORK_JOIN_CODE_PREFIX_V2 + 'abc$def'],
      ['a byte above 0x7f', NETWORK_JOIN_CODE_PREFIX_V2 + '_w'],
      ['digest too short to fingerprint', mut((b) => { b.digest = 'AAAA' })]
    ]
    for (const [label, input] of cases) {
      expect(decodeNetworkJoinCode(input), label).to.deep.equal({ ok: false, reason: 'malformed' })
    }
  })

  it('JV-4b an empty name decodes (v1 rule kept, R1)', () => {
    const { body } = makeV2(1)
    const b = clone(body)
    b.name = ''
    expect(decodeNetworkJoinCode(rawV2(b)).ok).to.equal(true)
  })

  it('JV-5 caps are measured after whitespace removal', () => {
    expect(decodeNetworkJoinCode(NETWORK_JOIN_CODE_PREFIX_V2 + 'A'.repeat(4089))).to.deep.equal({ ok: false, reason: 'malformed' })
    const text = encodeNetworkJoinCode(makeV2(1).code)
    expect(text.length).to.be.lessThan(4096)
    const padded = text.slice(0, 100) + ' '.repeat(4200) + text.slice(100)
    expect(padded.length).to.be.greaterThan(4096)
    expect(decodeNetworkJoinCode(padded).ok).to.equal(true)
    expect(decodeNetworkJoinCode(NETWORK_JOIN_CODE_PREFIX + 'A'.repeat(16_377))).to.deep.equal({ ok: false, reason: 'malformed' })
  })

  it('JV-6 dispatch: not-join-code, unsupported-version, malformed', () => {
    const body = encodeNetworkJoinCode(makeV2(1).code).slice(NETWORK_JOIN_CODE_PREFIX_V2.length)
    for (const input of ['', '   ', 'hello', 'https://example.org/x', 'sereus-invite:1.abc', 'VTJOIN2.abc', 'xvtjoin2.abc', body]) {
      expect(decodeNetworkJoinCode(input), JSON.stringify(input.slice(0, 12))).to.deep.equal({ ok: false, reason: 'not-join-code' })
    }
    for (const input of ['vtjoin3.abc', 'vtjoin10.abc', 'vtjoin0.abc']) {
      expect(decodeNetworkJoinCode(input), input).to.deep.equal({ ok: false, reason: 'unsupported-version' })
    }
    for (const input of [42, null, {}]) {
      expect(decodeNetworkJoinCode(input)).to.deep.equal({ ok: false, reason: 'malformed' })
    }
  })

  it('JV-7 looksLikeJoinCode', () => {
    for (const t of [' vtjoin2.\nabc', 'vtjoin9.x', 'vtjoin1.x', 'vtjoin2.']) expect(looksLikeJoinCode(t), t).to.equal(true)
    for (const t of [42, null, undefined, {}, '', 'VTJOIN2.x', 'sereus-invite:1.x', 'hello']) expect(looksLikeJoinCode(t)).to.equal(false)
  })

  it('JV-8 v1 compatibility, the 1.14 no-prefix rule, and opaque fakes', () => {
    const { anchor, mint } = makeV2(1)
    const v1 = encodeNetworkJoinCode({ v: 1, invitation: mint, ...anchor })
    const decoded = decodeNetworkJoinCode(v1)
    if (!decoded.ok) throw new Error('JV-8: expected ok')
    expect(decoded.code.v).to.equal(1)
    expect(decoded.code.invitation === mint).to.equal(true)

    const v1Body = (invitation: string) => rawV1({
      v: 1, invitation, networkHash: anchor.networkHash, name: anchor.name, genesis: { ...anchor.genesis }, digest: anchor.digest
    })
    const older = b64u('{"v":1,"partyId":"votetorrent","invitePrivateKey":"x"}')
    expect(decodeNetworkJoinCode(v1Body(older))).to.deep.equal({ ok: false, reason: 'invitation-older-version' })
    for (const opaque of ['eyJ2IjoxfQ', 'encoded-invitation', b64u('{"v":2,"partyId":"x"}')]) {
      expect(decodeNetworkJoinCode(v1Body(opaque)).ok, opaque).to.equal(true)
    }
  })

  it('JV-9 the encoder throws closed messages', () => {
    const { code, mint } = makeV2(1)
    const bad: Array<[string, NetworkJoinCode]> = [
      ['v 3', { ...code, v: 3 as unknown as 2 }],
      ['v2 without the prefix', { ...code, invitation: mint.slice(CADRE_INVITATION_PREFIX_EXPECTED.length) }],
      ['prefixed non-base64url body', { ...code, invitation: CADRE_INVITATION_PREFIX_EXPECTED + '!'.repeat(40) }],
      ['a name the decoder refuses', { ...code, name: 'n'.repeat(300) }]
    ]
    for (const [label, input] of bad) {
      let message = ''
      try { encodeNetworkJoinCode(input) } catch (e) { message = (e as Error).message }
      expect(message, label).to.not.equal('')
      expect(message, label).to.match(/^encodeNetworkJoinCode: /)
      for (const w of windows16(input.invitation)) expect(message.includes(w), label).to.equal(false)
    }
  })
})
