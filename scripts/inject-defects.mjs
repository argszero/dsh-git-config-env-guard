/**
 * Inject one defect at a time and require the suite to notice.
 *
 * Three outcomes, and only one of them is good:
 *   CAUGHT       the suite failed — the defect is covered
 *   NO-OP        the suite stayed green — either the defect is unreachable or the
 *                suite does not cover it; both need a human, so neither may be
 *                silently counted as a pass
 *   UNBUILDABLE  the anchor did not match, so nothing was injected. Counting this
 *                as CAUGHT is how a harness reports coverage it never exercised.
 */

import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)

/** Everything a run needs in its own directory, including the packaged files the packaging spec asserts. */
const COPY = ['lib', 'test', 'node_modules', 'package.json', 'README.md', 'LICENSE', 'cordis.patch.yml']
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** One injected defect. */
const ARMS = [
  {
    name: 'group: accept a negative counter',
    file: 'lib/group.js',
    find: "/^(?:0|[1-9]\\d*)$/u.test(rawCount)",
    replace: "/^-?\\d+$/u.test(rawCount)",
  },
  {
    name: 'group: stop reporting a missing key',
    file: 'lib/group.js',
    find: 'if (!Object.hasOwn(env, `GIT_CONFIG_KEY_${index}`)) missing.push(`GIT_CONFIG_KEY_${index}`)',
    replace: 'if (false) missing.push(`GIT_CONFIG_KEY_${index}`)',
  },
  {
    name: 'group: stop reporting a missing value',
    file: 'lib/group.js',
    find: 'if (!Object.hasOwn(env, `GIT_CONFIG_VALUE_${index}`)) missing.push(`GIT_CONFIG_VALUE_${index}`)',
    replace: 'if (false) missing.push(`GIT_CONFIG_VALUE_${index}`)',
  },
  {
    name: 'group: walk an unbounded counter',
    file: 'lib/group.js',
    find: 'export const MAX_COUNT = 4096',
    replace: 'export const MAX_COUNT = 1e9',
  },
  {
    name: 'group: never report trailing pairs',
    file: 'lib/group.js',
    find: 'const trailing = names.filter((name) => {',
    replace: 'const trailing = [].filter((name) => {',
  },
  {
    name: 'group: let the legacy spelling into the tombstone set',
    file: 'lib/group.js',
    find: "    if (name === 'GIT_CONFIG_PARAMETERS') continue\n",
    replace: '',
  },
  {
    name: 'group: widen the family to GIT_CONFIG_GLOBAL',
    file: 'lib/group.js',
    find: '/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\\d+|VALUE_\\d+)$/u',
    replace: '/^GIT_CONFIG_(?:COUNT|PARAMETERS|GLOBAL|KEY_\\d+|VALUE_\\d+)$/u',
  },
  {
    name: 'scrub: keep every channel member through the scrub',
    file: 'lib/scrub.js',
    find: '    if (isScrubbed(name)) continue\n',
    replace: '',
  },
  {
    name: 'scrub: treat an explicit tombstone as a value',
    file: 'lib/scrub.js',
    find: '    if (value === undefined) delete resolved[name]\n',
    replace: '    if (value === undefined) resolved[name] = value\n',
  },
  {
    name: 'scrub: let a global-flagged pattern alternate its answer',
    file: 'lib/scrub.js',
    find: "new RegExp(shipped.source, shipped.flags.replace('g', ''))",
    replace: 'shipped',
  },
  {
    name: 'scrub: claim the shipped rule without reading it',
    file: 'lib/scrub.js',
    find: "source: shipped instanceof RegExp ? 'module' : 'fallback',",
    replace: "source: 'module',",
  },
  {
    name: 'guard: stop repairing the orphaned shape',
    file: 'lib/guard.js',
    find: "const act = verdict.shape === 'orphaned'",
    replace: "const act = verdict.shape === 'nonexistent'",
  },
  {
    name: 'guard: resolve an environment with no channel in it',
    file: 'lib/guard.js',
    find: '      if (!ambientHas && !hasChannel(explicit)) return spec\n',
    replace: '',
  },
  {
    name: 'guard: let a judgement failure reach the caller',
    file: 'lib/guard.js',
    find: '      counters.failed += 1\n      remember({ at: now(), shape: \'error\', message: String(error?.message ?? error), acted: false })\n      return spec',
    replace: '      counters.failed += 1\n      throw error',
  },
  {
    name: 'guard: freeze a copy of a prototype method instead of deleting the shadow',
    file: 'lib/guard.js',
    find: '    else delete impl.spawn\n',
    replace: '    else impl.spawn = originalSpawn\n',
  },
  {
    name: 'guard: stack a second shadow instead of refusing it',
    file: 'lib/guard.js',
    find: "if (impl[GUARD_MARKER] === true) throw new Error('git-config-env-guard: the subprocess instance is already guarded')\n",
    replace: '',
  },
  {
    name: 'guard: drop an intact channel the caller supplied',
    file: 'lib/guard.js',
    find: "        || (mode === 'drop' && verdict.shape === 'intact' && explicitVerdict.shape !== 'intact')",
    replace: "        || (mode === 'drop' && verdict.shape === 'intact')",
  },
  {
    name: 'plugin: warn on every repair instead of once per shape',
    file: 'lib/index.js',
    find: '!warned.has(latest.shape)',
    replace: 'true',
  },
  {
    name: 'plugin: mount even in off mode',
    file: 'lib/index.js',
    find: "  if (settings.mode === 'off') return\n",
    replace: '',
  },
  {
    name: 'plugin: judge with the bundled fallback instead of the shipped rule',
    file: 'lib/index.js',
    find: 'scrubPredicate(SENSITIVE_ENV_PATTERN, DSH_ENV_PREFIX)',
    replace: 'scrubPredicate(undefined, undefined)',
  },
  {
    name: 'plugin: let a refused provide break the mount',
    file: 'lib/index.js',
    find: "  try {\n    ctx.provide('gitConfigEnvGuard', { report, scrubSource: source })\n  } catch {\n    // The diagnostic surface is optional; the repair is not.\n  }",
    replace: "  ctx.provide('gitConfigEnvGuard', { report, scrubSource: source })",
  },
  {
    name: 'plugin: default an unknown mode instead of refusing it',
    file: 'lib/index.js',
    find: "  if (typeof mode !== 'string' || !MODES.has(mode)) {",
    replace: '  if (false) {',
  },
]

