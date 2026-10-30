// pool-failover.ts — a rendezvous client over several transports to the SAME authority rendezvous,
// one per join-bootstrap address (R3, D-30).
//
// Rules:
//   - the client that answered last is tried first (sticky last-good), then the others in index order;
//   - fail over only on a THROW (a failed dial or timeout). An `error` REPLY means the host was
//     reached and answered, so it is returned as is, never retried elsewhere;
//   - when no client answers, one stable `Error('rendezvous unreachable')` is thrown: no raw
//     transport text, no `cause`, so nothing hostile reaches a screen.
// Transport-free and Hermes/browser-pure: type-only imports, no Node API, no clock.
import type { PoolRendezvousClient, RendezvousReply, RendezvousRequest } from './pool-rendezvous.js'

export interface FailoverRendezvousClient extends PoolRendezvousClient {
  /** index of the client that answered most recently; -1 before any answer */
  lastGood (): number
}

export function createFailoverRendezvousClient (clients: readonly PoolRendezvousClient[]): FailoverRendezvousClient {
  const list = clients.slice()
  let good = -1
  return {
    lastGood: () => good,
    async call (request: RendezvousRequest, extraWaitMs?: number): Promise<RendezvousReply> {
      const order: number[] = []
      if (good >= 0 && good < list.length) order.push(good)
      for (let i = 0; i < list.length; i++) if (i !== good) order.push(i)
      for (const i of order) {
        try {
          const reply = await list[i]!.call(request, extraWaitMs)
          good = i
          return reply
        } catch {
          // this address did not answer; try the next
        }
      }
      throw new Error('rendezvous unreachable')
    }
  }
}
