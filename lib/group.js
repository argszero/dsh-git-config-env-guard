/**
 * Git's command-line configuration is one environment channel spelled as several
 * variables: `GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`
 * for `0 <= n < COUNT`. `GIT_CONFIG_PARAMETERS` is a second, single-variable
 * spelling of the same thing and is atomic by construction.
 *
 * Measured on git 2.50.1 (Apple Git-155), each shape run as `git status` in an
 * ordinary repository:
 *
 *   COUNT absent, stray VALUE_0 present              exit 0    (inert)
 *   COUNT=1, KEY_0 and VALUE_0 present               exit 0    (intact)
 *   COUNT=1, KEY_0 and empty VALUE_0 present         exit 0    (intact)
 *   COUNT=1, VALUE_0 present, KEY_0 absent           exit 128  missing config key GIT_CONFIG_KEY_0
 *   COUNT=1, KEY_0 present, VALUE_0 absent           exit 128  missing config value GIT_CONFIG_VALUE_0
 *   COUNT=2, only index 0 present                    exit 128  missing config key GIT_CONFIG_KEY_1
 *   COUNT not a non-negative integer                 exit 128  bogus count in GIT_CONFIG_COUNT
 *   GIT_CONFIG_PARAMETERS only                       exit 0    (a channel of its own)
 *
 * So the channel has exactly one legal intermediate state — complete, or absent —
 * and every other state is fatal for *every* git child, not merely for the call
 * that set it.
 */

/** One name of Git's command-line-configuration channel. */
export const FAMILY_NAME = /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/u

/**
 * Largest `GIT_CONFIG_COUNT` this plugin will walk. A count is read from the
 * ambient environment, so a hostile or broken value must not turn one spawn into
 * an unbounded loop; real invocations carry a handful of `-c` arguments.
 */
export const MAX_COUNT = 4096

/**
 * Whether a name belongs to Git's command-line-configuration channel.
 * @param name - the environment variable name.
 * @returns true for the counter, the key/value pairs and the legacy spelling.
 */
export function isFamilyName(name) {
  return FAMILY_NAME.test(name)
}

/**
 * The channel members present in an environment, in a stable order.
 * @param env - any environment-shaped object.
 * @returns the family names present, sorted.
 */
export function familyNames(env) {
  if (!env) return []
  return Object.keys(env).filter(isFamilyName).sort()
}

/**
 * Classify the channel inside one already-resolved environment.
 *
 * The input is the environment a child would actually receive, with tombstones
 * already applied — this function judges, it does not resolve.
 * @param env - the resolved child environment.
 * @returns the shape, the count when one is readable, and the specific gaps.
 */
export function classify(env) {
  const names = familyNames(env)
  const rawCount = env ? env.GIT_CONFIG_COUNT : undefined
  if (rawCount === undefined) {
    // Without the counter git never walks the pairs, so any stray member is inert.
    return { shape: names.length === 0 ? 'absent' : 'inert', count: null, missing: [], trailing: [] }
  }
  if (typeof rawCount !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(rawCount)) {
    return { shape: 'malformed', count: null, missing: [], trailing: [], reason: 'count-not-a-number' }
  }
  const count = Number(rawCount)
  if (count > MAX_COUNT) {
    return { shape: 'malformed', count, missing: [], trailing: [], reason: 'count-too-large' }
  }
  const missing = []
  for (let index = 0; index < count; index += 1) {
    if (!Object.hasOwn(env, `GIT_CONFIG_KEY_${index}`)) missing.push(`GIT_CONFIG_KEY_${index}`)
    if (!Object.hasOwn(env, `GIT_CONFIG_VALUE_${index}`)) missing.push(`GIT_CONFIG_VALUE_${index}`)
  }
  if (missing.length > 0) return { shape: 'orphaned', count, missing, trailing: [] }
  // Pairs past the counter are inert (git loops to COUNT); report, never act.
  const trailing = names.filter((name) => {
    const match = /_(?:KEY|VALUE)_(\d+)$/u.exec(name)
    return match !== null && Number(match[1]) >= count
  })
  return { shape: 'intact', count, missing: [], trailing }
}

/**
 * The tombstones that remove the whole channel from a provider's base
 * environment. `undefined` is the documented tombstone a spawn spec uses to drop
 * an ambient entry, so this is a whole-group deletion rather than a filter.
 * @param env - the resolved environment whose channel members should go.
 * @returns name-to-`undefined` entries; `GIT_CONFIG_PARAMETERS` is left alone.
 */
export function tombstones(env) {
  const out = {}
  for (const name of familyNames(env)) {
    if (name === 'GIT_CONFIG_PARAMETERS') continue
    out[name] = undefined
  }
  return out
}
