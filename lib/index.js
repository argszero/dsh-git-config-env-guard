/**
 * `@argszero/dsh-git-config-env-guard` — keep Git's command-line-configuration
 * channel atomic across the harness's environment scrub.
 *
 * `scrubbedParentEnv()` removes credential-shaped names by substring, and
 * `GIT_CONFIG_KEY_<n>` matches while `GIT_CONFIG_COUNT` and
 * `GIT_CONFIG_VALUE_<n>` do not. A child then inherits a counter whose keys are
 * gone, and git refuses to read *any* configuration — measured on git 2.50.1,
 * `git status` exits 128 with `error: missing config key GIT_CONFIG_KEY_0`.
 *
 * This plugin restores the channel's one legal intermediate state at the last
 * mile: a group git cannot read is removed whole, an intact group passes through,
 * and nothing else about the environment changes.
 */

import { DSH_ENV_PREFIX, SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'

import { createRepair, shadowInstance } from './guard.js'
import { scrubPredicate } from './scrub.js'

/** Plugin name as the loader sees it. */
export const name = 'git-config-env-guard'

/** The service this plugin cannot work without. */
export const inject = ['subprocess']

/** The accepted repair postures. */
const MODES = new Set(['repair', 'drop', 'report', 'off'])

/**
 * Validate the plugin configuration, refusing rather than guessing: a silently
 * defaulted filter would report success while doing something else.
 * @param config - the loader-supplied configuration.
 * @returns the normalised settings.
 */
export function normaliseConfig(config) {
  const input = config ?? {}
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('git-config-env-guard: config must be an object')
  const mode = input.mode ?? 'repair'
  if (typeof mode !== 'string' || !MODES.has(mode)) {
    throw new TypeError(`git-config-env-guard: mode must be one of ${[...MODES].join(', ')}, received ${String(mode)}`)
  }
  const warn = input.warn ?? true
  if (typeof warn !== 'boolean') throw new TypeError('git-config-env-guard: warn must be a boolean')
  return { mode, warn }
}

/**
 * The subprocess service instance behind a context's traceable view.
 * @param ctx - the plugin context.
 * @returns the instance every consumer resolves methods through.
 */
function resolveInstance(ctx) {
  const view = ctx.get('subprocess')
  if (view === undefined || view === null) return undefined
  return view[Symbol.for('cordis.original')] ?? view
}

/**
 * Mount the guard.
 * @param ctx - the plugin context, with `subprocess` available.
 * @param config - `mode` (`repair` by default) and `warn`.
 */
export function apply(ctx, config) {
  const settings = normaliseConfig(config)
  if (settings.mode === 'off') return
  const impl = resolveInstance(ctx)
  if (impl === undefined) throw new Error('git-config-env-guard: no subprocess service to guard')

  // Judged with the shipped rule rather than a copy of it: the defect exists only
  // because of which names that rule matches, so a copy that drifted would repair
  // the wrong half. A line that stops exporting these fails at load instead.
  const { isScrubbed, source } = scrubPredicate(SENSITIVE_ENV_PATTERN, DSH_ENV_PREFIX)
  const { repair, report } = createRepair({
    mode: settings.mode,
    ambient: () => process.env,
    isScrubbed,
    now: () => new Date().toISOString(),
  })

  try {
    ctx.provide('gitConfigEnvGuard', { report, scrubSource: source })
  } catch {
    // The diagnostic surface is optional; the repair is not.
  }

  const warned = new Set()
  const restore = shadowInstance(impl, (spec) => {
    const before = report().repaired
    const next = repair(spec)
    const latest = report().last.at(-1)
    // Once per shape, not once per child: a parent whose environment carries the
    // broken channel keeps it for the whole session, and one line says everything a
    // hundred would.
    if (settings.warn && report().repaired > before && latest !== undefined && !warned.has(latest.shape)) {
      warned.add(latest.shape)
      ctx.logger?.warn?.(
        `git-config-env-guard: Git's command-line configuration arrived ${latest?.shape ?? 'unreadable'} `
        + `(missing ${(latest?.missing ?? []).join(', ') || 'a member'}); dropped the channel whole for this child. `
        + 'The scrub in @deepseek-ai/dsh-subprocess removes GIT_CONFIG_KEY_<n> but keeps GIT_CONFIG_COUNT, '
        + 'which makes every git child exit 128.',
      )
    }
    return next
  })
  ctx.effect(() => restore)
  // Also returned: a plugin's own startup result is itself a valid effect, so the
  // teardown survives either registration path. `restore` is a no-op the second
  // time, which is what makes offering both safe.
  return restore
}

export default { name, inject, apply }
