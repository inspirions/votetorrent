# VoteTorrent Trust Architecture

> **What "trust architecture" means here.** Every voting system asks the voter, the
> candidates, and the public to *trust* something — a vendor, a server, a government
> body, a sealed machine, the people who count. A system's trust architecture is the
> precise list of *who and what you have to trust*, and *what you are able to verify
> for yourself instead of trusting*. The strongest systems shrink the first list and
> grow the second.
>
> This document does two things: (1) pinpoints the specific trust guarantees
> VoteTorrent's design aims to deliver, tracing each to the mechanism in the docs and
> stating its honest limits; and (2) compares VoteTorrent's trust architecture against
> the e-voting systems actually used in national elections today. The thesis is that
> VoteTorrent's architecture **distributes and minimizes trust** where every deployed
> national system today **concentrates it** — in a single authority, a single vendor,
> a single server, or a sealed box you cannot inspect.

---

## Part 1 — The trust guarantees VoteTorrent aims to provide

Each guarantee below names the design goal, the mechanism that delivers it (with the
source doc), and the **honest limit** — the residual trust or known open issue. The
limits matter: a credible "superior" claim is one that survives its own caveats.

### G1. Vote–voter unlinkability, including against indirect (traffic-analysis) attacks

**Goal.** "Voter can vote without the authority, peers, or any other party knowing for
which candidate" and "Stakeholders can tell which voters voted, but not what for."
([architecture.md](architecture.md), Overall Requirements)

**Mechanism.**
- Votes are batched into **blocks** with *scrambled ordering* so a vote cannot be
  positionally re-linked to the voter who cast it; a block is "a batch of voters and
  votes, with scrambled ordering so votes aren't related to voters"
  ([architecture.md](architecture.md), Glossary). Each block carries an *equal* number
  of voter entries and vote entries, and the two halves are not positionally bound.
- The vote proper carries a voter-chosen **vote nonce**, not the voter's identity; the
  voter entry carries the registrant key. They live in the same block but are not
  cross-indexed ([election.md](election.md), *Voter votes*).
- Crucially, **the indirect/metadata channel is addressed at the protocol layer**:
  blocks are not submitted by a lone voter to a central server (which would expose the
  voter's IP and timing alongside their ballot). Instead, voters **matchmake into a
  pool of peers** via rendezvous keys derived from local DHT-bucket bits + a topic
  hash, then co-form a block; the block reaches the network through a transactor squad,
  not from the voter's own address ([matchmaking.md](matchmaking.md);
  [election.md](election.md), *Vote Block Negotiation*). There is no central collector
  that sees `(voter IP, encrypted ballot)` pairs.

