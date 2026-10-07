/**
 * pick-founding-bundle-file.test.ts — P-1..P-5 (D-36).
 *
 * Every case injects a fake `PickerModuleSubset` via `deps.picker` (never a real
 * `@react-native-documents/picker` require) EXCEPT P-5, which proves the seam's lazy-require
 * discipline using a real `jest.mock` factory + `jest.isolateModules`.
 */

const OK_PICK_RESULT = [{ uri: 'content://picked-uri', name: 'bundle.json', size: 300, error: null }];

function makeFakePicker(overrides?: {
	pick?: jest.Mock;
	keepLocalCopy?: jest.Mock;
}) {
	return {
		pick: overrides?.pick ?? jest.fn(async () => OK_PICK_RESULT),
		keepLocalCopy:
			overrides?.keepLocalCopy ??
			jest.fn(async () => [{ status: 'success', sourceUri: 'content://picked-uri', localUri: 'file://local/bundle.json' }]),
		types: { allFiles: '*/*' },
		errorCodes: { OPERATION_CANCELED: 'OPERATION_CANCELED', IN_PROGRESS: 'ASYNC_OP_IN_PROGRESS', UNABLE_TO_OPEN_FILE_TYPE: 'UNABLE_TO_OPEN_FILE_TYPE' },
		isErrorWithCode: (err: unknown): err is { code: string } =>
			typeof err === 'object' && err !== null && 'code' in err,
	};
}

describe('pickFoundingBundleFile — D-36 never-throwing picker seam', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { pickFoundingBundleFile, MAX_FOUNDING_BUNDLE_FILE_BYTES } = require('../pick-founding-bundle-file');

	it('P-1: a picked file of size 300 with a successful local copy resolves { kind: "picked", text }, using the picked name for keepLocalCopy and reading the LOCAL uri', async () => {
		const picker = makeFakePicker();
		const readText = jest.fn(async (uri: string) => `text-of-${uri}`);

		const result = await pickFoundingBundleFile({ picker, readText });

		expect(result).toEqual({ kind: 'picked', text: 'text-of-file://local/bundle.json' });
		expect(picker.keepLocalCopy).toHaveBeenCalledWith({
			files: [{ uri: 'content://picked-uri', fileName: 'bundle.json' }],
			destination: 'cachesDirectory',
		});
		expect(readText).toHaveBeenCalledWith('file://local/bundle.json');
		expect(readText).not.toHaveBeenCalledWith('content://picked-uri');
	});

	it('P-1b: a null picked name falls back to founding-bundle.json for keepLocalCopy', async () => {
		const picker = makeFakePicker({
			pick: jest.fn(async () => [{ uri: 'content://picked-uri', name: null, size: 300, error: null }]),
		});
		const readText = jest.fn(async () => 'text');

		await pickFoundingBundleFile({ picker, readText });

		expect(picker.keepLocalCopy).toHaveBeenCalledWith({
			files: [{ uri: 'content://picked-uri', fileName: 'founding-bundle.json' }],
			destination: 'cachesDirectory',
		});
	});

	it('P-2: a cancel (error with code OPERATION_CANCELED) resolves { kind: "cancelled" }', async () => {
		const err = Object.assign(new Error('canceled'), { code: 'OPERATION_CANCELED' });
		const picker = makeFakePicker({ pick: jest.fn(async () => { throw err; }) });

		const result = await pickFoundingBundleFile({ picker });

		expect(result).toEqual({ kind: 'cancelled' });
	});

	it('P-2b: any other pick rejection resolves unreadable/picker-error', async () => {
		const err = Object.assign(new Error('boom'), { code: 'UNABLE_TO_OPEN_FILE_TYPE' });
		const picker = makeFakePicker({ pick: jest.fn(async () => { throw err; }) });

		const result = await pickFoundingBundleFile({ picker });

		expect(result).toEqual({ kind: 'unreadable', reason: 'picker-error' });
	});

	it('P-3: size greater than MAX resolves too-large, and neither keepLocalCopy nor the reader is called', async () => {
		const picker = makeFakePicker({
			pick: jest.fn(async () => [{ uri: 'content://x', name: 'big.json', size: MAX_FOUNDING_BUNDLE_FILE_BYTES + 1, error: null }]),
		});
		const readText = jest.fn(async () => 'should-not-be-called');

		const result = await pickFoundingBundleFile({ picker, readText });

		expect(result).toEqual({ kind: 'too-large' });
		expect(picker.keepLocalCopy).not.toHaveBeenCalled();
		expect(readText).not.toHaveBeenCalled();
	});

	it('P-3b: a null size is read (bypasses the too-large check, proceeds to copy+read)', async () => {
		const picker = makeFakePicker({
			pick: jest.fn(async () => [{ uri: 'content://x', name: 'unknown-size.json', size: null, error: null }]),
		});
		const readText = jest.fn(async () => 'text');

		const result = await pickFoundingBundleFile({ picker, readText });

		expect(result).toEqual({ kind: 'picked', text: 'text' });
	});

	it('P-4: a keepLocalCopy result with status "error" resolves unreadable/copy-failed', async () => {
		const picker = makeFakePicker({
			keepLocalCopy: jest.fn(async () => [{ status: 'error', sourceUri: 'content://picked-uri', copyError: 'disk full' }]),
		});

		const result = await pickFoundingBundleFile({ picker });

		expect(result).toEqual({ kind: 'unreadable', reason: 'copy-failed' });
	});

	it('P-4b: a keepLocalCopy rejection also resolves unreadable/copy-failed (never rejects)', async () => {
		const picker = makeFakePicker({
			keepLocalCopy: jest.fn(async () => { throw new Error('native crash'); }),
		});

		const result = await pickFoundingBundleFile({ picker });

		expect(result).toEqual({ kind: 'unreadable', reason: 'copy-failed' });
	});

	it('P-4c: a reader rejection resolves unreadable/read-failed (never rejects)', async () => {
		const picker = makeFakePicker();
		const readText = jest.fn(async () => { throw new Error('fetch failed'); });

		const result = await pickFoundingBundleFile({ picker, readText });

		expect(result).toEqual({ kind: 'unreadable', reason: 'read-failed' });
	});
});

