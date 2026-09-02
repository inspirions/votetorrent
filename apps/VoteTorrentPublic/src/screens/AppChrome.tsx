import type { ReactNode } from 'react';

/**
 * AppChrome — the public app's structural chrome only.
 *
 * Renders no text node and no string literal that would appear on screen.
 * This is deliberate, not an oversight: D-08 admits only the `public.*` copy
 * keys the skeleton actually mounts, and 53-07 owns that mount list.
 * Inventing chrome prose here would either bypass the shared copy table
 * (violating D-05, and D-06's three-root lint would be right to flag it) or
 * pre-empt D-08's key set with words no one reviewed for a no-login
 * audience — which is the exact failure D-07 exists to prevent (spike 091's
 * shared component rendered "follows the officer's permissions" on a page
 * with no officer, with clean imports and every gate green). Words arrive in
 * 53-07, through `t()`.
 *
 * This component never uses React's raw-HTML injection escape hatch — a
 * standing tier-1 absence scan (Task 3) makes that binding rather than
 * advisory, before 53-07's URL parsing gives it something to be dangerous
 * with.
 *
 * Accepts and renders `children` so 53-07 can mount `ElectionShell` inside
 * this chrome without restructuring this component. No hook is called
 * here — the designated hook-calling component for the D-19 identity gate
 * is DetailsToggle (packages/ui-web, 53-05), mounted in 53-07; a stray hook
 * in the chrome would muddy which component the gate is actually exercising.
 */
export function AppChrome({ children }: { children?: ReactNode }) {
	return (
		<div className="public-app">
			<header className="public-app__header" />
			<main className="public-app__main">{children}</main>
			<footer className="public-app__footer" />
		</div>
	);
}