**Honest limit.** The docs are explicit about the residual edge case: *"If time is
running out on resolution and multiple block negotiations have failed, a voter may have
to submit a singular block — this reveals their vote to the authority"*
([election.md](election.md), *Attack Vectors & Limits*). Unlinkability is a property of
**being in a pool with peers**; a voter who cannot find peers (very sparse turnout, end
of window) degrades to a one-person block. This is a real boundary — but note it is a
*localized, last-resort* exposure to one party, not a structural server that sees every
ballot (contrast Estonia's Vote Collector, §2). Client-device malware can also violate
secrecy locally — a limit VoteTorrent shares with *every* system in which the voter
uses a personal device (Estonia, Switzerland, Voatz).

### G2. Premature-results protection (no early peeking at progress or outcome)

**Goal.** "Revealing election results requires *all* election keyholders to publish
their election keys at the appointed timeframe" ([architecture.md](architecture.md)).

**Mechanism.** Ballots are encrypted to a key that is **split across multiple
independent keyholders**. Each keyholder generates an election-specific keypair whose
private key is encrypted at rest under a biometric-backed, in-hardware registration key
and **never persisted in the clear** ([election.md](election.md), *Authority invites
keyholders*). Votes only become decryptable after **every** keyholder publishes their
private share during the *Releasing Keys* window — and each release is **timestamped by
declared Timestamp Authorities** ([election.md](election.md), *Election unlocked /
tallied*). No single party — not even the election authority — can decrypt or tally
early.

**Honest limit.** This is "all keyholders" (unanimous release), which is a strong
*confidentiality* guarantee but a weaker *availability* one: a missing keyholder stalls
the tally (the docs lean on keyholder ceremony discipline and dedicated stored devices).
And a keyholder who *leaks* a key early is caught but not prevented — premature
disclosure produces a signed, TSA-stamped **validation anomaly record**
([election.md](election.md), *Validation Process*), i.e. detection-after-the-fact, not
cryptographic impossibility. The protection is "you will be caught and proven to have
leaked," which is exactly the accountability that centralized systems lack.

### G3. Registration privacy via tiered selective disclosure (anti-telemarketer / anti-misuse)

**Goal.** A voter's identity detail must not become a public data set that
telemarketers, profilers, or hostile non-neighbors can harvest — while still letting an
authority prove eligibility and, where legitimate, reveal *some* detail to *some*
audience (e.g. same-district neighbors).

**Mechanism.** Registrant detail is split across **three content-addressed tiers**, each
referenced by a hash on the signed `Registrant` record and **all bound by the
authority's single signature** so none can be altered without detection
([registration.md](registration.md), *Private, Authority-held schema*):

| Tier | Record | Disclosure |
|------|--------|-----------|
| Public | `RegistrantPublic` (`PublicCid`) | Always public on the network |
| Selective | `RegistrantSelective` (`SelectiveCid`) | Released to a permitted audience *per election policy* |
| Private | `RegistrantPrivate` (`PrivateCid`) | Authority-held; never disclosed (SSN, DOB, phone…) |

*Which* selective fields are released and *to whom* is set per election by
`ElectionDisclosurePolicy(ElectionId, FieldName, Audience)` — an admin-signed record
where `Audience` is `district` (same-district neighbors) or `everyone`
([registration.md](registration.md), *Selective disclosure (spec)*). The default posture
is that sensitive PII lives in the never-disclosed private tier; the public network
never holds it. A recipient can recompute `Digest(RegistrantId, Expiration,
SelectiveDetails)` and check it against the authority-signed `SelectiveCid` to confirm
authenticity **without ever touching the private tier**.

**Honest limit.** Two, stated in the spec itself. (1) Selective disclosure is
*whole-set, all-or-nothing* and **authority-vouched, not independently verifiable** — a
disclosed subset is asserted by the authority, since the set is committed as one CID;
per-attribute reveal would need per-attribute salted commitments + a Merkle root (a
documented future option, currently a [spike](../.planning/spikes/selective-merkle/)).
(2) The never-disclosed private tier is still *held by the authority*, so PII privacy
from the authority itself is procedural, not cryptographic. The win is against
**third-party** misuse (the public network is not a PII firehose) and against
**tampering** (any change breaks the signed digest) — which is precisely the
telemarketer/profiler threat model in the prompt.

### G4. Authority-side integrity: signatures + content digests as math, not paperwork

**Goal.** "Authority may retain actual private information on voters, but any tampering
will change the hash and be detected"; every authoritative act is attributable and
forge-resistant ([architecture.md](architecture.md)).

**Mechanism.** The administration model is a **cryptographic chain of authority**, not a
trust-us assertion ([administration.md](administration.md)):
- The network's identity is the **CID of the primary authority's initial
  administration**, encoded directly into the protocol — the root of trust is a hash,
  so the network's name is inextricably bound to its founding authority
  ([election.md](election.md), *Network and Authorities Formed*).
- Every administrative act (register a voter, revise an election, invite an authority,
  release a key) requires **threshold signatures** from administrators holding the
  relevant **scope** (claim), produced by HSM/secure-enclave keys
  ([administration.md](administration.md), *Security Model*). Authority is *delegated*
  down a verifiable chain and *expires* unless renewed.
- Every record is content-addressed: `Cid = Digest(fields…)`, and the authority's
  signature is taken over that digest, so any field change invalidates the signature.
  Invitations use proof-of-possession of a private token
  (`PublicInviteToken = Hash(PrivateInviteToken + Salt)`) so onboarding cannot be forged
  ([administration.md](administration.md), *Cryptographic Relationships*).

The result: a stakeholder verifies authority actions **against public structures using
math**, "without requiring access to private data."

**Honest limit — and it is being fixed in the open.** The current `Digest()`
implementation joins fields with an unescaped `|` delimiter, which is **not injective**:
`Digest('a|b','c') == Digest('a','b|c')`, `Digest(null,'x') == Digest('','x')`, and
arity is unencoded. Because `Digest()` produces the very hash that admin/officer
signatures are taken over, a collision is a **signature-substitution surface**
([votetorrent-digest-canonicalization.md](votetorrent-digest-canonicalization.md);
[schema-conventions.md](schema-conventions.md)). The fix — a length-prefixed, framed,
arity-encoded pre-image — is specified and tracked. This is worth stating plainly: it is
a real, currently-open implementation bug. But note the contrast it draws: VoteTorrent's
hashing flaw is **public, reproduced with a committed test, and being corrected in the
open** — whereas the comparable cryptographic failures in deployed national systems (the
Swiss Bayer–Groth trapdoor; Brazil's hard-coded shared keys) were found *despite* closed
source and, in Brazil's case, are gagged by NDA so defenders cannot even discuss them.

### G5. Voter-verifiable inclusion and correct attribution ("my vote is in the count, for who I chose")

**Goal.** "Voter can verify presence and correctness of his or her vote"
([architecture.md](architecture.md)).

**Mechanism.** At cast time the voter privately retains their vote record **and the vote
nonce**; *"Nonce allows voter to verify presence of vote in election results"*
([election.md](election.md), *Voter votes*). Votes are hashed into a **Merkle tree**,
and tallying builds a parallel **tally tree** carrying a result histogram at each node,
with every node signed by its builders and TSA-timestamped. The voter then runs
**slice-level validation** ([election.md](election.md), *Validation*):
1. my vote entry is in an included block and unaltered;
2. my voter entry is in the same block and its signature is valid;
3. the block's hash matches (unaltered);
4. the block is included via valid branches **up to the root of the tally tree**, each
   node consistent.

This is genuine **individual, end-to-end verifiability** done by the voter's own device
against public data — recorded-as-cast *and* counted-as-recorded, attributable to the
voter's chosen answers (decryptable once keys release).

**Honest limit.** The docs flag that a voter *claiming* their vote was wrongly excluded
cannot always prove it to peers without the authority's key or block-pool membership
([election.md](election.md), *Attack Vectors & Limits*) — a known asymmetry that the
runoff/dispute machinery is designed to absorb statistically rather than resolve per-
voter. Verifiability is strong for *inclusion you can demonstrate*; *exclusion you
allege* is handled through dispute thresholds, not a personal cryptographic proof.

### G6. Universal verifiability: anyone can check eligibility and the final tally

**Goal.** "Stakeholders can verify that only eligible voters voted," "can verify the
final tally," and "All voters may participate in validation … made available to
stakeholders" ([architecture.md](architecture.md)).

**Mechanism.** Beyond per-voter slice checks, **any party** can run *comprehensive
validation* over the public record ([election.md](election.md), *Validation*): every
block has equal voter/vote counts, every voter signature is valid, every vote decrypts
to a valid answer, and every Merkle/tally-tree node's hashes and histograms are correct;
all authority records are properly signed and timed. Results, including *failed*
validations with whatever proof is available, are compiled into a public **build report**
with a suggested error margin. The authority is required to **commit to a single result
hash**, structurally preventing the publication of two disagreeing tallies
([election.md](election.md), *Runoff / Transparency Requirements*).

**Honest limit.** Universal verifiability is only as good as participation and data
availability — it presumes enough independent validators and archivers retain the
records. The design encourages this (media/authorities run comprehensive validation;
archivers pin CIDs) but does not force it. Several coordination questions in the tally/
report-building flow are still marked open (`Q:`) in [election.md](election.md) — this is
a maturing design, not a shipped, audited protocol.

### G7. No single point of trust (decentralization as the foundation)

**Goal.** Remove the central server/vendor/authority whose compromise or coercion breaks
everything.

**Mechanism.** Storage and processing run over a **Kademlia DHT peer-to-peer network**;
"any user can form a network, starting with only their own device," and
"storage and processing are distributed across all participants, with significant
overlap for redundancy" ([architecture.md](architecture.md);
[election.md](election.md)). The **Optimystic** distributed database commits transactions
across peer **clusters** by threshold promise, with peers refusing to sign contradictory
transactions ([optimystic.md](optimystic.md); [repository.md](repository.md)). The
authority's *legitimacy* is rooted in one primary authority, but its *operations*
(storage, block formation, validation, tally-tree construction) are spread across many
independent peers — including voter devices and volunteer infrastructure. Even a fully
in-person VoteTorrent deployment still gives the community "transparency, can contribute
server infrastructure, and would not be subject to … mistakes and corruption at the
hands of poll-workers and administrators" ([registration.md](registration.md),
*Exclusively In-Person*).

