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

import { ExtendedTheme, useFocusEffect, useTheme, useNavigation } from '@react-navigation/native'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ThemedText } from '../../components/ThemedText'
import { CustomButton } from '../../components/CustomButton'
import { useApp } from '../../providers/AppProvider'
import { getDeviceUser } from '../../engines/device-user'
import { pickFoundingBundleFile } from '../../engines/pick-founding-bundle-file'
import { mapFoundingImportResult, type FoundingImportState } from './foundingBundleState'
import type { NavigationProp } from '../../navigation/types'
import { globalStyles } from '../../theme/styles'
import { useDeviceSigningErrorHandler } from '../../hooks/useDeviceSigningErrorHandler'
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
	// The post-import selectNetwork failed (routed or not): the success body then offers View
	// Network so the officer is never stranded on "Network joined".
	const [selectFailed, setSelectFailed] = useState(false)
	const handleDeviceSigningError = useDeviceSigningErrorHandler()
	// Latest-value refs: the select effect below must run ONCE per success state. Re-running it on
	// a navigation/handler identity change would retry selectNetwork behind the officer's back.
	const navigationRef = useRef(navigation)
	navigationRef.current = navigation
	const handleDeviceSigningErrorRef = useRef(handleDeviceSigningError)
	handleDeviceSigningErrorRef.current = handleDeviceSigningError
	const selectNetworkRef = useRef(selectNetwork)
	selectNetworkRef.current = selectNetwork
	const mountedRef = useRef(true)
	const inFlightRef = useRef(false)
	// UAT 62 P2b: set when a select failure was ROUTED (e.g. NO_KEY_PROVISIONED -> the provisioning
	// ceremony). That ceremony's CONTINUE pops back here, so the next focus retries the select once.
	const retryOnFocusRef = useRef<NetworkReference | null>(null)

	useEffect(
		() => () => {
			mountedRef.current = false
		},
		[],
	)

	const handleChooseFile = useCallback(async () => {
		if (inFlightRef.current) return
		inFlightRef.current = true
		setSelectFailed(false)
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

	// Success auto-navigates: await selectNetwork(networkRef), then go Home. On a rejection the
	// network is already in recentNetworks regardless: a device with no signing key
	// (NO_KEY_PROVISIONED) goes to the provisioning ceremony and the select is retried on return;
	// every failure keeps the success body and adds a View Network button (it used to be a dead
	// end with no control at all).
	useEffect(() => {
		if (screenState.kind !== 'success' || !screenState.networkRef) return
		let cancelled = false
		const networkRef = screenState.networkRef
		;(async () => {
			try {
				await selectNetwork(networkRef)
				if (!cancelled) navigationRef.current.navigate('Home')
			} catch (err) {
				const code = (err as { code?: unknown } | null | undefined)?.code
				// eslint-disable-next-line no-console -- closed token only.
				console.info(`[founding-bundle] select failed: ${typeof code === 'string' ? code : 'uncoded'}`)
				if (cancelled || !mountedRef.current) return
				if (handleDeviceSigningErrorRef.current(err).handled) {
					retryOnFocusRef.current = networkRef
				}
				// Routed or not, the success body keeps View Network: if the officer comes back
				// without the retry landing Home, "Network joined" must never be a dead end.
				setSelectFailed(true)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [screenState, selectNetwork])

	// UAT 62 P2b: back from the routed ceremony (its CONTINUE pops to this screen), retry the select
	// ONCE and go Home on success. A failure is not routed again (no ceremony loop); View Network,
	// already showing, stays the way on. Latest-value refs keep this a focus-only effect: an
	// identity change of selectNetwork mid-retry must not cancel the Home navigation.
	useFocusEffect(
		useCallback(() => {
			const networkRef = retryOnFocusRef.current
			if (!networkRef) return
			retryOnFocusRef.current = null
			;(async () => {
				try {
					await selectNetworkRef.current(networkRef)
					if (mountedRef.current) navigationRef.current.navigate('Home')
				} catch (err) {
					const code = (err as { code?: unknown } | null | undefined)?.code
					// eslint-disable-next-line no-console -- closed token only.
					console.info(`[founding-bundle] select retry failed: ${typeof code === 'string' ? code : 'uncoded'}`)
				}
			})()
		}, []),
	)

	function renderBody() {
		switch (screenState.kind) {
			case 'idle':
				return (
					<View testID="founding-import-body-idle" style={localStyles.body}>
						<CustomButton title={t('networkFoundingImportChooseFileButton')} onPress={handleChooseFile} />
					</View>
				)
			case 'picking':
				return <View testID="founding-import-body-picking" />
			case 'validating':
				return (
					<View testID="founding-import-body-validating" style={localStyles.body}>
						<ThemedText type="default" style={{ color: colors.textSecondary }}>
							{t('networkFoundingImportValidating')}
						</ThemedText>
					</View>
				)
			case 'invalidSignature':
				return (
					<View testID="founding-import-body-invalidSignature" style={localStyles.body}>
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
					<View testID="founding-import-body-genericError" style={localStyles.body}>
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
					<View testID="founding-import-body-alreadyJoined" style={localStyles.body}>
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
					<View testID="founding-import-body-success" style={localStyles.body}>
						<ThemedText type="default" style={{ color: colors.success }}>
							{t('networkFoundingImportSuccess')}
						</ThemedText>
						{selectFailed && screenState.networkRef ? (
							<CustomButton
								testID="founding-import-success-view-network"
								title={t('networkFoundingImportViewNetworkButton')}
								onPress={() => {
									if (screenState.networkRef) {
										navigation.navigate('NetworkDetails', { networkRef: screenState.networkRef })
									}
								}}
							/>
						) : null}
					</View>
				)
		}
	}

	return (
		// The screen's standard 16dp gutter (globalStyles.container, as every sibling network screen
		// uses). Without it the error copy ran from x = 0 to the right edge on a 360dp Redmi 8.
		<ScrollView style={globalStyles.container} contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
			{renderBody()}
		</ScrollView>
	)
}

const localStyles = StyleSheet.create({
	// Space between a state's message and its button (on top of CustomButton's own 8dp margin).
	body: {
		gap: 8,
	},
})
