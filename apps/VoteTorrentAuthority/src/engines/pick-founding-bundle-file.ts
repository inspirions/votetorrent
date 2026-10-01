/**
 * pick-founding-bundle-file.ts — the never-throwing D-36 picker seam.
 *
 * Purpose: `ImportFoundingBundleScreen.tsx` (D-35, D-36, D-37 — Authority only) needs a document
 * picker to let an officer choose the founding-bundle file a sibling device exported through the
 * OS share sheet. This module is the ONLY place `@react-native-documents/picker` is referenced —
 * every call into the native module is funneled through `pickFoundingBundleFile()`, which never
 * rejects: every failure mode (cancel, oversized file, a bad copy, an unreadable file) resolves a
 * typed `PickedFoundingBundleFile` instead.
 *
 * JEST SAFETY (mirrors `device-signer.ts`'s `getNative()` comment, same reasoning): the picker
 * package's module scope runs `TurboModuleRegistry.getEnforcing('RNDocumentPicker')`
 * (`src/spec/NativeDocumentPicker.ts`), which throws under Node/jest whenever the native module
 * is not registered. `App.test.tsx` and the navigation suites eagerly require every screen module
 * (`navigation/index.tsx`'s static imports), so if this file touched the picker package at MODULE
 * scope, every one of those suites would break the moment this file is imported transitively. The
 * fix is the same one `device-signer.ts` already uses: a lazy, in-function `require()` — never a
 * top-level `import` and never `import()` — so the native module factory only runs the first time
 * `pickFoundingBundleFile()` is actually called. Only an `import type` (erased at compile time) of
 * the picker's exported function/value SIGNATURES appears at module scope below.
 *
 * MAX_FOUNDING_BUNDLE_FILE_BYTES = 1048576 is 4 bytes per character of 62-16's
 * `MAX_FOUNDING_BUNDLE_CHARS` (262144) import ceiling. That engine constant is not importable
 * here — `packages/vote-engine/src/networks/founding-bundle.ts` is in no barrel — so this is a
 * conservative restatement at the file-size layer, checked BEFORE any copy or read (T-62-23-02).
 *
 * This file never logs a uri, file name or file content — only a closed failure-kind token
 * (T-62-23-04).
 */

import type {
	errorCodes as PickerErrorCodes,
	isErrorWithCode as PickerIsErrorWithCode,
	keepLocalCopy as PickerKeepLocalCopy,
	pick as PickerPick,
	types as PickerTypes,
} from '@react-native-documents/picker'

/** 4 bytes per character of 62-16's 262144-char `MAX_FOUNDING_BUNDLE_CHARS` ceiling. */
export const MAX_FOUNDING_BUNDLE_FILE_BYTES = 1048576

export type PickedFoundingBundleFile =
	| { readonly kind: 'picked'; readonly text: string }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'too-large' }
	| { readonly kind: 'unreadable'; readonly reason: 'picker-error' | 'copy-failed' | 'read-failed' }

/** The subset of the picker package's exports this seam actually uses, named for injection. */
export interface PickerModuleSubset {
	pick: typeof PickerPick
	keepLocalCopy: typeof PickerKeepLocalCopy
	types: typeof PickerTypes
	errorCodes: typeof PickerErrorCodes
	isErrorWithCode: typeof PickerIsErrorWithCode
}

export interface PickFoundingBundleFileDeps {
	picker?: PickerModuleSubset
	readText?: (uri: string) => Promise<string>
}

const DEFAULT_FOUNDING_BUNDLE_FILE_NAME = 'founding-bundle.json'

/**
 * Lazily resolve the native picker module via a plain CommonJS `require()` — NOT a top-level
 * `import`. See this file's module doc comment for why. Called only from inside
 * `pickFoundingBundleFile()`, never at module-evaluation time.
 */
function getPicker(): PickerModuleSubset {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, see module doc comment.
	return require('@react-native-documents/picker') as PickerModuleSubset
}

function defaultReadText(uri: string): Promise<string> {
	return fetch(uri).then((response) => response.text())
}

function logFailure(reason: string): void {
	// eslint-disable-next-line no-console -- closed token only, never a uri/name/content (T-62-23-04).
	console.info(`[founding-bundle] pick: ${reason}`)
}

/**
 * Picks a single file via the OS document picker, copies it into the caches directory
 * (`keepLocalCopy`), and reads its text from the LOCAL copy — never the picker's own
 * (possibly `content://`) uri, closing RESEARCH Pitfall 6's `fetch` flake. Never throws: every
 * failure resolves a typed result.
 */
export async function pickFoundingBundleFile(
	deps?: PickFoundingBundleFileDeps,
): Promise<PickedFoundingBundleFile> {
	const picker = deps?.picker ?? getPicker()
	const readText = deps?.readText ?? defaultReadText

	let pickedUri: string
	let pickedName: string | null
	let pickedSize: number | null
	try {
		const results = await picker.pick({
			mode: 'import',
			type: [picker.types.allFiles],
			allowMultiSelection: false,
		})
		const first = results[0]
		if (!first) {
			logFailure('picker-error')
			return { kind: 'unreadable', reason: 'picker-error' }
		}
		pickedUri = first.uri
		pickedName = first.name
		pickedSize = first.size
	} catch (error) {
		if (picker.isErrorWithCode(error) && error.code === picker.errorCodes.OPERATION_CANCELED) {
			return { kind: 'cancelled' }
		}
		logFailure('picker-error')
		return { kind: 'unreadable', reason: 'picker-error' }
	}

	if (pickedSize !== null && pickedSize > MAX_FOUNDING_BUNDLE_FILE_BYTES) {
		logFailure('too-large')
		return { kind: 'too-large' }
	}

	const fileName = pickedName ?? DEFAULT_FOUNDING_BUNDLE_FILE_NAME
	let localUri: string
	try {
		const copyResults = await picker.keepLocalCopy({
			files: [{ uri: pickedUri, fileName }],
			destination: 'cachesDirectory',
		})
		const copyResult = copyResults[0]
		if (!copyResult || copyResult.status !== 'success') {
			logFailure('copy-failed')
			return { kind: 'unreadable', reason: 'copy-failed' }
		}
		localUri = copyResult.localUri
	} catch {
		logFailure('copy-failed')
		return { kind: 'unreadable', reason: 'copy-failed' }
	}

	try {
		const text = await readText(localUri)
		return { kind: 'picked', text }
	} catch {
		logFailure('read-failed')
		return { kind: 'unreadable', reason: 'read-failed' }
	}
}