describe('pickFoundingBundleFile — cap on text length and cache-copy cleanup (initial/WR-G4-04)', () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { pickFoundingBundleFile, MAX_FOUNDING_BUNDLE_FILE_BYTES } = require('../pick-founding-bundle-file');
	const NO_SIZE_PICK = [{ uri: 'content://picked-uri', name: 'bundle.json', size: null, error: null }];

	it('C-1: a provider that reports no size but whose text exceeds the cap resolves too-large and the copy is deleted', async () => {
		const picker = makeFakePicker({ pick: jest.fn(async () => NO_SIZE_PICK) });
		const readText = jest.fn(async () => 'x'.repeat(MAX_FOUNDING_BUNDLE_FILE_BYTES + 1));
		const deleteLocalCopy = jest.fn(async () => true);

		const result = await pickFoundingBundleFile({ picker, readText, deleteLocalCopy });

		expect(result).toEqual({ kind: 'too-large' });
		expect(deleteLocalCopy).toHaveBeenCalledWith('file://local/bundle.json');
	});

	it('C-2: text exactly at the cap is accepted', async () => {
		const picker = makeFakePicker({ pick: jest.fn(async () => NO_SIZE_PICK) });
		const text = 'x'.repeat(MAX_FOUNDING_BUNDLE_FILE_BYTES);
		const result = await pickFoundingBundleFile({ picker, readText: async () => text, deleteLocalCopy: jest.fn(async () => true) });
		expect(result).toEqual({ kind: 'picked', text });
	});

	it('C-3: the copy is deleted after a successful read', async () => {
		const deleteLocalCopy = jest.fn(async () => true);
		const result = await pickFoundingBundleFile({ picker: makeFakePicker(), readText: async () => 'ok', deleteLocalCopy });
		expect(result).toEqual({ kind: 'picked', text: 'ok' });
		expect(deleteLocalCopy).toHaveBeenCalledTimes(1);
		expect(deleteLocalCopy).toHaveBeenCalledWith('file://local/bundle.json');
	});

	it('C-4: the copy is deleted after a read failure', async () => {
		const deleteLocalCopy = jest.fn(async () => true);
		const readText = jest.fn(async () => { throw new Error('fetch failed'); });
		const result = await pickFoundingBundleFile({ picker: makeFakePicker(), readText, deleteLocalCopy });
		expect(result).toEqual({ kind: 'unreadable', reason: 'read-failed' });
		expect(deleteLocalCopy).toHaveBeenCalledWith('file://local/bundle.json');
	});

	it('C-5: no delete when the copy step itself failed', async () => {
		const deleteLocalCopy = jest.fn(async () => true);
		const picker = makeFakePicker({
			keepLocalCopy: jest.fn(async () => [{ status: 'error', sourceUri: 'content://picked-uri', copyError: 'disk full' }]),
		});
		const result = await pickFoundingBundleFile({ picker, readText: async () => 'x', deleteLocalCopy });
		expect(result).toEqual({ kind: 'unreadable', reason: 'copy-failed' });
		expect(deleteLocalCopy).not.toHaveBeenCalled();
	});

	it('C-6: a rejecting deleteLocalCopy never changes the pick result', async () => {
		const deleteLocalCopy = jest.fn(async () => { throw new Error('boom'); });
		const result = await pickFoundingBundleFile({ picker: makeFakePicker(), readText: async () => 'ok', deleteLocalCopy });
		expect(result).toEqual({ kind: 'picked', text: 'ok' });
	});
});

describe('pickFoundingBundleFile — P-5: lazy require discipline', () => {
	it('requiring the seam module does not load the picker module; the factory runs only on the first pickFoundingBundleFile() call', () => {
		let factoryCallCount = 0;
		let resultPromise!: Promise<unknown>;

		jest.isolateModules(() => {
			jest.doMock('@react-native-documents/picker', () => {
				factoryCallCount++;
				return {
					pick: jest.fn(async () => OK_PICK_RESULT),
					keepLocalCopy: jest.fn(async () => [
						{ status: 'success', sourceUri: 'content://picked-uri', localUri: 'file://local/bundle.json' },
					]),
					types: { allFiles: '*/*' },
					errorCodes: { OPERATION_CANCELED: 'OPERATION_CANCELED' },
					isErrorWithCode: (err: unknown): err is { code: string } =>
						typeof err === 'object' && err !== null && 'code' in err,
				};
			});

			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const seam = require('../pick-founding-bundle-file');
			expect(factoryCallCount).toBe(0);

			resultPromise = seam.pickFoundingBundleFile({ readText: async () => 'text' });
		});

		return resultPromise.then((result: unknown) => {
			expect(factoryCallCount).toBe(1);
			expect(result).toEqual({ kind: 'picked', text: 'text' });
		});
	});
});
