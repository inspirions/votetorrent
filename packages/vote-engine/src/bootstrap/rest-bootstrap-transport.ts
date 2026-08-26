import type { IBootstrapTransport, BootstrapRedemptionResult } from './bootstrap-transport.js'
import { assertKnownBootstrapRedemptionStatus, assertCanonicalBootstrapDatetime } from './bootstrap-transport.js'
import { parseSnapshot } from './snapshot-codec.js'
import type { BootstrapSnapshot } from './snapshot-types.js'

/**
 * rest-bootstrap-transport.ts — the D-06 pull-only REST binding,
 * `IBootstrapTransport`'s SECOND real binding (the first is the filesystem
 * binding, `filesystem-bootstrap-transport.ts`).
 *
 * **1. PULL BY DESIGN.** This binding only ever calls OUT. It does not
 * host an inbound webhook receiver and it never binds a port. Neither the
 * browser dashboard nor the React Native authority app can listen. Where a
 * real receiver would belong: a small standalone Node service, never
 * inside an app bundle. **None is added in this phase** — D-06 states
 * plainly that the receiver service is not built here.
 *
 * **2. Zero new dependencies.** Global `fetch` and `AbortSignal.timeout`
 * only. `axios`, `node-fetch`, `express` and `fastify` are deliberately
 * absent from this repo and must stay absent.
 *
 * **3. Browser- and Hermes-safe.** No `node:` specifier, no `Buffer`, no
 * `process`. This is the ONE binding that appears in the `./bootstrap`
 * barrel, so any such import breaks the Vite bundle AND the React Native
 * bundle at once.
 *
 * **4. What makes a fetched snapshot trustworthy.** An `https://` `baseUrl`
 * and a configured bearer header protect transit and authorize NOTHING.
 * The trust anchor is 50-02's manifest row-count + content digest + schema
 * hash, verified by the CONSUMER after this binding returns. A binding
 * that trusted the endpoint instead of the content check would be trusting
 * the network.
 *
 * **5. The locked wire protocol**, mirrored by the test-only `node:http`
 * server in this package's conformance spec:
 *   - B-1 `POST {baseUrl}/bootstrap/redemptions` with body `{ code }` ->
 *     `{ status, snapshot? }`.
 *   - B-2 `GET {baseUrl}/bootstrap/snapshot` with `?since={generatedAt}` —
 *     the parameter OMITTED entirely when there is no value, exactly as
 *     `pollDecisions` omits its cursor -> `{ snapshot }` or
 *     `{ snapshot: null }` when nothing is newer. One JSON path, no 204
 *     special case.
 *
 * No sentence in this file claims any scope is enforced here. This binding
 * never logs.
 */

/** Structural alias for the global `fetch` signature. Ambient `fetch`,
 * `Response`, and `AbortSignal.timeout` typings are supplied by
 * `@types/node`'s own web-globals declarations, so this file type-checks
 * with no `tsconfig` edit and no new dependency. */
type FetchLike = typeof fetch

const DEFAULT_TIMEOUT_MS = 15_000

interface RedemptionResponseBody {
  status?: unknown
  snapshot?: unknown
}

interface SnapshotResponseBody {
  snapshot?: unknown
}

export interface RestBootstrapTransportOptions {
  /** The endpoint's origin, e.g. `https://bootstrap.example.org`. An
   * `https://` origin is expected in any real deployment; `http://` is
   * acceptable only for a loopback test server. A trailing slash is
   * normalized once here so path joining elsewhere is unambiguous. */
  baseUrl: string
  /** Static headers merged into every request (e.g. an operator-supplied
   * bearer token). This is a transport-level convenience for reaching an
   * endpoint that requires one — it is explicitly NOT the authorization
   * gate. The trust anchor is 50-02's manifest+digest+schema-hash check,
   * performed by the consumer (see header rule 4). */
  headers?: Record<string, string>
  /** Per-request timeout in milliseconds, applied via `AbortSignal.timeout`.
   * Defaults to 15 000. */
  timeoutMs?: number
  /** Overrides the `fetch` implementation used. Exists ONLY so a host
   * lacking a global `fetch` can supply one — it is NOT a mocking seam.
   * This binding's conformance spec drives the real global `fetch` against
   * a real socket, because a mocked `fetch` would prove the binding calls
   * a function, not that it speaks HTTP. */
  fetchImpl?: FetchLike
}

/**
 * `RestBootstrapTransport` — the D-06 pull-only REST binding. See the
 * module header above for the pull-only design, the zero-dependency
 * constraint, and the TLS/digest trust split this class is built around.
 */
export class RestBootstrapTransport implements IBootstrapTransport {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike

  constructor (options: RestBootstrapTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.headers = options.headers ?? {}
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // The global `fetch` MUST be bound to `globalThis` at capture. Native
    // `fetch` is a Window/WorkerGlobalScope method with a Web IDL brand
    // check on its receiver, and it is stored here and later invoked as
    // `this.fetchImpl(...)` — a call whose receiver is the transport
    // instance, not the global. Unbound, every browser throws
    // `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`
    // before the request is ever sent, which `requestJson`'s catch then
    // reports as an unreachable endpoint. Node's `fetch` has no such brand
    // check, so the Node conformance spec cannot observe this — do not
    // remove the bind because the tests still pass without it.
    const impl = options.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch?.bind(globalThis)
    if (impl === undefined) {
      throw new Error('RestBootstrapTransport: no fetchImpl was supplied and globalThis.fetch is unavailable on this host')
    }
    this.fetchImpl = impl
  }

