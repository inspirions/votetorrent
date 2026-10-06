/**
 * @format
 *
 * copyVoteCode: the single lazy clipboard seam (D-17).
 */
import {copyVoteCode} from '../vote-code-clipboard';

const NONCE = 'a0b1c2d3'.repeat(8);

function mockedClipboard(): {setString: (s: string) => void} {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require('@react-native-clipboard/clipboard').default;
}

describe('copyVoteCode', () => {
	let spies: jest.SpyInstance[] = [];
	beforeEach(() => {
		spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m =>
			jest.spyOn(console, m).mockImplementation(() => {}),
		);
	});
	afterEach(() => {
		spies.forEach(s => expect(s).not.toHaveBeenCalled());
		jest.restoreAllMocks();
		jest.resetModules();
		jest.dontMock('@react-native-clipboard/clipboard');
	});

	it('copies the ungrouped 64-hex string exactly once', () => {
		const set = jest.spyOn(mockedClipboard(), 'setString');
		expect(copyVoteCode(NONCE)).toBe('copied');
		expect(set).toHaveBeenCalledTimes(1);
		expect(set).toHaveBeenCalledWith(NONCE);
		expect(set.mock.calls[0][0]).toHaveLength(64);
	});

	const grouped = NONCE.match(/.{4}/g)!.join(' ');
	it.each([
		['grouped', grouped],
		['uppercase', NONCE.toUpperCase()],
		['63 chars', NONCE.slice(1)],
		['65 chars', NONCE + 'a'],
		['empty', ''],
		['non-hex', 'g' + NONCE.slice(1)],
	])('rejects %s and never copies', (_n, value) => {
		const set = jest.spyOn(mockedClipboard(), 'setString');
		expect(() => copyVoteCode(value)).toThrow(
			new TypeError('vote code must be 64 lowercase hex characters'),
		);
		expect(set).not.toHaveBeenCalled();
	});

	it('returns unavailable when setString throws', () => {
		jest.spyOn(mockedClipboard(), 'setString').mockImplementationOnce(() => {
			throw new Error('boom');
		});
		expect(copyVoteCode(NONCE)).toBe('unavailable');
	});

	it('returns unavailable when the module cannot load (stale binary)', () => {
		jest.isolateModules(() => {
			jest.doMock('@react-native-clipboard/clipboard', () => {
				throw new Error('RNCClipboard not found');
			});
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const isolated = require('../vote-code-clipboard');
			expect(isolated.copyVoteCode(NONCE)).toBe('unavailable');
		});
	});

	it('source: lazy require only, no console, no Share', () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require('fs') as {readFileSync(p: string, e: string): string};
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const path = require('path') as {join(...p: string[]): string};
		const src = fs
			.readFileSync(path.join(__dirname, '..', 'vote-code-clipboard.ts'), 'utf8')
			.split('\n')
			.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
			.join('\n');
		expect(src).not.toMatch(/^\s*import[^;]*@react-native-clipboard\/clipboard/m);
		expect(src).toMatch(/require\('@react-native-clipboard\/clipboard'\)/);
		expect(src).not.toMatch(/console\./);
		expect(src).not.toMatch(/Share/);
	});
});
