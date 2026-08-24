/**
 * Height, in dp, that the on-screen keyboard currently occupies at the bottom of the window —
 * 0 when it is dismissed.
 *
 * Why this exists rather than relying on `android:windowSoftInputMode`: the manifest asks for
 * `adjustResize`, but this app targets SDK 35, and from Android 15 (API 35) onwards an app that
 * targets SDK 35 is forced edge-to-edge — and in edge-to-edge the platform stops resizing the
 * window for the IME, so `adjustResize` is a silent no-op on any API 35+ device.
 *
 * The window therefore stays full height while typing: the ScrollView's viewport (and so its
 * MAXIMUM SCROLL OFFSET) never shrinks by the keyboard's height, and anything in the bottom
 * third of the screen becomes unreachable at any scroll position. On the register form that is
 * the lower fields plus the pinned Continue CTA, which is a hard dead end — the step cannot be
 * completed without dismissing the keyboard first.
 *
 * `Keyboard`'s events still report the real IME inset under edge-to-edge, so the app applies
 * the inset itself. Consumers pad their own bottom by it; see RegisterPersonalScreen and
 * RegisterAddressPartyScreen.
 *
 * Note the reported height stops at the TOP OF THE NAVIGATION BAR, not the bottom of the screen,
 * so it does NOT subsume `useSafeAreaInsets().bottom` — ADD the two, never `Math.max` them, or
 * the padding falls short by the navigation bar's height and still clips the footer.
 * Measured on a Pixel 8 emulator (API 37, 1080x2400 @ density 420) against the register form:
 * the IME's real top edge sat at y=1517 (883px of occlusion), while this hook reported 819px —
 * short by exactly the 63px gesture-navigation inset, which left the Continue CTA's bottom 64px
 * behind the keyboard until the safe-area inset was added back.
 *
 * RN's own KeyboardAvoidingView is deliberately not used: its `_relativeKeyboardHeight` compares
 * a parent-relative onLayout frame against a screen-absolute keyboard Y, so it mis-pads whenever
 * the measured view does not start at the top of the screen.
 */
import {useEffect, useState} from 'react';
import {Keyboard, Platform} from 'react-native';

export function useKeyboardInset(): number {
	const [inset, setInset] = useState(0);

	useEffect(() => {
		// iOS gets the `Will` pair so the padding animates in step with the keyboard;
		// Android only ever emits the `Did` pair.
		const showEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
		const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

		const showSub = Keyboard.addListener(showEvent as 'keyboardDidShow', event => {
			setInset(event?.endCoordinates?.height ?? 0);
		});
		const hideSub = Keyboard.addListener(hideEvent as 'keyboardDidHide', () => {
			setInset(0);
		});

		return () => {
			showSub.remove();
			hideSub.remove();
		};
	}, []);

	return inset;
}
