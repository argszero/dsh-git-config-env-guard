/**
 * The witness that this is about git and not about strings: real `git status`
 * children, fed the environment the harness's own scrub produces.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { promisify } from 'node:util'

import { createRepair, shadowInstance } from '../lib/guard.js'
import { scrubPredicate, survivingMembers } from '../lib/scrub.js'
import { makeService, temporaryDirectory, withEnv } from './harness.mjs'

const run = promisify(execFile)
const scrub = scrubPredicate(new RegExp('KEY|PASSWORD|SECRET|TOKEN', 'i'), 'DSH_')

/** Whether this machine has a git to measure against. */
const hasGit = await run('git', ['--version']).then(() => true, () => false)

/**
 * A provider that builds its child environment the way the shipped one does:
 * the scrubbed parent base, then the caller's explicit layer, `undefined` meaning
 * "remove this ambient name".
 * @returns the service and the environments it actually produced.
 */
function mimicProvider() {
  const produced = []
  class Mimic {
    spawn(spec) {
      const env = { ...survivingMembers(process.env, scrub.isScrubbed) }
      for (const [key, value] of Object.entries(spec.env ?? {})) {
        if (value === undefined) delete env[key]
        else env[key] = value
      }
      produced.push(env)
      return { env }
    }

    async spawnTerminal(spec) {
      return this.spawn(spec)
    }
  }
  return { service: new Mimic(), produced }
}

/**
 * Run `git status --porcelain` with exactly the environment a spawn was handed.
 * @param env - the child environment.
 * @param cwd - a repository.
 * @returns exit code and stderr, never throwing.
 */
async function gitStatus(env, cwd) {
  try {
    const result = await run('git', ['status', '--porcelain'], {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...env },
    })
    return { code: 0, stderr: result.stderr }
  } catch (error) {
    return { code: error.code ?? -1, stderr: String(error.stderr ?? '') }
  }
}

test('the scrub alone breaks every git child; the guard restores it', { skip: !hasGit }, async () => {
  const { path, cleanup } = temporaryDirectory()
  try {
    await run('git', ['init', '-q', '.'], { cwd: path })
    await run('git', ['config', 'user.email', 'guard@example.invalid'], { cwd: path })
    await run('git', ['config', 'user.name', 'guard'], { cwd: path })
    await run('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: path })

    await withEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_0: undefined }, async () => {
      // Control: the environment the scrub builds, with no guard in the way.
      const bare = mimicProvider()
      bare.service.spawn({ argv: ['git', 'status'], cwd: path })
      const broken = await gitStatus(bare.produced[0], path)
      assert.equal(broken.code, 128, 'git must refuse the orphaned channel')
      assert.match(broken.stderr, /missing config key GIT_CONFIG_KEY_0/)

      // The same provider, guarded.
      const guarded = mimicProvider()
      const repair = createRepair({ mode: 'repair', ambient: () => process.env, isScrubbed: scrub.isScrubbed, now: () => 'now' }).repair
      const restore = shadowInstance(guarded.service, repair)
      guarded.service.spawn({ argv: ['git', 'status'], cwd: path })
      restore()
      const fixed = await gitStatus(guarded.produced[0], path)
      assert.equal(fixed.code, 0, `git must run; stderr was ${fixed.stderr}`)
      assert.equal(guarded.produced[0].GIT_CONFIG_COUNT, undefined)
    })
  } finally {
    cleanup()
  }
})

test('a complete group the caller supplies still reaches git', { skip: !hasGit }, async () => {
  const { path, cleanup } = temporaryDirectory()
  try {
    await run('git', ['init', '-q', '.'], { cwd: path })
    const guarded = mimicProvider()
    const repair = createRepair({ mode: 'repair', ambient: () => process.env, isScrubbed: scrub.isScrubbed, now: () => 'now' }).repair
    const restore = shadowInstance(guarded.service, repair)
    guarded.service.spawn({
      argv: ['git', 'config', '--get', 'guard.probe'],
      cwd: path,
      env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'guard.probe', GIT_CONFIG_VALUE_0: 'kept' },
    })
    restore()
    const { stdout } = await run('git', ['config', '--get', 'guard.probe'], {
      cwd: path,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...guarded.produced[0] },
    })
    assert.equal(stdout.trim(), 'kept', 'the guard must not discard a channel the caller made whole')
  } finally {
    cleanup()
  }
})

test('the terminal path is guarded by the same judgement', { skip: !hasGit }, async () => {
  const service = makeService()
  const repair = createRepair({ mode: 'repair', ambient: () => process.env, isScrubbed: scrub.isScrubbed, now: () => 'now' }).repair
  const restore = shadowInstance(service, repair)
  await withEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_0: undefined }, async () => {
    await service.spawnTerminal({ argv: ['bash'], cwd: '/', env: { PATH: '/usr/bin' } })
  })
  restore()
  assert.equal(service.terminals.at(-1).env.GIT_CONFIG_COUNT, undefined)
})