  /**
   * Redeem a bearer bootstrap code via B-1. The response's `status` is
   * narrowed through the seam's shared guard — never a local re-declared
   * status set and never an `as BootstrapRedemptionStatus` coercion. On
   * `'ok'` the response's `snapshot` member is structurally validated with
   * 50-02's codec and returned; on any refusal `snapshot` is omitted, and a
   * refusal that still carries a snapshot is thrown as a source defect —
   * it must surface here, not downstream.
   */
  async redeem (code: string): Promise<BootstrapRedemptionResult> {
    const body = await this.requestJson<RedemptionResponseBody>('/bootstrap/redemptions', {
      method: 'POST',
      body: { code }
    })
    const status = assertKnownBootstrapRedemptionStatus(body.status, 'RestBootstrapTransport.redeem')

    if (status === 'ok') {
      if (body.snapshot === undefined || body.snapshot === null) {
        throw new Error("RestBootstrapTransport.redeem: response status was 'ok' but the response carried no snapshot")
      }
      const parsed = parseSnapshot(JSON.stringify(body.snapshot))
      if (!parsed.ok) {
        throw new Error(`RestBootstrapTransport.redeem: response snapshot is malformed (${parsed.reason})`)
      }
      return { status: 'ok', snapshot: parsed.envelope }
    }

    if (body.snapshot !== undefined && body.snapshot !== null) {
      // A source that refuses and still ships data is a defect that must
      // surface here, not be silently forwarded downstream.
      throw new Error(`RestBootstrapTransport.redeem: response status was '${status}' but the response still carried a snapshot`)
    }
    return { status }
  }

  /**
   * The pull-cursor-shaped refresh path via B-2. `sinceGeneratedAt` is
   * guarded through the seam's canonical-datetime check when present (a
   * `Z`-suffixed cursor is rejected, never silently normalised) and is
   * OMITTED entirely from the query string when absent — never sent as the
   * literal string `undefined`. `{ snapshot: null }` maps to `undefined`;
   * otherwise the response is parsed with 50-02's codec, its
   * `generatedAt` is guarded, and it is returned VERBATIM — no filtering,
   * re-sorting, re-serializing, or re-digesting. Any client-side
   * re-decision about freshness beyond the guard belongs to the consumer.
   */
  async pullSnapshot (sinceGeneratedAt?: string): Promise<BootstrapSnapshot | undefined> {
    let path = '/bootstrap/snapshot'
    if (sinceGeneratedAt !== undefined) {
      const since = assertCanonicalBootstrapDatetime(sinceGeneratedAt, 'RestBootstrapTransport.pullSnapshot')
      path = `${path}?since=${encodeURIComponent(since)}`
    }
    const body = await this.requestJson<SnapshotResponseBody>(path, { method: 'GET' })
    if (body.snapshot === undefined || body.snapshot === null) {
      return undefined
    }
    const parsed = parseSnapshot(JSON.stringify(body.snapshot))
    if (!parsed.ok) {
      throw new Error(`RestBootstrapTransport.pullSnapshot: response snapshot is malformed (${parsed.reason})`)
    }
    assertCanonicalBootstrapDatetime(parsed.envelope.generatedAt, 'RestBootstrapTransport.pullSnapshot')
    return parsed.envelope
  }

  /**
   * Builds the URL from the normalized `baseUrl` + `path`, merges headers,
   * serializes `body` on a POST, and applies the per-request timeout. On a
   * non-2xx response the thrown Error carries ONLY the status code and the
   * request path — never the response body, response headers, or request
   * body. A JSON parse failure follows the same rule. A `fetch` rejection
   * is rethrown with the path appended and no other detail.
   *
   * This omission is load-bearing, not stylistic: the request body carries
   * the BEARER CODE and the response body is a WHOLE-DATABASE snapshot
   * including registrant PII, so an `await response.text()` appended here
   * would be a direct PII and credential leak. This must NOT be "improved"
   * later.
   */
  private async requestJson<T> (path: string, requestInit: { method: 'GET' | 'POST', body?: unknown }): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = { ...this.headers, accept: 'application/json' }
    let body: string | undefined
    if (requestInit.method === 'POST') {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(requestInit.body)
    }

    let response: Response
    try {
      // Invoked through a local binding so the receiver is never `this` —
      // see the constructor's note on the Web IDL brand check.
      const fetchImpl = this.fetchImpl
      response = await fetchImpl(url, {
        method: requestInit.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch {
      throw new Error(`RestBootstrapTransport: request to ${path} failed`)
    }

    if (!response.ok) {
      throw new Error(`RestBootstrapTransport: request to ${path} failed with status ${response.status}`)
    }

    try {
      return await response.json() as T
    } catch {
      throw new Error(`RestBootstrapTransport: request to ${path} returned status ${response.status} but the response body could not be parsed as JSON`)
    }
  }
}
