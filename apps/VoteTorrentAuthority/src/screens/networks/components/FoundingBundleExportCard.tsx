/**
 * FoundingBundleExportCard.tsx — Surface 2 export card (D-35, D-36, D-37 — Authority only).
 *
 * A founding officer on the network's founding device shares the network's signed founding
 * bundle through the OS share sheet (`Share.share`), so a second Authority device can import it
 * (`ImportFoundingBundleScreen.tsx`) and become the same network. The export digest is signed by
 * the device's own hardware-backed key (`createDeviceSigner` — D-01: the private key NEVER
 * enters JS, signing happens inside the Android Keystore behind the biometric prompt). This file
 * never parses, edits or writes bundle rows — `INetworksEngine.exportFoundingBundle` (62-16)
 * does all of that; this card only collects the signer and the text the engine returns.
 */

import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Share, View } from "react-native";
import { ThemedText } from "../../../components/ThemedText";
import { CustomButton } from "../../../components/CustomButton";
import { LifecycleConfirmCard } from "../../registration/components/LifecycleConfirmCard";
import { useApp } from "../../../providers/AppProvider";
import { createDeviceSigner } from "../../../engines/device-signer";
import { getDeviceUser } from "../../../engines/device-user";
import { useDeviceSigningErrorHandler } from "../../../hooks/useDeviceSigningErrorHandler";
import type { FoundingExportState } from "../foundingBundleState";
import type { NetworkReference } from "@votetorrent/vote-core";

export interface FoundingBundleExportCardProps {
	networkRef: NetworkReference;
	onClose: () => void;
}

// Mirrors AddNetworkScreen.tsx's CREATE_TIMEOUT_MS: `open()` can stall indefinitely on a
// non-active network's first-sync wait. There is NO timeout around the subsequent
// `exportFoundingBundle` call — that call is where the biometric prompt fires, and a device
// waiting on a human should never be raced against a clock.
const EXPORT_OPEN_TIMEOUT_MS = 45000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("founding-bundle: open() timed out"));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function logExportFailure(err: unknown): void {
	const code = (err as { code?: unknown } | null | undefined)?.code;
	const token = typeof code === "string" ? code : "failed";
	// eslint-disable-next-line no-console -- closed token only, never a hash/key/file name/text (T-62-23-04).
	console.info(`[founding-bundle] export: ${token}`);
}

export function FoundingBundleExportCard({ networkRef, onClose }: FoundingBundleExportCardProps) {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { networksEngine } = useApp();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	const [state, setState] = useState<FoundingExportState>("confirming");
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
	const mountedRef = useRef(true);
	const inFlightRef = useRef(false);

	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[],
	);

	const runExport = useCallback(async () => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		if (mountedRef.current) {
			setErrorMessage(undefined);
			setState("generating");
		}
		try {
			const sign = await createDeviceSigner("Device User");
			const user = await getDeviceUser();
			if (!user) {
				const err = new Error("founding-bundle export: no device signing key provisioned") as Error & {
					code: string;
				};
				err.code = "NO_KEY_PROVISIONED";
				throw err;
			}
			const signerKey = user.activeKeys[0]?.key;
			if (!signerKey) {
				const err = new Error("founding-bundle export: device user has no active key") as Error & {
					code: string;
				};
				err.code = "NO_KEY_PROVISIONED";
				throw err;
			}
			if (!networksEngine) {
				throw new Error("founding-bundle export: no networks engine");
			}

			// storeAsRecent=false: export never reorders recent networks. A cache-first open is a
			// no-op for the already-active network; the timeout guards a first-sync wait on a
			// non-active one.
			await withTimeout(networksEngine.open(networkRef, user, false), EXPORT_OPEN_TIMEOUT_MS);

			const exported = await networksEngine.exportFoundingBundle(networkRef.hash, {
				userId: user.id,
				signerKey,
				sign,
			});

			if (mountedRef.current) setState("sharing");
			await Share.share(
				{ message: exported.text, title: exported.fileName },
				{ subject: exported.fileName, dialogTitle: t("networkFoundingExportShareButton") },
			);
			onClose();
		} catch (err) {
			const outcome = handleDeviceSigningError(err);
			if (outcome.handled) {
				onClose();
				return;
			}
			logExportFailure(err);
			if (mountedRef.current) {
				setErrorMessage(outcome.message);
				setState("error");
			}
		} finally {
			inFlightRef.current = false;
		}
	}, [networkRef, networksEngine, onClose, handleDeviceSigningError, t]);

	switch (state) {
		case "generating":
			return (
				<View testID="founding-export-body-generating">
					<ThemedText type="default" style={{ color: colors.textSecondary }}>
						{t("networkFoundingExportGenerating")}
					</ThemedText>
				</View>
			);
		case "sharing":
			return (
				<View testID="founding-export-body-sharing">
					<ThemedText type="default" style={{ color: colors.textSecondary }}>
						{t("networkFoundingExportGenerating")}
					</ThemedText>
				</View>
			);
		case "error":
			return (
				<View testID="founding-export-body-error">
					<ThemedText type="default" style={{ color: colors.error }}>
						{t("networkFoundingExportError")}
					</ThemedText>
					{errorMessage !== undefined && (
						<ThemedText type="small" style={{ color: colors.error }}>
							{errorMessage}
						</ThemedText>
					)}
					<CustomButton title={t("networkFoundingExportShareButton")} onPress={runExport} />
					<CustomButton title={t("networkFoundingExportCancelButton")} onPress={onClose} />
				</View>
			);
		case "confirming":
		default:
			return (
				<LifecycleConfirmCard
					variant="ordinary"
					tone="neutral"
					testIDPrefix="founding-export"
					title={t("networkFoundingExportConfirmHeading")}
					body={t("networkFoundingExportConfirmBody")}
					confirmLabel={t("networkFoundingExportShareButton")}
					dismissLabel={t("networkFoundingExportCancelButton")}
					onConfirm={runExport}
					onDismiss={onClose}
				/>
			);
	}
}
