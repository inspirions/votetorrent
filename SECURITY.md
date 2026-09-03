# Security

The product-level security record for VoteTorrent: the decisions about **what data is published**,
the threats those decisions create, the **gates that bear on them**, and the **deployment
requirements** that outlive any single phase of work.

## What this file is, and three things it is not

It is a durable record. An entry here is meant to be inherited by the next reader rather than
rediscovered.

1. **It is not a vulnerability-disclosure policy.** This project has not made that decision, and
   this document does not invent one. Where to report a suspected vulnerability is not settled
   here, and no intake channel is implied by this file's name or location.
2. **It is not a phase audit.** Per-phase threat registers and their verdicts live in
   `.planning/phases/NN-*/NN-SECURITY.md` and are graded by `scripts/verify-security-controls.mjs`.
3. **It records no control as CLOSED.** It records decisions, threats, and the gates that bear on
   them. A verdict of "closed" is the phase auditor's to issue and is never issued by this file.

Why it sits at the repository root: `.planning` is gitignored (`.gitignore:101`), as is `.claude`
(`.gitignore:103`), so a decision recorded in either place is invisible to anyone reading the
product tree on a fresh checkout.

---

## Published data decisions

### PD-01 — `RegistrantPublic` is published on the anonymous public election view

**Status: MADE** — 2026-09-02, during phase 54's discussion of the public no-login election view
(decisions D-18, D-20, D-21). This entry is the record; the phase artifacts are not part of the
product tree.

**What is published.** `LastName`, `FirstName` and `District` — and only those three columns — for
the registrants of one addressed election. They render inline with the other public facts rather
than behind a reveal gate (D-20).

**What is not published.**

- `ExtraFields` is **never** rendered (D-19). The schema documents it as *"json object for
  authority-specific public fields"* (`packages/vote-core/schema/votetorrent.qsql:1818`) — that is,
  unconstrained authority-supplied JSON, with no schema to reason about and no review step between
  an authority writing it and a reader seeing it.
- `RegistrantSelective` is not read at all by the public view. Rendering its `everyone` subset
  requires selective-disclosure handling over salted leaves that no code in this repository
  implements (D-22).
- `RegistrantPrivate` is never readable from the public entry.

**Reasoning, as three named grounds.**

1. **It is the schema's designated public projection of a registrant**, and is named accordingly —
   the table declaration at `packages/vote-core/schema/votetorrent.qsql:1812` carries the public
   name columns and nothing private.
2. **Each row is attributable.** Registrant records are signed by the authority under the `vrg`
   ("validate registrations") signing scope — the schema ties a registrant signature task to an
   `AdminSigning` session with `Scope = 'vrg'`
   (`packages/vote-core/schema/votetorrent.qsql:1372`) — so a published row is tamper-evident and
   traceable to an authority rather than being an unattributed dump.
3. **Published voter rolls are ordinary practice** in many jurisdictions, so publishing one is not
   a novel exposure so much as a choice about which jurisdictional norm this software encodes.

**The schema finding that reframed this decision (a correction to spike 087).**
`ElectionDisclosurePolicy.FieldName` is documented as *"a top-level attribute name within
`RegistrantSelective.SelectiveDetails`"* (`packages/vote-core/schema/votetorrent.qsql:2300`).
The two-audience `DisclosureAudience` policy therefore governs **`RegistrantSelective` only**;
`RegistrantPublic` has **no per-field audience lever at all**. Spike 087 classified both tables
`POLICY_GATED`
(`.claude/skills/spike-findings-votetorrent/sources/087-public-observable-inventory/classification.js:54-55`).
That was wrong for `RegistrantPublic`. Stated plainly: **only one of the two tables ever had a
policy.** The corrected classification is `packages/web-data/src/classification.js`, where
`RegistrantPublic` is `PUBLIC`.

**What this supersedes.** The spike synthesis previously read *"Publishing it anonymously is a
policy decision nobody has made."* That note is retired by this entry. A reader who meets it in an
older copy should treat PD-01 as its successor.

**How to reverse it.** Move `RegistrantPublic` back to a non-public class in
`packages/web-data/src/classification.js`. The roll's read then fails closed **at import** —
`FORBIDDEN_CLASSES` membership makes a public module naming the table a crash rather than a review
miss — and the forbidden-table scan and query-shape gates enforce the reversal with no further
edit. Encoding the policy as a classification rather than an allowlist is what makes the reversal a
one-line change instead of an audit (D-15).

---

## Threats

### TH-01 — Anonymity boundary of the public election view

**Category:** Information Disclosure (STRIDE) · **Disposition:** mitigate · **ASVS:** L1

**Boundary.** An anonymous reader — no login, no identity, no device key — reaching the source set
of the public entry (`apps/VoteTorrentPublic/src` and `packages/web-data/src/public`).

**Threat.** A future edit makes reachable from the public entry a table carrying registrant PII
beyond the three columns of PD-01, private key material, or an unsigned `Proposed*` draft row.

