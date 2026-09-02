/**
 * networks-registry.js -- outline contract 4: the localStorage inventory of
 * networks this browser holds a local copy of.
 *
 * This is the switcher's ONLY source of truth (50-09) and it deliberately
 * NEVER duplicates snapshot content -- no row counts, no digests, no table
 * data. Those live in 50-05's separate contract-C5 row-count record
 * (`votetorrent.dashboard.rowcounts.${networkHash}`, a DIFFERENT web-storage
 * key -- neither plan edits the other's storage shape.
 *
 * Per D-16's honesty rule: this is an INVENTORY, not a security control.
 * Anyone who can edit this origin's web storage can edit its IndexedDB too.
 *
 * Deliberately SYNCHRONOUS (unlike 50-05's reattach.js, whose read/write
 * functions are async): `src/main.tsx` needs a synchronous "does this
 * browser hold any network" check at render time, and `localStorage` access
 * is inherently synchronous. `src/lifecycle/bootstrap.js` calls these
 * directly from inside its own async orchestration -- calling a sync
 * function from async code needs no `await`.
 */

/** @type {'votetorrent.dashboard.networks'} */
export const NETWORKS_REGISTRY_KEY = 'votetorrent.dashboard.networks';

/** A stored registry entry, or the whole registry blob, failed shape validation.
 * Names the offending FIELD NAME only -- `authorityName`/`domain` are snapshot
 * content and must never be interpolated into a thrown message. */
export class InvalidNetworkRegistryError extends Error {
	/**
	 * @param {string} field
	 * @param {string} reason
	 */
	constructor(field, reason) {
		super(`networks-registry: field "${field}" is invalid -- ${reason}`);
		this.name = 'InvalidNetworkRegistryError';
		this.field = field;
	}
}

/**
 * @typedef {{ getItem(key: string): string | null | undefined, setItem(key: string, value: string): void, removeItem(key: string): void }} StorageAdapter
 */

/**
 * @typedef {{ networkHash: string, authorityName: string, domain: string, officerUserId: string, bootstrappedAt: string }} NetworkRegistryEntry
 */

/** Outline contract 4's exact five fields, and no more. */
const ENTRY_FIELDS = /** @type {const} */ (['networkHash', 'authorityName', 'domain', 'officerUserId', 'bootstrappedAt']);

/**
 * @param {StorageAdapter} [storage]
 * @returns {StorageAdapter | undefined}
 */
function resolveStorage(storage) {
	if (storage) return storage;
	return typeof globalThis !== 'undefined' ? /** @type {StorageAdapter | undefined} */ (globalThis.localStorage) : undefined;
}

/**
 * @param {StorageAdapter} [storage]
 * @returns {StorageAdapter}
 */
function requireStorage(storage) {
	const s = resolveStorage(storage);
	if (!s || typeof s.getItem !== 'function' || typeof s.setItem !== 'function' || typeof s.removeItem !== 'function') {
		throw new TypeError(
			'networks-registry.js: no storage adapter available -- pass one explicitly (e.g. a Map-backed fake in a Node test) or run in an environment with localStorage',
		);
	}
	return s;
}

/**
 * Validate one candidate entry against the exact five fields -- used on BOTH
 * read and write, so a hand-mangled stored blob is caught the same way a bad
 * write would be. Never interpolates a value into the thrown message.
 *
 * @param {unknown} candidate
 * @returns {NetworkRegistryEntry}
 */
function validateEntry(candidate) {
	if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
		throw new InvalidNetworkRegistryError('(entry)', 'must be an object');
	}
	const entry = /** @type {Record<string, unknown>} */ (candidate);

	for (const key of Object.keys(entry)) {
		if (!ENTRY_FIELDS.includes(/** @type {typeof ENTRY_FIELDS[number]} */ (key))) {
			throw new InvalidNetworkRegistryError(key, 'is not a recognized registry field');
		}
	}
	for (const field of ENTRY_FIELDS) {
		if (typeof entry[field] !== 'string') {
			throw new InvalidNetworkRegistryError(field, 'must be a string');
		}
	}

	const bootstrappedAt = /** @type {string} */ (entry.bootstrappedAt);
	if (bootstrappedAt.length !== 19) {
		throw new InvalidNetworkRegistryError('bootstrappedAt', `must be exactly 19 characters, got ${bootstrappedAt.length}`);
	}
	if (bootstrappedAt.includes('Z')) {
		throw new InvalidNetworkRegistryError(
			'bootstrappedAt',
			'must not contain "Z" -- canonical datetimes carry no timezone suffix',
		);
	}

	return {
		networkHash: /** @type {string} */ (entry.networkHash),
		authorityName: /** @type {string} */ (entry.authorityName),
		domain: /** @type {string} */ (entry.domain),
		officerUserId: /** @type {string} */ (entry.officerUserId),
		bootstrappedAt,
	};
}

/**
 * Read the whole registry. Fails SOFT (returns `[]`) on absent, empty-string
 * or non-array storage content -- a first visit and a cleared origin are
 * both normal. Fails HARD (throws, naming the field) on a parseable array
 * whose ENTRIES are structurally wrong -- that is corruption, and silently
 * dropping it would strand the officer's networks with no explanation. This
 * asymmetry is deliberate.
 *
 * @param {StorageAdapter} [storage]
 * @returns {NetworkRegistryEntry[]}
 */
export function listNetworks(storage) {
	const s = requireStorage(storage);
	const raw = s.getItem(NETWORKS_REGISTRY_KEY);
	if (raw === null || raw === undefined || raw === '') return [];

	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	return parsed.map((entry) => validateEntry(entry));
}

/**
 * @param {string} networkHash
 * @param {StorageAdapter} [storage]
 * @returns {NetworkRegistryEntry | undefined}
 */
export function findNetwork(networkHash, storage) {
	return listNetworks(storage).find((entry) => entry.networkHash === networkHash);
}

/**
 * Append a new `networkHash`, or REPLACE an existing one IN PLACE (preserving
 * the order of every other entry) -- two different hashes coexist (D-08).
 *
 * @param {unknown} entry
 * @param {StorageAdapter} [storage]
 * @returns {NetworkRegistryEntry}
 */
export function upsertNetwork(entry, storage) {
	const s = requireStorage(storage);
	const validated = validateEntry(entry);
	const all = listNetworks(storage);
	const index = all.findIndex((e) => e.networkHash === validated.networkHash);
	if (index === -1) {
		all.push(validated);
	} else {
		all[index] = validated;
	}
	s.setItem(NETWORKS_REGISTRY_KEY, JSON.stringify(all));
	return validated;
}

/**
 * Remove one entry. A no-op on an unknown hash -- leaves every other entry
 * untouched.
 *
 * @param {string} networkHash
 * @param {StorageAdapter} [storage]
 * @returns {void}
 */
export function removeNetwork(networkHash, storage) {
	const s = requireStorage(storage);
	const all = listNetworks(storage);
	const filtered = all.filter((e) => e.networkHash !== networkHash);
	s.setItem(NETWORKS_REGISTRY_KEY, JSON.stringify(filtered));
}
