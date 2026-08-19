import { useCallback } from "react";
import { useNavigation } from "@react-navigation/native";
import type { INetworkEngine } from "@votetorrent/vote-core";
import { useApp } from "../providers/AppProvider";
import { shouldPromptRecoveryKeyRegistration } from "../engines/recovery-key-registration";
import type { NavigationProp } from "../navigation/types";

/**
 * Routes an officer into the recovery-key registration ceremony once — and only once —
 * a network exists for it to register against.
 *
 * WHY THIS EXISTS (49-19, recovery-key-registration gap)
 * `networks-engine.create()` registers ONLY the founding signing key: its bootstrap
 * branch writes `user.activeKeys[0]` and has no analog for a second key. The recovery
 * key is registered exclusively by `ProvisionSigningKeyScreen`'s stage 2, which requires
 * a resolvable network `User` and therefore CANNOT run until after create/join. Nothing
 * previously brought the officer back to it, so a device that provisioned, created or
 * joined a network, and never revisited Settings carried an unregistered recovery key
 * indefinitely — one biometric enrolment away from being permanently stranded, because
 * `addKey` needs a valid signing key and only the recovery key can replace an
 * invalidated one. The single recorded escape was a destructive `pm clear`, which also
 * drops the app's Keystore entries. Measured unregistered on BOTH fleet devices
 * (49-14 proof log §G.3).
 *
 * WHY A HOOK, NOT A `navigation.navigate` IN EACH SCREEN
 * `deviceSigningRollout.coverage.test.ts` pins a deliberate architectural contract: the
 * `ProvisionSigningKey` navigation target is referenced from the shared hooks and the
 * Settings entry point only, never duplicated per screen. Scattering the target across
 * call sites is exactly how the original rollout drifted. This hook keeps the new
 * create/join trigger inside that contract — the screens ask a question, the hook owns
 * the navigation.
 *
 * The ceremony it routes to is idempotent and reconciling (it registers only the keys
 * the network `User` is missing), so an unnecessary trip is harmless — but the gate
 * still checks first so officers with nothing to do are not shown a ceremony screen.
 */
export function useRecoveryKeyRegistrationGate(): () => Promise<boolean> {
	const navigation = useNavigation<NavigationProp>();
	const { getEngine } = useApp();

	return useCallback(async () => {
		const needed = await shouldPromptRecoveryKeyRegistration(async () => {
			const engine = await getEngine<INetworkEngine>("network");
			const userEngine = await engine.getCurrentUser();
			return userEngine ? await userEngine.getSummary() : undefined;
		});
		if (needed) {
			navigation.navigate("ProvisionSigningKey", { reason: "first-run" });
		}
		return needed;
	}, [getEngine, navigation]);
}