**Honest limit.** Decentralization shifts trust rather than abolishing it: voters trust
the *protocol* and the *honest-majority/threshold* assumptions of the peer clusters and
keyholder set, plus the primary authority as a root of legitimacy. P2P also brings its
own attack surface (eclipse/sybil concerns inherent to DHTs) that the matchmaking and
cluster-consensus rules mitigate but do not eliminate.

---

## Part 2 — How that compares to national e-voting systems in use today

The systems below are the ones actually running real national elections (or piloted in
them). For each, the relevant question is the same: **what must you trust, and what can
you verify yourself?**

### 2.1 Estonia — i-Voting (IVXV), national since 2005

The world's most mature nationwide internet voting system; **a majority of Estonian
votes were cast online in the 2023 Riigikogu election** — the first such election
anywhere.

- **Trust model:** Centralized, operated by the State Electoral Office. A **digital
  double-envelope** strips the voter's signature before decryption, and (since 2017) a
  **re-encryption mixnet** plus decryption proofs give universal verifiability.
- **The catch:** A central **Vote Collector** server receives both voter identity *and*
  the encrypted ballot. Researchers note an attacker controlling it "can learn all
  submitted ballots" — secrecy rests on *procedural* separation, not on the architecture
  making linkage impossible. Individual verifiability exists (a separate app), but only
  ~4% of voters use it, and academic work (Müller et al.) found a vulnerability
  contradicting the claimed individual verifiability.
