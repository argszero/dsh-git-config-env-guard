/**
 * The repair itself: judge one spawn spec's resolved environment and, when Git's
 * channel is in a state git refuses to read, remove the channel whole.
 */

import { classify, familyNames, isFamilyName, tombstones } from './group.js'
import { resolveChannel } from './scrub.js'

/** How many resolved verdicts to keep for inspection. */
const KEEP = 20

/** The shadowing marker, so a second mount can recognise its own work. */
export const GUARD_MARKER = Symbol.for('@argszero/dsh-git-config-env-guard')

/**
 * Whether any name in this object belongs to Git's channel — the counter, its
 * indexed pairs, or the legacy spelling. `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`
 * and `GIT_CONFIG_NOSYSTEM` are different settings and are not members.
 * @param env - any environment-shaped object.
 * @returns true when at least one family member is present.
 */
export function hasChannel(env) {
  if (!env) return false
  for (const name of Object.keys(env)) if (isFamilyName(name)) return true
  return false
}

/**
 * Build the repair function and its counters.
 *
 * Every judgement is a pure function of the two environments, so a spawn that the
 * guard cannot read is forwarded unchanged rather than blocked: this is a repair
 * on the way to a child, never a gate in front of one.
 * @param options - mode, ambient environment, scrub predicate, and clock.
 * @returns the spec repair, the report snapshot, and the counters it writes.
 */
export function createRepair(options) {
  const { mode, ambient, isScrubbed, now } = options
  const counters = {
    spawns: 0,
    examined: 0,
    repaired: 0,
    failed: 0,
    byShape: { absent: 0, inert: 0, intact: 0, orphaned: 0, malformed: 0 },
    last: [],
    firstRepairAt: null,
  }

  const remember = (entry) => {
    counters.last.push(entry)
    if (counters.last.length > KEEP) counters.last.shift()
  }

  /**
   * Repair one spawn spec.
   * @param spec - the caller's spawn spec.
   * @returns the spec to forward, identical unless the channel had to go.
   */
  const repair = (spec) => {
    counters.spawns += 1
    try {
      const explicit = spec?.env
      const ambientHas = hasChannel(typeof ambient === 'function' ? ambient() : ambient)
      if (!ambientHas && !hasChannel(explicit)) return spec
      counters.examined += 1
      const resolved = resolveChannel(typeof ambient === 'function' ? ambient() : ambient, explicit, isScrubbed)
      const verdict = classify(resolved)
      counters.byShape[verdict.shape] += 1
      if (mode === 'report') {
        remember({ at: now(), shape: verdict.shape, count: verdict.count, missing: verdict.missing, acted: false })
        return spec
      }
      // `repair` acts only on the states git cannot read; `drop` additionally
      // removes an intact group unless the caller supplied one itself.
      const explicitVerdict = classify(resolveChannel({}, explicit, isScrubbed))
      const act = verdict.shape === 'orphaned'
        || verdict.shape === 'malformed'
        || (mode === 'drop' && verdict.shape === 'intact' && explicitVerdict.shape !== 'intact')
        || (mode === 'drop' && verdict.shape === 'inert')
      if (!act) {
        remember({ at: now(), shape: verdict.shape, count: verdict.count, missing: verdict.missing, acted: false })
        return spec
      }
      const drop = tombstones(resolved)
      counters.repaired += 1
      if (counters.firstRepairAt === null) counters.firstRepairAt = now()
      remember({
        at: now(),
        shape: verdict.shape,
        count: verdict.count,
        missing: verdict.missing,
        reason: verdict.reason ?? null,
        dropped: Object.keys(drop).sort(),
        acted: true,
      })
      return { ...spec, env: { ...explicit, ...drop } }
    } catch (error) {
      // A guard that can fail a spawn is worse than the defect it repairs.
      counters.failed += 1
      remember({ at: now(), shape: 'error', message: String(error?.message ?? error), acted: false })
      return spec
    }
  }

  /**
   * The diagnostic snapshot.
   * @returns counters, the resolved shape tallies and the recent verdicts.
   */
  const report = () => ({
    mode,
    ...counters,
    byShape: { ...counters.byShape },
    last: counters.last.map((entry) => ({ ...entry })),
    pending: hasChannel(typeof ambient === 'function' ? ambient() : ambient) ? familyNames(typeof ambient === 'function' ? ambient() : ambient) : [],
  })

  return { repair, report, counters }
}

/**
 * Shadow `spawn` and `spawnTerminal` on one subprocess service instance.
 *
 * The instance is patched rather than the `ctx.get()` view: a view is a fresh
 * traceable proxy on every read, and a write to it may be swallowed, while every
 * consumer of the service (`bash`, subagents, MCP stdio, LSP, worktree) resolves
 * methods through the same instance.
 * @param impl - the subprocess service instance.
 * @param repair - the spec repair to route every spawn through.
 * @returns a disposer restoring the instance to its shipped shape.
 */
export function shadowInstance(impl, repair) {
  if (impl === undefined || impl === null) throw new Error('git-config-env-guard: no subprocess service instance to shadow')
  if (impl[GUARD_MARKER] === true) throw new Error('git-config-env-guard: the subprocess instance is already guarded')
  const hadOwnSpawn = Object.hasOwn(impl, 'spawn')
  const hadOwnTerminal = Object.hasOwn(impl, 'spawnTerminal')
  const originalSpawn = impl.spawn
  const originalTerminal = impl.spawnTerminal

  impl.spawn = function guardedSpawn(spec) {
    return originalSpawn.call(this, repair(spec))
  }
  impl.spawnTerminal = function guardedSpawnTerminal(spec) {
    return originalTerminal.call(this, repair(spec))
  }
  Object.defineProperty(impl, GUARD_MARKER, { value: true, configurable: true, enumerable: false })

  return () => {
    if (hadOwnSpawn) impl.spawn = originalSpawn
    else delete impl.spawn
    if (hadOwnTerminal) impl.spawnTerminal = originalTerminal
    else delete impl.spawnTerminal
    delete impl[GUARD_MARKER]
  }
}
