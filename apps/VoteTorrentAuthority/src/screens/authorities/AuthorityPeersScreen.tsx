import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useRoute, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { InfoCard } from "../../components/InfoCard";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import { scopeDescriptions } from "@votetorrent/vote-core";
import type { AuthorityPeer, IAuthorityConfigEngine } from "@votetorrent/vote-core";

/**
 * AuthorityPeersScreen — the `'cap'`-scoped `AuthorityPeer` CRUD surface
 * (47-18, D-08 authorities tree, D-13 default visible-but-disabled gating
 * pattern).
 *
 * `AuthorityConfigEngine` deliberately splits its ceremonies by scope:
 * `'cap'` (Configure Authority Peers) for `AuthorityPeer`, `'vrg'` (Validate
 * Registrations) for the whitelisted-device model the sibling authorities-
 * tree screen manages (47-17). This screen's gate is `'cap'` ONLY. As with
 * every other Phase 46/47
 * scope gate, this is a UI legibility affordance, NOT the enforcement
 * boundary — the real and only control is `AuthorityPeer`'s
 * `InsertValid`/`DeleteValid` CHECKs (`votetorrent.qsql:1586-1606`), which
 * require an `AdminSignature` joined through `AdminSigning` with
 * `A.Scope = 'cap'` and a matching `Digest`. A caller that bypasses this
 * screen entirely still cannot write, because `AuthorityConfigEngine`'s
 * `addAuthorityPeer`/`removeAuthorityPeer` pass `'cap'` to
 * `seedSignedMutation` unconditionally (T-46-03 precedent, T-47-04).
 *
 * `AuthorityPeers` is NOT yet a key of `RootStackParamList` — 47-21 owns
 * adding `{ authorityId: string }` and registering the `Stack.Screen`. This
 * screen reads `useRoute().params` via a local cast (matching
 * `RegistrationPolicyScreen.tsx`'s pattern) rather than
 * `RouteProp<RootStackParamList, "AuthorityPeers">`, which would not
 * typecheck until 47-21 lands. This screen has no detail screen and
 * navigates nowhere, so no navigation-prop hook or type is imported.
 */

/**
 * Truncates a `peerId` for display in a row title. Exact convention carried
 * from `HistoryEvent.tsx`'s signer-key truncation (47-PATTERNS §15) — do not
 * invent a middle-ellipsis variant.
 */
export function truncatePeerId(peerId: string): string {
	return peerId.length > 8 ? peerId.slice(0, 5) + "..." : peerId;
}

/**
 * Exact-match duplicate check (trim only, no case-folding). A libp2p PeerId
 * is case-sensitive base58/base36 — lower-casing either side would let two
 * distinct peers collide into one "duplicate".
 */
export function isDuplicatePeerId(peers: AuthorityPeer[], candidate: string): boolean {
	const trimmed = candidate.trim();
	return peers.some((p) => p.peerId === trimmed);
}