- **Independent findings:** Springall, Halderman et al. (ACM CCS 2014) demonstrated lab
  attacks on **both servers and client devices** and recommended the system **be
  discontinued**. The client device is trusted with no cryptographic protection.

**VoteTorrent contrast:** There is **no equivalent of the Vote Collector** — no single
server that ever holds `(voter, ballot)` together, because blocks are peer-formed and
peer-submitted (G1). Estonia's threshold key (9 shares, 5-of-9) is conceptually similar
to VoteTorrent's keyholder release (G2), but Estonia trusts one operator to run the
collection and one client to behave; VoteTorrent distributes collection across the DHT
(G7).

### 2.2 Switzerland — Swiss Post e-voting (formerly Scytl), cantonal/federal trials

The most cryptographically ambitious deployed system — the closest external comparison to
VoteTorrent's verifiability goals.

- **Trust model:** Secrecy is split across **four independent control components** (holds
  as long as one is honest), and **paper return codes** mailed to each voter give
  client-malware-resistant individual verifiability; mixnet/ZK proofs give universal
  verifiability ("complete verifiability").
- **The catch:** A **centralized printing authority** prints every voter's return codes —
  a single point of trust for those secrets — and assessors flagged the **Setup Component**
  as a single point of failure. One vendor (Swiss Post) operates the system; trials are
  legally capped at **30% of a canton / 10% nationally**.