| Control | Mechanism | Gate that proves it |
|---|---|---|
| Audience split (structural, primary) | `@votetorrent/web-data` splits by audience into `./public` and `./officer`; nothing reachable from `./public` may reach `./officer` by any specifier form — relative traversal, barrel re-export, deep import, bare subpath or dynamic specifier. Specifiers are resolved, not word-matched; an unparseable dynamic import is a failure. | `packages/web-data/test/audience-boundary.test.mjs`, with planted-violation controls |
| Forbidden-table source scan | Forbidden names are derived from `CLASSIFICATION` crossed with `FORBIDDEN_CLASSES`, never hand-listed; comments are stripped before matching; a positive control is required so "no leaks" cannot pass vacuously. | `packages/web-data/test/anonymity-scan.test.mjs` |
| Query shape | The roll's select list is **set-equal** to exactly `LastName`, `FirstName`, `District` — set equality, not containment, so a fourth column fails. The key-release aggregate joins `ReleaseKeyTaskExtension` to `Task` because the completion flag lives on the parent (`Task.IsCompleted`, `packages/vote-core/schema/votetorrent.qsql:1138`), and its select items must all be `count(`/`sum(` forms, so no bare column — `Task.Id` included — can appear in the select list at all; `ExtraFields`, `SigningNonce` and `UserId` are additionally banned from **any** clause of a public statement. Together these stop a result identifying *which* keyholder released. | `packages/web-data/test/query-shape.test.mjs` |
| Classification drift | `CLASSIFICATION`'s key set is set-compared against the `table` declarations parsed live from `packages/vote-core/schema/votetorrent.qsql`, so a newly added table fails on the schema edit rather than on the first read. | `packages/web-data/test/classification-drift.test.mjs` |

All four run with one command: `yarn workspace @votetorrent/web-data test`.

**Proof level of the four rows.** Rows 1, 2 and 4 are **source-scanned** — they read files and
resolve module graphs, and they execute in tier 1 with planted-violation controls. Row 3 is
**statement-shape asserted** against the exact SQL constants the read layer exports, with each
control mutating a real constant rather than a synthetic string. **None of the four is
browser-rendered** — for the rendered roll, see the browser-tier gate cited in *What these controls
do not prove* below.

#### What these controls do not prove

This subsection is the reason the section exists. Read it before citing anything above as a
guarantee.

- The forbidden-table scan is a **static source scan**. It proves that no forbidden table name
  appears **as code** in the public entry's file set. It does **not** prove the rendered page is
  anonymous: it cannot see a value reaching the DOM through a variable, a prop or a serialized
  blob, and it cannot see a table it does not know is forbidden, because the classification itself
  could be wrong.
- **Nothing in the table above proves anything about rendering.** The gates say so themselves: the
  query-shape gate *"reads STATEMENTS, not RESULTS … it cannot see what the render layer does with
  three permitted columns"*, and the roll's own tier-1 gate opens with *"nothing below renders …
  Presence is not rendering — this repo has shipped two defects on exactly that gap"*
  (`apps/VoteTorrentPublic/test/node/registrant-roll.test.mjs:14-19`). **That gate has since
  landed** (`apps/VoteTorrentPublic/test/browser/render-fidelity-gate.mjs`, run by
  `yarn workspace votetorrent-public test:render-fidelity`): against a seeded surface in a real
  browser, `roll-fields-rendered` finds the three columns and four rows;
  `roll-hides-extrafields-and-superseded` finds zero occurrences of the `ExtraFields` marker or the
  superseded record in `document.body.innerHTML`; and `roll-escapes-authority-text` finds zero
  injected elements from an XSS-shaped registrant name. Every comparator is exercised **both ways**
  under `--prove-matchers` — failing on a violating input and passing on a healthy one — because a
  comparator that fails on everything proves nothing. **This is a real rendering proof, and it is
  still an assertion over one fixture: it is not a proof about every authority's data.**
- The roll's **read** is data-proven rather than only source-scanned: `readRegistrantRoll` returns
  the expected rows against a real seeded database, and a positive control that removes the
  `RP.Cid = R.PublicCid` pin shows the superseded record would otherwise be published
  (`apps/VoteTorrentPublic/test/node/public-fixtures.test.mjs`). That gate also states its own
  limit — the result holds **within one process against `fake-indexeddb`**, and says nothing about
  what reaches a page.
- **No control here proves the browser's IndexedDB holds only publishable rows.** It holds whatever
  the bootstrap redemption wrote, which is an officer-scoped dataset. The guarantee is entirely
  about **what the page reads**, never about **what the database holds**.
- A gate proves a line exists and runs in test. It does **not** prove the shipped page routes
  through it. That distinction is called out here rather than assumed because this repository has
  already paid for assuming it — see `scripts/verify-security-controls.mjs:8-24`, which records a
  security document that marked nine threats CLOSED while the nine controls, though real, correct
  and unit-tested, were referenced nowhere outside their own package and their spec files: nothing
  in the shipping app knew they existed. That document stopped anyone looking for eleven days.

