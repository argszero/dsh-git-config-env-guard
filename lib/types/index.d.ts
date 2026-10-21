/** The repair postures this plugin accepts. */
export type GuardMode = 'repair' | 'drop' | 'report' | 'off'

/** One resolved verdict, kept for inspection. */
export interface GuardEntry {
  /** ISO instant the verdict was reached. */
  at: string
  /** The judged shape, or `error` when the judgement itself threw. */
  shape: 'absent' | 'inert' | 'intact' | 'orphaned' | 'malformed' | 'error'
  /** The readable counter, when one was there. */
  count?: number | null
  /** Channel members the child would have been missing. */
  missing?: readonly string[]
  /** Why a malformed counter was malformed. */
  reason?: string | null
  /** The tombstones actually forwarded, when the spawn was changed. */
  dropped?: readonly string[]
  /** Whether this spawn's environment was changed. */
  acted: boolean
  /** The judgement failure, when `shape` is `error`. */
  message?: string
}

/** What the plugin's diagnostic surface answers. */
export interface GuardReport {
  /** The active posture. */
  mode: GuardMode
  /** Spawns and terminal allocations seen by the shadow. */
  spawns: number
  /** Spawns whose environment carried the channel at all. */
  examined: number
  /** Spawns whose channel was removed. */
  repaired: number
  /** Judgements that threw and therefore forwarded the original spec. */
  failed: number
  /** Tally per judged shape. */
  byShape: Record<'absent' | 'inert' | 'intact' | 'orphaned' | 'malformed', number>
  /** The most recent verdicts, bounded. */
  last: readonly GuardEntry[]
  /** Channel members still present in the ambient environment. */
  pending: readonly string[]
  /** ISO instant of the first repair. */
  firstRepairAt: string | null
}

/** The service this plugin provides under `gitConfigEnvGuard`. */
export interface GuardService {
  /** The current counters. */
  report(): GuardReport
  /** Whether the scrub rule came from the package or the bundled fallback. */
  scrubSource: 'module' | 'fallback'
}

/** The plugin configuration. */
export interface GuardConfig {
  /** Posture; `repair` by default. */
  mode?: GuardMode
  /** Whether to warn once per repaired shape; `true` by default. */
  warn?: boolean
}

/** Plugin name as the loader sees it. */
export declare const name: 'git-config-env-guard'

/** The service this plugin cannot work without. */
export declare const inject: readonly ['subprocess']

/** Validate the loader-supplied configuration; throws rather than defaulting silently. */
export declare function normaliseConfig(config?: unknown): { mode: GuardMode; warn: boolean }

/** Mount the guard on the context's subprocess service. */
export declare function apply(ctx: {
  get(name: 'subprocess'): unknown
  provide?: (name: string, value: unknown) => unknown
  effect?: (execute: () => unknown) => unknown
  logger?: { warn?: (message: string) => void }
}, config?: GuardConfig): void

declare const plugin: { name: typeof name; inject: typeof inject; apply: typeof apply }
export default plugin
