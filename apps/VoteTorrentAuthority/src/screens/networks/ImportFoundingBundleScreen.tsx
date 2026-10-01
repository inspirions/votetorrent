/**
 * ImportFoundingBundleScreen.tsx — Surface 2 import screen (D-35, D-36, D-37 — Authority only).
 *
 * An officer on a second Authority device picks the founding-bundle file the founding device
 * exported (`FoundingBundleExportCard.tsx`) through the OS document picker
 * (`pickFoundingBundleFile`), and this screen hands the file's raw text, UNCHANGED, to
 * `INetworksEngine.importFoundingBundle` (62-16). This app never parses, edits or writes bundle
 * rows itself — every verify/replay/write step happens inside the engine (T-62-23-01).
 *
 * UI-SPEC rule: every one of the seven states below renders its own, distinct body (testID
 * `founding-import-body-<state>`) — never two states sharing one body, and never a body that also
 * satisfies a different state's rendering.
 *
 * The screen's heading is the navigator title (`networkFoundingImportScreenTitle`, bound by
 * `navigation/index.tsx`'s `ImportFoundingBundle` route registration) — nothing renders above the
 * body here, so this screen's own JSX never repeats that key.
 */

import { ExtendedTheme, useTheme, useNavigation } from '@react-navigation/native'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ThemedText } from '../../components/ThemedText'
import { CustomButton } from '../../components/CustomButton'
import { useApp } from '../../providers/AppProvider'
import { getDeviceUser } from '../../engines/device-user'
import { pickFoundingBundleFile } from '../../engines/pick-founding-bundle-file'
import { mapFoundingImportResult, type FoundingImportState } from './foundingBundleState'
import type { NavigationProp } from '../../navigation/types'
import type { NetworkReference } from '@votetorrent/vote-core'

interface ScreenState {
	kind: FoundingImportState
	networkRef?: NetworkReference
}

function logImport(token: string): void {
	// eslint-disable-next-line no-console -- closed token only, never bundle text/hash/detail (T-62-23-04).
	console.info(`[founding-bundle] import: ${token}`)
}

export default function ImportFoundingBundleScreen() {
	const { colors } = useTheme() as ExtendedTheme
	const { t } = useTranslation()
	const navigation = useNavigation<NavigationProp>()
	const { networksEngine, selectNetwork } = useApp()
	const insets = useSafeAreaInsets()

	const [screenState, setScreenState] = useState<ScreenState>({ kind: 'idle' })
	const mountedRef = useRef(true)
	const inFlightRef = useRef(false)

	useEffect(
		() => () => {
			mountedRef.current = false
		},
		[],
	)

	const handleChooseFile = useCallback(async () => {
		if (inFlightRef.current) return
		inFlightRef.current = true
		if (mountedRef.current) setScreenState({ kind: 'picking' })
		try {
			const picked = await pickFoundingBundleFile()

			if (picked.kind === 'cancelled') {
				if (mountedRef.current) setScreenState({ kind: 'idle' })
				return
			}
			if (picked.kind === 'too-large') {
				// The engine also refuses an over-length text under invalid-bundle — same body.
				logImport('too-large')
				if (mountedRef.current) setScreenState({ kind: 'invalidSignature' })
				return
			}
			if (picked.kind === 'unreadable') {
				logImport(picked.reason)
				if (mountedRef.current) setScreenState({ kind: 'genericError' })
				return
			}

			if (mountedRef.current) setScreenState({ kind: 'validating' })

			if (!networksEngine) {
				logImport('no-engine')
				if (mountedRef.current) setScreenState({ kind: 'genericError' })
				return
			}

			try {
				const deviceUser = await getDeviceUser()
				const result = await networksEngine.importFoundingBundle(picked.text, deviceUser)
				logImport(result.ok ? result.outcome : result.reason)
				const outcome = mapFoundingImportResult(result)
				if (!mountedRef.current) return
				switch (outcome.state) {
					case 'success':
						setScreenState({ kind: 'success', networkRef: outcome.networkRef })
						break
					case 'alreadyJoined':
						setScreenState({ kind: 'alreadyJoined', networkRef: outcome.networkRef })
						break
					case 'invalidSignature':
						setScreenState({ kind: 'invalidSignature' })
						break
					case 'genericError':
						setScreenState({ kind: 'genericError' })
						break
				}
			} catch {
				logImport('throw')
				if (mountedRef.current) setScreenState({ kind: 'genericError' })
			}
		} finally {
			inFlightRef.current = false
		}
	}, [networksEngine])

	// Success auto-navigates: await selectNetwork(networkRef), then go Home. A rejection logs and
	// leaves the success body on screen — the network is already in recentNetworks regardless.
	useEffect(() => {
		if (screenState.kind !== 'success' || !screenState.networkRef) return
		let cancelled = false
		const networkRef = screenState.networkRef
		;(async () => {
			try {
				await selectNetwork(networkRef)
				if (!cancelled) navigation.navigate('Home')
			} catch {
				// eslint-disable-next-line no-console -- closed token only.
				console.info('[founding-bundle] select failed')
			}
		})()
		return () => {
			cancelled = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the state/ref identity changes.
	}, [screenState, selectNetwork, navigation])

	function renderBody() {
		switch (screenState.kind) {
			case 'idle':
				return (
					<View testID="founding-import-body-idle">
						<CustomButton title={t('networkFoundingImportChooseFileButton')} onPress={handleChooseFile} />
					</View>
				)
			case 'picking':
				return <View testID="founding-import-body-picking" />
			case 'validating':
				return (
					<View testID="founding-import-body-validating">
						<ThemedText type="default" style={{ color: colors.textSecondary }}>
							{t('networkFoundingImportValidating')}
						</ThemedText>
					</View>
				)
			case 'invalidSignature':
				return (
					<View testID="founding-import-body-invalidSignature">
						<ThemedText type="default" style={{ color: colors.error }}>
							{t('networkFoundingImportInvalidSignature')}
						</ThemedText>
						<CustomButton
							title={t('networkFoundingImportChooseAnotherFileButton')}
							onPress={handleChooseFile}
						/>
					</View>
				)
			case 'genericError':
				return (
					<View testID="founding-import-body-genericError">
						<ThemedText type="default" style={{ color: colors.error }}>
							{t('networkFoundingImportGenericError')}
						</ThemedText>
						<CustomButton
							title={t('networkFoundingImportChooseAnotherFileButton')}
							onPress={handleChooseFile}
						/>
					</View>
				)
			case 'alreadyJoined':
				return (
					<View testID="founding-import-body-alreadyJoined">
						<ThemedText type="default" style={{ color: colors.textSecondary }}>
							{t('networkFoundingImportAlreadyJoined')}
						</ThemedText>
						<CustomButton
							title={t('networkFoundingImportViewNetworkButton')}
							onPress={() => {
								if (screenState.networkRef) {
									navigation.navigate('NetworkDetails', { networkRef: screenState.networkRef })
								}
							}}
						/>
					</View>
				)
			case 'success':
				return (
					<View testID="founding-import-body-success">
						<ThemedText type="default" style={{ color: colors.success }}>
							{t('networkFoundingImportSuccess')}
						</ThemedText>
					</View>
				)
		}
	}

	return (
		<ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>{renderBody()}</ScrollView>
	)
}