- **Independent findings:** The 2019 public audit (Lewis, Pereira, Teague) found a
  **cryptographic trapdoor** in the Bayer–Groth mixnet proof that would let an insider
  **alter votes while producing a proof that still verifies** — found *despite* the code
  review, and a 2021–2024 series of audits found further protocol-spec gaps and
  implementation vulnerabilities.

**VoteTorrent contrast:** Switzerland and VoteTorrent agree on the destination —
individual + universal verifiability — but Switzerland reaches it by **trust-splitting a
single vendor's components** and **trusting a central printer**, while VoteTorrent
removes the vendor and printer entirely and roots verifiability in voter-held nonces +
public Merkle/tally trees (G5, G6). Switzerland's return-code scheme is, candidly,
*stronger against client malware today* than VoteTorrent's pooling approach — an honest
point in Switzerland's favor. But its trust is concentrated in Swiss Post and the
printing authority; VoteTorrent's is not.

### 2.3 India — EVM + VVPAT, the largest electorate on Earth (~960M)

- **Trust model:** Standalone, non-networked machines (Control Unit + Ballot Unit) run by
  a single authority (the Election Commission) with firmware from two state
  manufacturers. **VVPAT** adds a voter-viewable paper slip — genuine *cast-as-intended*
  verification — and a **mandatory hand-count of 5 booths per constituency**.
- **The catch:** **Source code is secret**; the voter cannot confirm their slip was
  *counted*; the 5-booth audit is a *fixed number, not a statistically calibrated
  risk-limiting audit*; booth-level tallies can expose small-community voting patterns
  (the "totaliser" mixing fix has been blocked).
- **Independent findings:** Wolchok, Wustrow & Halderman et al. (ACM CCS 2010)
  demonstrated a **dishonest-display attack** and a **clip-on memory manipulator** that
  alters stored votes, and showed the **secrecy of the ballot is violable** by recovering
  vote order from machine memory.

**VoteTorrent contrast:** India's strength — a paper artifact the voter sees — is a
*physical* analog of VoteTorrent's verifiability, but it stops at the machine: there is
**no public, universal verifiability of the national tally** and no way for *you* to
audit it. VoteTorrent's tally tree is publicly re-computable by anyone (G6), its source
is open, and there is no sealed box whose firmware you must trust.

### 2.4 Brazil — urna eletrônica, the only 100%-electronic national election (~150M)

- **Trust model:** Standalone DRE machines run by the Electoral Justice (TSE), with
  pre-election digital signing of software and the publicly posted **Boletim de Urna**
  (per-machine result printout) enabling citizens/parties to re-check aggregation.
  Notably, the TSE runs an official **public security test** inviting outside attackers.
- **The catch:** **No voter-verifiable paper trail** — the printed vote has been ruled
  unconstitutional repeatedly (most recently 2020). Source is closed; parties may inspect
  only under **NDA**, so discovered flaws **cannot be publicly disclosed** (defenders
  gagged, attackers not).
