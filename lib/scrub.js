/**
 * How the harness's own environment scrub treats Git's channel.
 *
 * `scrubbedParentEnv()` (packages/subprocess/subprocess/src/index.ts) copies the
 * ambient environment minus names matching `SENSITIVE_ENV_PATTERN` and minus the
 * `DSH_` namespace. Both are public exports there — but reading them at module
 * scope makes this package's own entry unimportable: a profile resolves a
 * plugin's dependencies from the plugin's own tree, and `@deepseek-ai/dsh-subprocess`
 * is not in it (measured: the entry throws `ERR_MODULE_NOT_FOUND` on import, while
 * `dsh plugin add` still exits 0 and claims the row). So the two literals are
 * carried here, copied verbatim from the head they were read at:

 *   SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i   index.ts:47
 *   DSH_ENV_PREFIX        = 'DSH_'                         types.ts:13
 *
 * They are *values*, not identities: nothing downstream compares them by
 * reference, and a copy that has drifted is caught by the arms in
 * test/packaging.spec.mjs that check against the runtime when it can be resolved.
 */

import { isFamilyName } from './group.js'

/** The shipped credential-shaped-name rule, carried: `/KEY|PASSWORD|SECRET|TOKEN/i`. */
export const SENSITIVE_ENV_PATTERN_SOURCE = 'KEY|PASSWORD|SECRET|TOKEN'

/** The namespace prefix the scrub also removes, carried verbatim (`types.ts:13`). */
export const DSH_ENV_PREFIX_DEFAULT = 'DSH_'

/**
 * What the entry judges with, held as data so no module-scope import of the
 * harness peer is needed. `source: 'carried'` is reported as such, because a
 * reader who is told "module" deserves the module.
 */
export const CARRIED_SCRUB = Object.freeze({
  pattern: new RegExp(SENSITIVE_ENV_PATTERN_SOURCE, 'i'),
  prefix: DSH_ENV_PREFIX_DEFAULT,
  source: 'carried',
})

const FALLBACK_PATTERN = new RegExp(SENSITIVE_ENV_PATTERN_SOURCE, 'i')

/**
 * Build the scrub predicate this plugin judges with.
 *
 * A shipped pattern is preferred over the literal fallback, because the whole
 * defect is a consequence of *which* names that pattern matches.
 * @param shipped - the module's `SENSITIVE_ENV_PATTERN`, when it could be read.
 * @param prefix - the module's `DSH_ENV_PREFIX`, when it could be read.
 * @returns the predicate plus the provenance of each half.
 */
export function scrubPredicate(shipped, prefix) {
  const pattern = shipped instanceof RegExp
    ? new RegExp(shipped.source, shipped.flags.replace('g', ''))
    : FALLBACK_PATTERN
  const namespace = typeof prefix === 'string' && prefix.length > 0 ? prefix.toUpperCase() : DSH_ENV_PREFIX_DEFAULT
  return {
    isScrubbed: (name) => pattern.test(name) || name.toUpperCase().startsWith(namespace),
    source: shipped instanceof RegExp ? 'module' : 'fallback',
  }
}

/**
 * The channel members that survive the scrub — i.e. what a provider's scrubbed
 * base environment will carry.
 * @param env - the ambient environment to read.
 * @param isScrubbed - the scrub predicate.
 * @returns the surviving channel members.
 */
export function survivingMembers(env, isScrubbed) {
  const out = {}
  for (const name of Object.keys(env ?? {})) {
    const value = env[name]
    if (value === undefined || !isFamilyName(name)) continue
    if (isScrubbed(name)) continue
    out[name] = value
  }
  return out
}

/**
 * Resolve the environment a child will actually receive for one spawn: the
 * provider's scrubbed base, then the caller's explicit layer on top, where an
 * explicit `undefined` is a tombstone rather than a value.
 * @param ambient - the ambient environment (normally `process.env`).
 * @param explicit - the spawn spec's `env`.
 * @param isScrubbed - the scrub predicate.
 * @returns the channel members the child would see.
 */
export function resolveChannel(ambient, explicit, isScrubbed) {
  const resolved = survivingMembers(ambient, isScrubbed)
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (!isFamilyName(name)) continue
    if (value === undefined) delete resolved[name]
    else resolved[name] = value
  }
  return resolved
}
