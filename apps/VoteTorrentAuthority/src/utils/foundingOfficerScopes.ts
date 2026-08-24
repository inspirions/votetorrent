import type { Scope } from "@votetorrent/vote-core";

/**
 * D-15 — the founding officer of a fresh network/authority is the ONLY
 * officer until they invite others, so they are seeded with every scope: an
 * officer holding fewer than all nine scopes would be unable to reach some
 * of Phase 47's scope-gated screens (notably `'vrg'` and `'cap'`) on a
 * brand-new network, with no other officer able to grant it to them.
 *
 * The set below is the schema's `view Scope`
 * (packages/vote-core/schema/votetorrent.qsql:56-69) — NOT the TypeScript
 * `Scope` union (packages/vote-core/src/authority/models.ts:154-168). The
 * two have drifted: the TS union additionally declares `'rnp'`, which the
 * view does not define. `Officer.ScopesValid` (votetorrent.qsql:185) and
 * `ProposedOfficer.ScopesValid` (votetorrent.qsql:421) both reject any
 * scope code absent from `view Scope`, so seeding `'rnp'` would make the
 * founding-officer insert — part of the network-creation transaction —
 * throw, aborting "Add Network" entirely. See 47-02-PLAN.md's
 * `<blocking_correction>` for the full trace.
 *
 * This is exported as ONE shared constant, not duplicated as two inline
 * literals, because the two seed call sites (`AddNetworkScreen`,
 * `AdministratorInvitationScreen`) live in different screen trees and had
 * already drifted out of sync with the schema once (both previously seeded
 * only six of the nine codes) — a single exported array is the only shape a
 * seed-array unit assertion can actually pin against the schema.
 */
export const FOUNDING_OFFICER_SCOPES: readonly Scope[] = [
	"rn",
	"rad",
	"vrg", // unlocks registrant/association/challenge/polling-device administration
	"iad",
	"uai",
	"ceb",
	"mel",
	"cap", // unlocks authority-peer configuration
	"ik",
];