- **Independent findings:** Aranha et al. (from the TSE's own tests) broke **ballot
  secrecy by recovering vote order**, found **hard-coded cryptographic keys shared across
  all machines and stored in source**, and **unauthenticated shared libraries allowing
  arbitrary code execution**.

**VoteTorrent contrast:** Brazil shows the failure mode VoteTorrent is built to avoid:
a single national authority, closed firmware, *shared* secret keys, and an NDA regime
that turns transparency into a one-way mirror. VoteTorrent's keys are per-keyholder and
per-election, never shared (G2); its records are individually voter-verifiable (G5); and
its flaws (e.g. the `Digest()` bug, G4) are disclosed and testable in the open.

### 2.5 United States — optical-scan paper + risk-limiting audits (Dominion / ES&S / Hart)

The best-practice US model is *not* the touchscreen but **hand-marked paper + RLA**, and
it is genuinely strong on its own terms.

- **Trust model:** **Software independence** (Rivest) — "an undetected change in the
  software cannot cause an undetected change in the outcome." A voter-verifiable paper
  ballot + a **risk-limiting audit** gives statistical assurance the *outcome* matches
  the paper **without trusting the vendor software**. "Verify the outcome, not the
  equipment."
- **The catch:** This is *universal/outcome* verifiability (auditing the aggregate), not
  per-voter individual verifiability — you trust the **chain of custody of the paper** and
  the audit process. Source is **proprietary**; the market is a **~90% Dominion/ES&S/Hart
  oligopoly**; Ballot Marking Devices are criticized (Appel, Stark, DeMillo) as "not
  meaningfully auditable" because most voters don't check the printout. NASEM (2018)
  recommends **against** internet return of voted ballots outright.

**VoteTorrent contrast:** This is the strongest comparison point — US paper+RLA earns
real trust the right way (software independence). VoteTorrent's claim relative to it is
**individual** verifiability (you check *your own* vote end-to-end, G5; paper+RLA cannot
let you do that secretly) plus removal of the **proprietary-vendor + physical-custody**
trust (G4, G7). The honest concession: paper+RLA's trust dependencies are *physical and
well-understood*, whereas VoteTorrent's are *cryptographic and software-based* — and
software-based systems carry the client-malware risk that paper does not. VoteTorrent
argues it dominates on verifiability and decentralization; paper+RLA arguably remains
safer against client-side compromise.

### 2.6 Voatz — mobile "blockchain" voting, US pilots (2018–2020)

The cautionary tale, and the system VoteTorrent is most often confused with ("an app,
blockchain, voting").

- **Trust model:** A proprietary mobile app over a **permissioned Hyperledger** of ~32
  near-identical nodes, all operated by/for Voatz on AWS/Azure — so the "blockchain"
  distributes **no** trust away from the operator.
- **The catch:** MIT (Specter, Koppel & Weitzner, USENIX Security 2020) showed the vote
  travels as "essentially standard web traffic" and that **tampering happens before the
  vote reaches the blockchain**, so the ledger adds little integrity. The only voter
  artifact was an emailed receipt that could say one thing while the vote was cast for
  another. Trail of Bits' commissioned audit found **79 issues** and that anyone with
  back-end access could "deanonymize votes, deny votes, alter votes, and invalidate audit
  trails." Source was closed and obfuscated; researchers reverse-engineered the APK.

**VoteTorrent contrast:** Voatz is the anti-pattern that proves VoteTorrent's point.
Voatz called itself decentralized while **one operator controlled every node** and **no
voter-verifiable record existed**. VoteTorrent's "blockchain-ish" layer (Merkle/tally
trees on a genuinely peer-operated DHT) exists *to make the count publicly recomputable*
(G6), not as marketing over a central server; and its verifiability is voter-held nonces
against public trees, not a forgeable receipt (G5). The difference is whether
decentralization and verifiability are **real and checkable** or **asserted**.

---

## Part 3 — The comparison at a glance

Legend: ✅ strong / structural · ◑ partial / procedural · ❌ absent or broken in practice.

| Trust dimension | VoteTorrent (design) | Estonia IVXV | Switzerland (Swiss Post) | India EVM+VVPAT | Brazil urna | US paper + RLA | Voatz |
|---|---|---|---|---|---|---|---|
| **No single server sees (voter, ballot)** | ✅ peer-pooled blocks | ❌ central Vote Collector | ◑ 4-component split | ✅ standalone box | ✅ standalone box | ✅ paper | ❌ central server |
| **Vote–voter unlinkability vs. traffic analysis** | ✅ matchmaking + scrambled blocks (◑ lone-voter edge) | ◑ procedural | ◑ procedural | ◑ vote-order recoverable | ❌ vote-order broken (Aranha) | ✅ physical | ❌ deanonymizable |
| **Individual (voter-checks-own-vote) verifiability** | ✅ nonce + slice proof | ◑ ~4% use it; flaw found | ✅ return codes | ◑ sees slip, not count | ❌ none | ❌ (secret ballot precludes) | ❌ forgeable receipt |
| **Universal (anyone-checks-tally) verifiability** | ✅ public Merkle/tally trees | ✅ mixnet+decrypt proofs | ✅ ZK proofs | ❌ no public tally audit | ◑ Boletim de Urna | ✅ RLA on paper | ❌ |
| **Premature-result protection** | ✅ all-keyholder timed release | ✅ threshold key, phase-gated | ✅ control-component keys | n/a (local count) | n/a | ✅ count after close | ❌ operator can read |
| **Registration / PII privacy from 3rd parties** | ✅ 3-tier; PII never on network (◑ authority-held) | ◑ | ◑ | ◑ booth-pattern leak | ◑ | ◑ | ❌ |
| **Open / publicly auditable source** | ✅ open; flaws disclosed+tested | ◑ partial | ✅ public audits | ❌ secret | ❌ NDA-gated | ❌ proprietary | ❌ closed/obfuscated |
| **Decentralized (no single authority/vendor to trust)** | ✅ DHT + delegated authority chain | ❌ single operator | ❌ single vendor | ❌ single commission | ❌ single court (TSE) | ❌ vendor oligopoly + custody | ❌ single operator |
| **Resistance to client-device malware** | ◑ (shared weakness) | ❌ | ✅ paper return codes | ✅ no personal device | ✅ | ✅ paper | ❌ |
| **Independent-research break of a core claim** | ◑ open `Digest()` bug (disclosed, fix specified) | ✅ found (2014; privacy 2023) | ✅ trapdoor 2019; gaps 2021–24 | ✅ Halderman 2010 | ✅ Aranha (secrecy+RCE) | — (model is sound) | ✅ MIT + Trail of Bits |

(In the last row, ✅ = a serious break *was demonstrated*. VoteTorrent's ◑ reflects an
open, self-disclosed implementation bug rather than an external break of a deployed
election — but it is listed, not hidden.)

---

## Part 4 — Where VoteTorrent is genuinely superior, and where it is not (yet)

**Superior — structurally, not just incrementally:**

1. **Trust distribution.** Every system in national use today concentrates trust in one
   place: Estonia's operator and Vote Collector, Switzerland's vendor and printer,
   India's and Brazil's single national authorities and secret firmware, the US vendor
   oligopoly plus physical custody, Voatz's single operator. VoteTorrent is the only
   architecture here that **removes the central server, the proprietary vendor, and the
   sealed box at once** (G7) — what remains to trust is a published protocol, a
   threshold of keyholders, and an honest-majority peer assumption.

2. **Individual end-to-end verifiability with secrecy.** Paper systems give you a secret
   ballot but no way to check *your own* vote; networked systems that give receipts
   (Voatz) make them forgeable. VoteTorrent's voter-held nonce + slice proof against
   public trees (G5) is a genuinely stronger position than most deployed systems offer.

3. **Premature-results protection by construction.** All-keyholder timed key release with
   TSA-stamped anomaly detection (G2) is stronger than any single-authority system, where
   the operator inherently *can* peek.

4. **Transparency as a one-way ratchet.** Open source + publicly reproduced flaws (even
   embarrassing ones like the `Digest()` collision) beats the NDA-gagged, closed-firmware
   posture of India, Brazil, and the US vendors — where the same class of cryptographic
   bug stayed hidden or undiscussable.

**Not yet superior — the honest ledger:**

- **Client-device malware.** VoteTorrent shares the universal weakness of personal-device
  voting and currently lacks Switzerland's return-code defense. This is the single most
  important gap relative to the best deployed networked system.
- **Maturity.** Estonia, Brazil, India, and US paper+RLA are *deployed and audited at
  national scale*; VoteTorrent is a *design with an in-progress implementation* carrying
  open coordination questions (`Q:` markers throughout [election.md](election.md)) and at
  least one live cryptographic bug (G4). Architectural superiority on paper is not the
  same as a battle-tested system.
- **Lone-voter and disputed-exclusion edge cases** (G1, G5) are real boundaries that
  centralized systems "solve" only by not offering the guarantee in the first place.

**Bottom line.** Trust architecture is about *who you must trust* versus *what you can
verify*. On that axis VoteTorrent is not a marginal improvement on the deployed systems —
it targets a different point in the design space: **minimize and distribute trust,
maximize what each voter and each member of the public can check for themselves.** Where
today's national systems ask you to trust an authority, a vendor, a server, or a sealed
machine, VoteTorrent asks you to trust a published protocol and a threshold of
independent parties — and hands you the math to check the rest. The honest caveats
(client malware, maturity, the open `Digest()` fix) are real and are stated here on
purpose: the argument for VoteTorrent's superiority is strongest precisely because it
does not need to hide them — a claim none of its centralized, closed-source counterparts
can make.

---

### Sources

**Internal (VoteTorrent design docs):** [architecture.md](architecture.md),
[election.md](election.md), [matchmaking.md](matchmaking.md),
[registration.md](registration.md), [administration.md](administration.md),
[optimystic.md](optimystic.md), [repository.md](repository.md),
[validations.md](validations.md), [schema-conventions.md](schema-conventions.md),
[votetorrent-digest-canonicalization.md](votetorrent-digest-canonicalization.md).

**External (comparison systems), selected primary sources:**
- Estonia: Springall, Finkenauer, Halderman et al., "Security Analysis of the Estonian
  Internet Voting System," ACM CCS 2014 (jhalderm.com/pub/papers/ivoting-ccs14.pdf);
  IVXV mixnet/decryption-proof analyses (eprint.iacr.org/2025/506, 2024/915);
  valimised.ee 2023 i-voting statistics.
- Switzerland: Lewis, Pereira & Teague, 2019 Swiss Post/Scytl trapdoor disclosure
  (unimelb.edu.au newsroom, Mar 2019); CITP analysis of the 2021–22 expert assessments
  (blog.citp.princeton.edu, Jun 2022); Swiss Post protocol docs (post.ch).
- India: Wolchok, Wustrow, Halderman, Prasad et al., "Security Analysis of India's
  Electronic Voting Machines," ACM CCS 2010 (indiaevm.org; jhalderm.com); Supreme Court
  VVPAT rulings (scobserver.in, 2024).
- Brazil: Aranha et al., "(The Return of) Software Vulnerabilities in the Brazilian
  Voting Machine," Computers & Security 2019 (dfaranha.github.io;
  sciencedirect.com/S0167404819301191); STF printed-vote ruling 2020 (agenciabrasil).
- United States: NASEM, *Securing the Vote* (2018, nap.nationalacademies.org/25120);
  Rivest, "On the Notion of Software Independence"; Stark, "A Gentle Introduction to
  Risk-Limiting Audits"; Appel, DeMillo & Stark on BMDs (*Election Law Journal*).
- Voatz: Specter, Koppel & Weitzner, "The Ballot is Busted Before the Blockchain,"
  USENIX Security 2020 (internetpolicy.mit.edu); Trail of Bits Voatz security review
  (blog.trailofbits.com, Mar 2020).
