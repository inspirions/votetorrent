/**
 * device-identity-repair.ts — O-06 (app half). Repairs a device whose stored identity id was
 * forked by the pre-62-66 Replace Signing Key (it minted a fresh id instead of keeping the
 * network User's id), losing officer standing.
 *
 * Safety contract:
 *  - adopt an id only when EXACTLY ONE current officer on the open network holds this device's
 *    own active key (only this device can sign with it);
 *  - never while a recovery is in progress, never for a stored user without an active key;
 *  - never when the forked id is a User on another recent network of this device, or when that
 *    cannot be verified (fail safe);
 *  - the pre-repair record is backed up byte-for-byte first and the backup is never overwritten;
 *  - `restoreDeviceIdentityForkBackup()` sets only `user.id` back and writes a pair-specific
 *    declined marker, so the next boot does not repair again.
 *
 * Logs: the closed outcome token only. Never an id, a key or an error message.
 */
import type { User } from '@votetorrent/vote-core'
import {
	getForkRepairApplied,
	getForkRepairBackup,
	getForkRepairDeclined,
	getRawDeviceUserRecord,
	isRecoveryInProgress,
	replaceDeviceUserId,
	setForkRepairApplied,
	setForkRepairDeclined,
	writeForkRepairBackupIfAbsent,
	DEVICE_USER_KEY,
} from './device-user'
import AsyncStorage from '@react-native-async-storage/async-storage'

export interface DeviceIdentityInspection {
	localIsNetworkUser: boolean
	officerUserIdsHoldingKey: string[]
}

/** Structural: `inspectDeviceIdentity` is NOT on the vote-core IUserEngine interface. */
export interface InspectableUserEngine {
	inspectDeviceIdentity?: (localUserId: string, pubKey: string) => Promise<DeviceIdentityInspection>
}

export type IdentityRepairOutcome =
	| 'not-forked'
	| 'repaired'
	| 'ambiguous'
	| 'no-match'
	| 'no-local-key'
	| 'declined'
	| 'skipped-legit-elsewhere'
	| 'skipped-unverified-other-network'
	| 'skipped-recovery'
	| 'unsupported'
	| 'failed'

export type OtherNetworkAnswer = 'yes' | 'no' | 'unknown'

export type DeviceIdentityPlan = 'not-forked' | 'ambiguous' | 'no-match' | `repair:${string}`

export function planDeviceIdentityRepair(inspection: DeviceIdentityInspection, localUserId: string): DeviceIdentityPlan {
	if (inspection.localIsNetworkUser) return 'not-forked'
	const candidates = inspection.officerUserIdsHoldingKey.filter((id) => id !== localUserId)
	if (candidates.length === 0) return 'no-match'
	if (candidates.length > 1) return 'ambiguous'
	return `repair:${candidates[0]}`
}

export interface RepairDeps {
	/** The stored device user as read at boot / select. */
	deviceUser: User
	/** A user engine bound to the OPEN network's context (the context user may be the forked one). */
	getUserEngineForCurrentUser: () => Promise<InspectableUserEngine | undefined>
	/** Is `userId` a User on another recent network of this device? `unknown` fails safe. */
	otherNetworkHasUser: (userId: string) => Promise<OtherNetworkAnswer>
}

export interface RepairResult {
	outcome: IdentityRepairOutcome
	/** Present only for `repaired`. */
	user?: User
}

function done(outcome: IdentityRepairOutcome, user?: User): RepairResult {
	console.info(`[identity-repair] outcome=${outcome}`)
	return user ? { outcome, user } : { outcome }
}

/** Never throws. */
export async function repairDeviceIdentityForkIfNeeded(deps: RepairDeps): Promise<RepairResult> {
	try {
		if (await isRecoveryInProgress()) return done('skipped-recovery')
		const localId = deps.deviceUser.id
		const pubKey = deps.deviceUser.activeKeys?.[0]?.key
		if (typeof pubKey !== 'string' || pubKey.length === 0) return done('no-local-key')

		const engine = await deps.getUserEngineForCurrentUser()
		if (!engine || typeof engine.inspectDeviceIdentity !== 'function') return done('unsupported')

		const plan = planDeviceIdentityRepair(await engine.inspectDeviceIdentity(localId, pubKey), localId)
		if (plan === 'not-forked') return done('not-forked')
		if (plan === 'ambiguous') return done('ambiguous')
		if (plan === 'no-match') return done('no-match')
		const toUserId = plan.slice('repair:'.length)

		const declined = await getForkRepairDeclined()
		if (declined && declined.fromUserId === localId && declined.toUserId === toUserId) return done('declined')

		const other = await deps.otherNetworkHasUser(localId)
		if (other === 'yes') return done('skipped-legit-elsewhere')
		if (other === 'unknown') return done('skipped-unverified-other-network')

		const raw = await getRawDeviceUserRecord()
		if (raw === null) return done('failed')
		await writeForkRepairBackupIfAbsent(raw)
		await setForkRepairApplied({ fromUserId: localId, toUserId })
		const user = await replaceDeviceUserId(toUserId)
		return done('repaired', user)
	} catch (err) {
		console.warn(`[identity-repair] outcome=failed name=${err instanceof Error ? err.name : 'unknown'}`)
		return { outcome: 'failed' }
	}
}

/**
 * Undo a repair: sets only `user.id` back to the backed-up id and writes the declined marker.
 * Returns `false` when there is no backup, `'restore-refused-id-changed'` (nothing written) when
 * the stored id is no longer the one the repair wrote, `true` on success. The backup is kept.
 */
export async function restoreDeviceIdentityForkBackup(): Promise<boolean | 'restore-refused-id-changed'> {
	const backup = await getForkRepairBackup()
	if (backup === null) return false
	const backedUpId = (JSON.parse(backup) as { user?: { id?: unknown } }).user?.id
	if (typeof backedUpId !== 'string') return false
	const applied = await getForkRepairApplied()
	const currentRaw = await AsyncStorage.getItem(DEVICE_USER_KEY)
	const currentId = currentRaw === null ? undefined : (JSON.parse(currentRaw) as { user?: { id?: unknown } }).user?.id
	if (!applied || currentId !== applied.toUserId) return 'restore-refused-id-changed'
	await replaceDeviceUserId(backedUpId)
	await setForkRepairDeclined({ fromUserId: backedUpId, toUserId: applied.toUserId })
	return true
}
