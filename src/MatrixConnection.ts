import type { Problem } from './BridgeApi.js'
import { botUserId, type MatrixIdentity } from './config.js'
import { discoverHomeserver } from './homeserver.js'
import { HttpError, type FetchImpl } from './http.js'
import { MatrixClient } from './MatrixClient.js'
import { SyncLoop, TOKEN_HINT, type SyncLoopOptions } from './SyncLoop.js'

export type MatrixAccess =
  | { kind: 'application_service'; homeserverUrl: string; serverName: string; senderLocalpart: string; asToken: string }
  | { kind: 'account'; homeserverUrl: string; accessToken: string }

export type MatrixProblem = 'matrix_registration_missing' | 'matrix_token_invalid' | 'matrix_unreachable' | 'account_in_use'

export interface MatrixConnectionOptions {
  access: MatrixAccess
  /** An account's events. */
  store: SyncLoopOptions['store']
  accept: SyncLoopOptions['relay']['acceptSync']
  rooms: SyncLoopOptions['rooms']
  onMembership?: SyncLoopOptions['onMembership']
  /** Which Matrix user this is; once, before anything is usable. */
  onIdentity: (matrix: MatrixClient, identity: MatrixIdentity) => void
  /** The homeserver takes the bridge: at first, and at each check after. */
  onUsable: () => Promise<void> | void
  onState: () => void
  /** Whether the account is this connection's alone. */
  claim?: (homeserverUrl: string, userId: string) => Promise<boolean>
  /** What a refused token's owner does about it. */
  tokenHint?: string
  registrationHint: string
  fetchImpl?: FetchImpl
  timings: { matrixMs: number; backoffMs: number }
  log: (line: string) => void
  warn: (line: string) => void
}

/** One Matrix user the bridge acts as: registered or signed in, and checked again every minute. */
export class MatrixConnection {
  matrix?: MatrixClient
  identity?: MatrixIdentity
  private sync?: SyncLoop
  private syncing = false
  private problem: MatrixProblem | null = null
  private usable = false
  private claimed = false
  private stopped = false
  private running?: Promise<void>
  private wake?: () => void
  /** The client API: an account's is found through its address. */
  private homeserverUrl: string

  constructor(private readonly options: MatrixConnectionOptions) {
    this.homeserverUrl = options.access.homeserverUrl
    const { access } = options
    if (access.kind === 'application_service') this.identify({ serverName: access.serverName, senderLocalpart: access.senderLocalpart })
  }

  /** The homeserver took the bridge at the last check. */
  get connected(): boolean { return this.usable }
  /** Events arrive too, as far as that is this side's doing. */
  get receiving(): boolean { return this.usable && (this.sync?.connected ?? true) }

  problems(): Problem[] {
    const problems: Problem[] = []
    if (this.problem) problems.push({ code: this.problem, ...(this.problem === 'matrix_token_invalid' ? { detail: this.options.tokenHint ?? TOKEN_HINT } : {}) })
    // A loop that has not started reports nothing of its own.
    if (this.sync && this.syncing && this.usable) problems.push(...this.sync.problems())
    return problems
  }

  start(): void { this.running ??= this.follow() }

  async stop(): Promise<void> {
    this.stopped = true
    this.wake?.()
    await Promise.all([this.sync?.stop(), this.running])
  }

  startSync(): void {
    if (this.stopped) return
    this.syncing = true
    this.sync?.start()
  }
  roomsChanged(): void { this.sync?.roomsChanged() }

  private identify(identity: MatrixIdentity): void {
    const { options } = this
    const { access } = options
    const account = access.kind === 'account'
    this.identity = identity
    this.matrix = new MatrixClient({ homeserverUrl: this.homeserverUrl, botUserId: botUserId({ matrix: identity }), account,
      asToken: access.kind === 'account' ? access.accessToken : access.asToken, adoptsGhosts: true, fetchImpl: options.fetchImpl })
    if (account) {
      this.sync = new SyncLoop({ matrix: this.matrix, store: options.store, relay: { acceptSync: options.accept }, userId: identity.userId!, rooms: options.rooms,
        onMembership: options.onMembership, onState: options.onState, report: line => options.warn(line), tokenHint: options.tokenHint })
    }
    options.onIdentity(this.matrix, identity)
  }

  private async follow(): Promise<void> {
    const { access, fetchImpl, timings } = this.options
    let delay = timings.backoffMs
    let registered = false
    while (!this.stopped) {
      let problem: MatrixProblem | null = null
      try {
        if (access.kind === 'account') {
          if (!this.matrix) this.homeserverUrl = await discoverHomeserver(access.homeserverUrl, fetchImpl)
          const client: MatrixClient = this.matrix ?? new MatrixClient({ homeserverUrl: this.homeserverUrl, botUserId: '', account: true, asToken: access.accessToken, fetchImpl })
          const userId = await client.whoami()
          if (this.stopped) return
          this.claimed ||= !this.options.claim || await this.options.claim(this.homeserverUrl, userId)
          if (this.stopped) return
          if (!this.claimed) problem = 'account_in_use'
          else if (!this.matrix) this.identify({ serverName: userId.slice(userId.indexOf(':') + 1), userId })
        } else {
          if (!registered) await this.matrix!.ensureRegistered()
          registered = true
          await this.matrix!.verifySender()
        }
      } catch (error) {
        if (this.stopped) return
        registered = false
        const refused = error instanceof HttpError && !error.transient && (error.status === undefined || [400, 401, 403].includes(error.status))
        problem = !refused ? 'matrix_unreachable' : access.kind === 'account' ? 'matrix_token_invalid' : 'matrix_registration_missing'
      }
      this.set(problem)
      if (problem === null) {
        delay = timings.backoffMs
        await this.options.onUsable()
      }
      const waits = problem === null || problem === 'account_in_use'
      await this.sleep(waits ? timings.matrixMs : delay)
      if (!waits) delay = Math.min(timings.matrixMs, delay * 2)
    }
  }

  private sleep(delay: number): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.wake = undefined; resolve() }
      const timer = setTimeout(done, delay)
      this.wake = done
    })
  }

  private set(problem: MatrixProblem | null): void {
    const { log, warn, onState, tokenHint = TOKEN_HINT, registrationHint } = this.options
    const changed = problem !== this.problem || this.usable !== (problem === null)
    this.problem = problem
    this.usable = problem === null
    if (!changed) return
    if (problem === null) log('Matrix homeserver connected')
    else if (problem === 'matrix_unreachable') warn('Cannot reach the Matrix homeserver; retrying')
    else if (problem === 'account_in_use') warn('Another bridge uses this Matrix account; nothing is relayed')
    else if (problem === 'matrix_token_invalid') warn(`The homeserver refuses the access token. ${tokenHint}`)
    else warn(`The homeserver does not accept the bridge yet: ${registrationHint}. Retrying`)
    onState()
  }
}
