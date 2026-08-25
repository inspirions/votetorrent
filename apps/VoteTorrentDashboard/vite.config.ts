import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// D-19 binding rule: this config must NEVER gain a `resolve.alias`, a `define`, or a
// plugin that shims a Node builtin (`buffer`, `process`, `crypto`, `stream`, `path`,
// `vite-plugin-node-polyfills`, `node-stdlib-browser`). If the build needs one of those
// to succeed, the fix is to remove the offending import from the engine subpath
// (`@votetorrent/vote-engine/browser`), never to add a polyfill here. A build that
// silently shims a Node builtin has failed the zero-polyfill bar that
// `scripts/assert-no-node-polyfills.mjs` exists to enforce.
export default defineConfig({
	plugins: [react()],
	server: { port: 5180, strictPort: true },
	preview: { port: 5180, strictPort: true },
	build: { target: 'es2022', sourcemap: true },
});