const work = await mkdtemp(join(tmpdir(), 'git-config-env-guard-arms-'))
const results = []
try {
  for (const entry of [...COPY]) {
    await cp(join(root, entry), join(work, entry), { recursive: true })
  }
  const specFiles = ['group', 'guard', 'plugin', 'integration', 'packaging'].map((name) => `test/${name}.spec.mjs`)

  for (const arm of ARMS) {
    const file = join(work, arm.file)
    const original = await readFile(file, 'utf8')
    if (!original.includes(arm.find)) {
      results.push({ name: arm.name, outcome: 'UNBUILDABLE' })
      continue
    }
    await writeFile(file, original.replace(arm.find, arm.replace))
    let failed = false
    let detail = ''
    try {
      await run(process.execPath, ['--test', ...specFiles], { cwd: work, timeout: 120_000 })
    } catch (error) {
      // Any rejection is a failure: a non-zero exit, a timeout, or a spawn error.
      failed = true
      detail = String(error.code ?? error.signal ?? 'failed')
    }
    await writeFile(file, original)
    results.push({ name: arm.name, outcome: failed ? 'CAUGHT' : 'NO-OP', detail })
  }
} finally {
  await rm(work, { recursive: true, force: true })
}

// Control: an unmutated copy must be green, or every CAUGHT above means nothing.
let control = 'GREEN'
const controlDir = await mkdtemp(join(tmpdir(), 'git-config-env-guard-control-'))
try {
  for (const entry of [...COPY]) {
    await cp(join(root, entry), join(controlDir, entry), { recursive: true })
  }
  const specFiles = ['group', 'guard', 'plugin', 'integration', 'packaging'].map((name) => `test/${name}.spec.mjs`)
  try {
    await run(process.execPath, ['--test', ...specFiles], { cwd: controlDir, timeout: 120_000 })
  } catch {
    control = 'RED'
  }
} finally {
  await rm(controlDir, { recursive: true, force: true })
}

const width = Math.max(...results.map((entry) => entry.name.length))
for (const entry of results) console.log(`${entry.outcome.padEnd(12)} ${entry.name.padEnd(width)}`)
const caught = results.filter((entry) => entry.outcome === 'CAUGHT').length
const noop = results.filter((entry) => entry.outcome === 'NO-OP').length
const unbuildable = results.filter((entry) => entry.outcome === 'UNBUILDABLE').length
console.log(`\ncontrol: ${control}`)
console.log(`arms: ${results.length}  CAUGHT: ${caught}  NO-OP: ${noop}  UNBUILDABLE: ${unbuildable}`)
if (control !== 'GREEN') console.log('CONTROL IS RED — no verdict above is trustworthy')
process.exitCode = control === 'GREEN' && noop === 0 && unbuildable === 0 ? 0 : 1
