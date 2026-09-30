/**
 * push-notifier.ts — the platform-push **delivery** contract for strand-wake.
 *
 * This module is the cross-platform-safe *interface* half: the message shape
 * ({@link PushMessage}), the outcome value ({@link PushSendResult}), and the
 * {@link PushNotifier} port a `CadreNode` sends over. It carries ZERO runtime
 * dependencies and imports no implementation — so the RN/browser entry graph can
 * reference the type without ever resolving `node:crypto` / `node:http2`.
 *
 * The concrete FCM/APNs implementations (`push-notifier-fcm.ts` /
 * `push-notifier-apns.ts`) and the `createPushNotifier` router that builds them
 * live behind the Node-only subpath `@serfab/cadre-core/push-node`
 * (`push-node.ts`). A Node host constructs a notifier from that subpath and
 * injects the instance into `CadreNodeConfig.push.notifier`; the cross-platform
 * core never constructs one, so the Node-only builtins stay out of its graph.
 *
 * Keep this file zero-import (beyond erased type-only imports): the whole point
 * of the seam is that referencing the interface can never drag an implementation
 * module into a bundler's graph.
 */
export {};
//# sourceMappingURL=push-notifier.js.map