export default function AuthorityPeersScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const { getEngine } = useApp();
	// TODO(47-21): swap to `useRoute<RouteProp<RootStackParamList, "AuthorityPeers">>()`
	// once the "AuthorityPeers" route key exists on RootStackParamList.
	const { authorityId } = useRoute().params as { authorityId: string };

	const [peers, setPeers] = useState<AuthorityPeer[]>([]);
	const [loading, setLoading] = useState(true);
	const [errorMessage, setErrorMessage] = useState("");

	const { scopes, loading: scopesLoading } = useCurrentOfficerScopes(authorityId);
	const canWrite = !scopesLoading && scopes?.includes("cap") === true;

	// CR-02-style guard against a stale setState: loadPeers is invoked both
	// from the mount effect below AND (Task 2) from both write handlers, so a
	// single effect-scoped `cancelled` closure would only cover the mount
	// call. A ref shared across every caller generalizes the same
	// never-setState-after-unmount guarantee (RegistrationPolicyScreen.tsx
	// precedent).
	const unmountedRef = useRef(false);
	useEffect(() => {
		// WR-08: reset on entry so a cleanup that runs while the component
		// stays mounted (StrictMode double-invoke, Fast Refresh, remount-in-
		// place) does not permanently latch every setState in loadPeers off.
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const loadPeers = useCallback(async () => {
		try {
			const authorityConfigEngine = await getEngine<IAuthorityConfigEngine>("authorityConfig");
			const fetched = await authorityConfigEngine.getAuthorityPeers(authorityId);
			if (!unmountedRef.current) {
				setPeers(fetched);
				setErrorMessage("");
			}
		} catch (err) {
			if (!unmountedRef.current) setErrorMessage(err instanceof Error ? err.message : String(err));
		} finally {
			if (!unmountedRef.current) setLoading(false);
		}
	}, [getEngine, authorityId]);

	// Plain effect, deliberately NOT useFocusEffect: nothing else in the app
	// mutates AuthorityPeer rows during a session, and this screen re-reads
	// via loadPeers() at the end of every write it fires itself.
	useEffect(() => {
		loadPeers();
	}, [loadPeers]);

	return (
		<ScrollView
			testID="authority-peers-screen"
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
		>
			<View style={styles.section}>
				<InlineError message={errorMessage} />
			</View>

			{/* D-13 scope-gate banner — persistent, non-collapsible, rendered
			    only once the hook has resolved. The two branches are
			    DELIBERATELY not collapsed: scopes === undefined (no matching
			    Officer row) vs. a real scopes array missing 'cap' are two
			    distinct facts and bind to two distinct copies. This gate is a
			    UI affordance for legibility, NOT a security boundary. */}
			{!scopesLoading && !canWrite && (
				scopes === undefined ? (
					<View testID="authority-peers-readonly-no-officer-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantScopeReadOnlyNoOfficerBanner")}
						</ThemedText>
					</View>
				) : (
					<View testID="authority-peers-readonly-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("authorityPeerScopeReadOnlyBanner", { scope: scopeDescriptions.cap })}
						</ThemedText>
					</View>
				)
			)}

			<View
				testID="authority-peers-add-toggle"
				pointerEvents={canWrite ? "auto" : "none"}
				style={canWrite ? undefined : localStyles.disabledControl}
			>
				<ChipButton
					label={t("authorityPeerAddButton")}
					icon="circle-plus"
					// TODO(47-18 Task 2): wire the toggle handler.
					onPress={undefined}
				/>
			</View>

			{loading && (
				<ThemedText type="small" testID="authority-peers-loading" style={{ color: colors.textSecondary }}>
					{t("loading")}
				</ThemedText>
			)}

			{!loading && peers.length === 0 && (
				<View testID="authority-peers-empty" style={styles.section}>
					<ThemedText type="defaultSemiBold">{t("authorityPeerEmptyHeading")}</ThemedText>
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("authorityPeerEmptyBody")}
					</ThemedText>
				</View>
			)}

			{!loading &&
				peers.length > 0 &&
				peers.map((peer) => (
					<View key={peer.peerId} testID={"authority-peers-row-" + peer.peerId} style={localStyles.row}>
						{/* InfoCard renders no children and exposes no trailing slot
						    (InfoCard.tsx:9-17), so the Remove chip is a sibling in a
						    flex row, not nested inside the card. Do not modify
						    InfoCard. */}
						<View style={localStyles.rowCard}>
							<InfoCard
								title={truncatePeerId(peer.peerId)}
								additionalInfo={[{ label: t("authorityPeerIdLabel"), value: peer.peerId }]}
							/>
						</View>
						<View
							testID={"authority-peers-remove-" + peer.peerId}
							pointerEvents={canWrite ? "auto" : "none"}
							style={canWrite ? undefined : localStyles.disabledControl}
						>
							{/* TODO(47-18 Task 2): wire the remove handler. */}
							<ChipButton label={t("authorityPeerRemoveButton")} onPress={undefined} />
						</View>
					</View>
				))}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	banner: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 12,
	},
	disabledControl: {
		opacity: 0.5,
	},
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	rowCard: {
		flex: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };
