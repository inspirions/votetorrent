import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * Height, in dp, that the on-screen keyboard currently occupies at the bottom
 * of the window — 0 when it is dismissed.
 *
 * Why this exists rather than relying on `android:windowSoftInputMode`:
 * the manifest asks for `adjustResize`, but from Android 15 (API 35) onwards
 * an app that targets SDK 35 is forced edge-to-edge, and in edge-to-edge the
 * platform stops resizing the window for the IME — `adjustResize` becomes a
 * no-op. The window therefore stays full height, the ScrollView's viewport
 * (and so its maximum scroll offset) never shrinks, and every field plus the
 * pinned Footer that falls in the bottom third of the screen becomes
 * unreachable while typing. Reproduced on a Pixel 8 emulator (API 37) against
 * Add Network: six full-length swipes could not bring `Title`, `SIGN`,
 * `Advanced` or `CREATE` above the keyboard, because the list was already at
 * max offset.
 *
 * `Keyboard`'s events still report the real IME inset in edge-to-edge, so the
 * app applies the inset itself — see [[KeyboardAvoidingScreen]].
 */
export function useKeyboardInset(): number {
	const [inset, setInset] = useState(0);

	useEffect(() => {
		// iOS gets the `Will` pair so the padding animates in step with the
		// keyboard; Android only ever emits the `Did` pair.
		const showEvent = Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
		const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

		const showSub = Keyboard.addListener(showEvent as "keyboardDidShow", event => {
			setInset(event?.endCoordinates?.height ?? 0);
		});
		const hideSub = Keyboard.addListener(hideEvent as "keyboardDidHide", () => {
			setInset(0);
		});

		return () => {
			showSub.remove();
			hideSub.remove();
		};
	}, []);

	return inset;
}
