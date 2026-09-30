import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { IndexedDBRawStorage, openOptimysticWebDb } from '@optimystic/db-p2p-storage-web';
import { composeStrand, applyRegistrations } from './compose-strand.js';
/**
 * Connect a Quereus Database to a Sereus strand from a browser/worker.
 *
 * Thin adapter over the shared {@link composeStrand} composition, supplying the
 * browser platform seams:
 *  - crypto registered inline (no runtime `@quereus/quereus` import, so the
 *    bundle does not duplicate the host's instance),
 *  - storage defaulting to `IndexedDBRawStorage` keyed by `sereus-strand-<id>`,
 *  - a node created via the TCP-free `@optimystic/db-p2p/rn` entry with explicit
 *    `webSockets()` + `circuitRelayTransport()` transports.
 */
export async function connectToStrandBrowser(db, options) {
    return composeStrand(db, options, {
        registerCrypto(database) {
            applyRegistrations(database, cryptoPlugin(database, {}));
        },
        async resolveStorage({ strandId, resolvedTransactor, requestedStorage }) {
            if (requestedStorage)
                return requestedStorage;
            // Browsers always default to IndexedDB so a reload survives; the
            // unit-test fake transactor needs no storage.
            if (resolvedTransactor === 'test')
                return undefined;
            const dbHandle = await openOptimysticWebDb(`sereus-strand-${strandId}`);
            return new IndexedDBRawStorage(dbHandle);
        },
        async createNode({ networkName, bootstrapNodes, fretProfile, clusterSize, clusterPolicy, storage }) {
            return createLibp2pNode({
                transports: [webSockets(), circuitRelayTransport()],
                listenAddrs: [],
                bootstrapNodes,
                networkName,
                fretProfile,
                clusterSize,
                clusterPolicy,
                ...(storage && { storage }),
            });
        },
    });
}
//# sourceMappingURL=connect-browser.js.map