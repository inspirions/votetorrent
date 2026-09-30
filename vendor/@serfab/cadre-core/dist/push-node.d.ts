/**
 * push-node.ts — Node-only subpath entry for platform push **construction**.
 *
 * Import from the dedicated subpath, never the package root:
 *
 * ```ts
 * import { createPushNotifier } from '@serfab/cadre-core/push-node';
 * ```
 *
 * The FCM/APNs implementations reach for `node:crypto` / `node:http2`, so they
 * are quarantined here — unreachable from the cross-platform `./index.js` graph
 * (same isolation pattern as `./key-store-file`). A React Native / browser entry
 * never resolves this path, so the Node builtins never reach a bundler that
 * cannot satisfy them. The core references only the {@link PushNotifier}
 * *interface* (`push-notifier.ts`) and a Node host injects the instance built
 * here into `CadreNodeConfig.push.notifier`.
 */
import type { PushCredentials } from './types.js';
import type { PushNotifier } from './push-notifier.js';
import { createFcmPushNotifier, type FcmPushDeps } from './push-notifier-fcm.js';
import { createApnsPushNotifier, type ApnsPushDeps } from './push-notifier-apns.js';
/**
 * Per-platform transport/clock/log seams, injected by tests. Defaults are the
 * real implementations (global `fetch` for FCM, a `node:http2` session for APNs).
 */
export interface PushNotifierDeps {
    fcm?: FcmPushDeps;
    apns?: ApnsPushDeps;
}
/**
 * Build a {@link PushNotifier} router over the configured credentials. Only the
 * platforms whose credentials are present get a backing implementation; a `send`
 * for an unconfigured platform returns a best-effort `no <platform> credentials`
 * failure rather than throwing.
 */
export declare function createPushNotifier(creds: PushCredentials, deps?: PushNotifierDeps): PushNotifier;
export { createFcmPushNotifier, createApnsPushNotifier };
export type { FcmPushDeps, ApnsPushDeps };