### OB-01 — `AdminSigning.Scope` is not cross-checked against the signing officer's `Officer.Scopes`

**Status: RECORDED — not assessed.** Surfaced during phase 54's voter-roll fixture work, then
re-derived against the schema for this entry. No impact analysis has been done and no disposition is
claimed.

`AdminSigning` carries a `Scope` column (`packages/vote-core/schema/votetorrent.qsql:240`). Its
`ScopeValid` constraint checks only that the value exists in the `Scope` view
(`packages/vote-core/schema/votetorrent.qsql:246`), and its `UserIdValid` constraint checks only
that the instigating user is an officer of the referenced administration
(`packages/vote-core/schema/votetorrent.qsql:247-252`). Neither checks that the officer's own
`Scopes` array contains the scope being exercised. Observed consequence, in this repo's own
fixtures: the founding officer is seeded with `Officer.Scopes = ["mel","ceb"]`
(`packages/web-data/test/fixtures/seed-founding-authority.js:47`), and the registrant-roll fixture
nonetheless completes `AdminSigning` sessions carrying `Scope = 'vrg'`
(`apps/VoteTorrentPublic/test/fixtures/registrant-roll-fixture.js:289`). Whether that is a real
authorization gap, or an intentional separation of a signing session's scope from the instigating
officer's scope set, has **not** been determined here.

Scope checks against `Officer.Scopes` **do** exist at specific sites — for example
`packages/vote-core/schema/votetorrent.qsql:113` requires a `rad`-scoped officer — so this is an
absence at one site, not a general absence of scope enforcement. Recorded here so it is inherited
rather than rediscovered; assessing it is future work.

---

## Deployment requirements

### DR-01 — the public election view reads only same-origin data

**Status: OPEN** — awaiting confirmation of the intended production topology. Recorded and
escalated 2026-09-03; unanswered as of that date. No default has been assumed on anyone's behalf.

**The mechanism.** `apps/VoteTorrentPublic` reads election data from the browser's own IndexedDB
(D-01: an anonymous reader's data comes from an already-bootstrapped browser). IndexedDB is
strictly partitioned by origin — scheme, host and port — so a database written under one origin is
not readable from another.

**The measurement.** The app that writes that database, `apps/VoteTorrentDashboard`, is served on
port 5180 (`apps/VoteTorrentDashboard/package.json:8`,
`apps/VoteTorrentDashboard/vite.config.ts:44`). The public view is served on port 5181
(`apps/VoteTorrentPublic/package.json:8`, `apps/VoteTorrentPublic/vite.config.ts:56`). In
development these are two different origins, and a database written by the dashboard is therefore
invisible to the public view.

**The requirement.** For the real-data path to activate for any reader, the app that writes the
database and the public view must be served from **one origin** — the same scheme, the same host
and the same port, differing only by path.

**This is an unresolved precondition, not a description of anything.** It is not currently
confirmed that any production deployment satisfies it, and no artifact in this repository settles
the question. Until it is confirmed, the real-data path should be treated as **conditional and
unproven in production**, and the honest-empty-state copy carries substantially more weight than
the phase that wrote it planned: if the two apps are served from different origins, the empty state
stops being an edge case and becomes what **every** visitor sees.

**The failure mode if the requirement is not met.** The public view renders its empty state —
*"This browser holds no elections yet."* (`packages/ui-web/src/copy.js:662`) — for every visitor,
with no error and no technical symptom. That is the origin partition working exactly as designed,
but it presents as a UI bug, which is what makes it expensive to diagnose.

**Why no gate covers this.** Every gate seeds IndexedDB under its own harness origin by
construction, so a same-origin harness is green whether or not production is same-origin. This
class of defect is structurally invisible to the test suite. That is precisely why it is recorded
as a requirement for a human to confirm rather than asserted by CI.

**Explicit non-claim.** This document states a requirement and **makes no claim about how the
product is or will be deployed.** D-01 fixed the *data source*; it never made a *deployment* claim,
so this is a gap in the decision record rather than a contradiction of it. Nothing in this section
should be read as saying the two apps are, or are planned to be, served from one origin. A future
answer of "yes, same origin is intended" would confirm an **intent**; it would still not describe a
deployed system, and this section must keep saying so.

---

## Scope and maintenance

This file carries decisions, threats and requirements that **outlive a single phase** of work:
what is published and why, the threats that publication creates, the gates that bear on them, and
the deployment conditions no test can check. It does **not** carry per-phase threat registers or
their verdicts — those live in `.planning/phases/NN-*/NN-SECURITY.md` and are graded by
`scripts/verify-security-controls.mjs`.

One rule this file obeys, mirroring the rule that checker states about itself: a `path:line`
citation here is a **human, reviewed edit** — never a machine rewrite. A citation that has drifted
is a finding to be read and corrected by a person, because a tool that silently re-points a
citation would destroy the only evidence that the underlying claim moved.
