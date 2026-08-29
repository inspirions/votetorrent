import { join } from 'node:path'

/**
 * store.ts — the record/ciphertext storage contract.
 *
 * **This file is a declared contract with a deliberately loud stub body.** Plan
 * `52-03` replaces the implementation; the shapes below are its property and
 * must not be re-derived here. If any member name, the plural type name, or the
 * `async` return disagrees with `52-03-PLAN.md`, `52-03` wins and this file is
 * the one that is wrong.
 *
 * ## Notes for the implementer
 *
 * **What the service is allowed to know.** A `RendezvousRecord` has exactly
 * three fields. The service sees the derived look-up id and the expiry, plus
 * the used-flag it needs to keep `used`/`expired` answers precise past expiry —
 * and nothing else. Nothing about which network, which authority, or how large
 * the roll is may be added. A fourth field is a design violation, not an
 * optimisation.
 *
 * **Why the name is plural.** Records and ciphertext are two `FileKVStore`
 * instances (`@optimystic/db-p2p-storage-fs@0.24.2`) on two **separate**
 * `basePath`s. They must be independently erasable — ciphertext is dropped on
 * serve and at expiry while the payload-free record survives a grace window —
 * and a KV key's first path segment would otherwise share a namespace with
 * `FileRawStorage`'s block-id directories if both stores shared one base.
 * `claimsDir` is exposed because the retention sweeper has to delete claim
 * markers alongside the records they belong to.
 *
 * **What `FileKVStore` cannot give you.** Its `atomicWriteFile` is
 * temp -> fsync -> rename -> dir-fsync. That is durability, **not mutual
 * exclusion**: the rename is last-writer-wins and there is no create-if-absent
 * or compare-and-set. Single-use comes from `link(2)`'s atomic `EEXIST`,
 * reusing the `claimSingleUse` idiom already proven at
 * `packages/vote-engine/src/bootstrap/filesystem-bootstrap-transport.ts:205-227`.
 *
 * **Do not wrap the shipped filesystem bootstrap transport class as the
 * store.** It calls `parseSnapshot` on everything it reads and throws on
 * anything that is not a valid envelope — and a sealed ciphertext blob is not
 * one. Reuse its on-disk layout and its `link()` idiom; do not reuse the class.
 * (Its name is spelled out nowhere in this package on purpose, so a grep for
 * that class returns nothing here.)
 *
 * **Path safety.** A look-up id arrives from the network and becomes a path
 * segment. Guard it with the pattern at
 * `packages/vote-engine/src/bootstrap/filesystem-bootstrap-transport.ts:38-56`
 * before every `join()`, with no exceptions.
 */

/** Exactly three fields. See the module header before adding a fourth. */
export interface RendezvousRecord {
	lookupId: string
	/** Canonical 19-character datetime, no trailing `Z`. Compare it as a raw
	 * string; never route either side through a date parser. */
	expiresAt: string
	used: boolean
}

export interface RendezvousStores {
	dataDir: string
	claimsDir: string
	putRecord(r: RendezvousRecord): Promise<void>
	getRecord(lookupId: string): Promise<RendezvousRecord | undefined>
	markRecordUsed(lookupId: string): Promise<void>
	deleteRecord(lookupId: string): Promise<void>
	listRecordIds(): Promise<string[]>
	putCiphertext(lookupId: string, sealedJson: string): Promise<void>
	getCiphertext(lookupId: string): Promise<string | undefined>
	deleteCiphertext(lookupId: string): Promise<void>
}

function notImplemented (method: string): Promise<never> {
	return Promise.reject(new Error(`bootstrap-rendezvous-service: stores.${method} is not implemented yet`))
}

/**
 * Builds the two stores rooted at `dataDir`.
 *
 * Takes the data root as a parameter rather than the whole `ServiceConfig`, so
 * this module has no import edge to `config.ts` and every test is one `mkdtemp`
 * away. It is **async** because the real implementation creates its directories
 * before resolving.
 *
 * The stub resolves — `startService` has to be able to build a service context
 * — but every method **rejects**. A stub that resolved with an empty result
 * would be indistinguishable from a working store that found nothing, which is
 * exactly the failure this project has paid for before. The un-implemented
 * state must be loud.
 */
export async function createRendezvousStores (dataDir: string): Promise<RendezvousStores> {
	return {
		dataDir,
		claimsDir: join(dataDir, 'claims'),
		async putRecord (): Promise<void> {
			return notImplemented('putRecord')
		},
		async getRecord (): Promise<RendezvousRecord | undefined> {
			return notImplemented('getRecord')
		},
		async markRecordUsed (): Promise<void> {
			return notImplemented('markRecordUsed')
		},
		async deleteRecord (): Promise<void> {
			return notImplemented('deleteRecord')
		},
		async listRecordIds (): Promise<string[]> {
			return notImplemented('listRecordIds')
		},
		async putCiphertext (): Promise<void> {
			return notImplemented('putCiphertext')
		},
		async getCiphertext (): Promise<string | undefined> {
			return notImplemented('getCiphertext')
		},
		async deleteCiphertext (): Promise<void> {
			return notImplemented('deleteCiphertext')
		}
	}
}
