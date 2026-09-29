/**
 * A cadre-core `DurableSlot` over AsyncStorage, and the strand peer book that sits on it (spike 094).
 *
 * WHY. cadre-core 1.7.0 keeps a per-strand PEER BOOK: every strand peer this node met on a live
 * connection, with its last-known addresses. It is read on every launch and every periodic address
 * refresh, so a restarted phone dials the strand peers it was talking to before anything else,
 * instead of depending solely on the control-cohort strand-addr RPC. That RPC path is where
 * P2P-11 kept breaking (the late-enrolment gap, sereus#21's throttle, sereus#22's masking).
 * Without an injected store the book is in-memory and dies with the process. Upstream's release
 * notes: "either store left in memory reproduces the old behaviour". On a phone every launch is
 * a restart; the proof's D-05 relaunch is one too.
 *
 * Adapted from sereus-chat `apps/mobile/src/cadre/rn-durable-slot.ts`. We omit its `RNKeyStore` /
 * `joinedStrands` half: that records strands joined from ANOTHER party, while VoteTorrent's
 * strands arrive over this party's own control network and are re-offered from its rows.
 *
 * THE FAULT/ABSENT DISTINCTION IS LOAD-BEARING (cadre-core's own contract). `undefined` means
 * "cold start, nothing was ever written", and the caller then snapshot-writes the whole record.
 * So a read that FAILS must throw. It must never be caught into `undefined`, or a transient
 * AsyncStorage error would destroy an intact book on the next save.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PersistentStrandPeerBookStore, type DurableSlot, type StrandPeerBookStore } from '@serfab/cadre-core';

export class AsyncStorageDurableSlot implements DurableSlot {
  constructor(private readonly key: string) {}

  async load(): Promise<string | undefined> {
    // A rejection propagates on purpose (see header): absence is `null` from a RESOLVED call.
    const raw = await AsyncStorage.getItem(this.key);
    return raw ?? undefined;
  }

  async save(text: string): Promise<void> {
    await AsyncStorage.setItem(this.key, text);
  }
}

/**
 * The strand peer book for one node, namespaced by party AND by store scope. Two nodes on one
 * device (the app's own and a proof runner's) must never share a book.
 */
export function openStrandPeerBook(partyId: string, scope: string): Promise<StrandPeerBookStore> {
  return PersistentStrandPeerBookStore.open(
    new AsyncStorageDurableSlot(`@votetorrent/strandPeerBook/${scope}/${partyId}`),
    partyId,
  );
}
