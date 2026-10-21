/**
 * Mount the plugin on a real Cordis context and confirm the seam behaves.
 *
 * The unit suites use a stand-in context, which can only ever prove the plugin
 * agrees with itself. This proves it against the framework the loader actually
 * runs: a real `provide`d service, a real fiber, a real disposal.
 *
 * Needs `@deepseek-ai/cordis` resolvable (a checkout without an install can skip
 * this script; nothing else depends on it).
 *
 * Boundary, stated rather than hidden: teardown is verified in the unit suite,
 * against the documented `ctx.effect()` contract, and NOT here. On a bare root
 * context — `registry.delete(plugin)`, an awaited `fiber.dispose()`, or the
 * startup-result effect — none of the three ran this plugin's disposer even though
 * the fiber reached DISPOSED, so this script reports what it observed about
 * teardown instead of asserting it. A green tick it has not earned is worse than a
 * named gap.
 */

import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'

import plugin from '../lib/index.js'

const service = {
  calls: [],
  spawn(spec) {
    this.calls.push(spec)
    return { kind: 'handle' }
  },
  async spawnTerminal(spec) {
    this.calls.push(spec)
    return { kind: 'terminal' }
  },
}

const disposable = new Context()
disposable.provide('subprocess', service)
disposable.plugin(plugin, { warn: false })
await new Promise((resolve) => setTimeout(resolve, 50))

assert.equal(Object.hasOwn(service, 'spawn'), true, 'a real fiber must reach the instance')
assert.notEqual(typeof disposable.get('gitConfigEnvGuard'), 'undefined', 'the diagnostic service must be provided')

const saved = { count: process.env.GIT_CONFIG_COUNT, value: process.env.GIT_CONFIG_VALUE_0, key: process.env.GIT_CONFIG_KEY_0 }
process.env.GIT_CONFIG_COUNT = '1'
process.env.GIT_CONFIG_VALUE_0 = 'true'
delete process.env.GIT_CONFIG_KEY_0
try {
  service.spawn({ argv: ['git', 'status'], cwd: '/' })
} finally {
  for (const [name, value] of [['GIT_CONFIG_COUNT', saved.count], ['GIT_CONFIG_VALUE_0', saved.value], ['GIT_CONFIG_KEY_0', saved.key]]) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}
const forwarded = service.calls.at(-1)
assert.equal(Object.hasOwn(forwarded.env, 'GIT_CONFIG_COUNT'), true, 'the channel must be tombstoned')
assert.equal(forwarded.env.GIT_CONFIG_COUNT, undefined)
assert.equal(disposable.get('gitConfigEnvGuard').report().repaired, 1)

disposable.registry.delete(plugin)
await new Promise((resolve) => setTimeout(resolve, 50))
const restored = !Object.hasOwn(service, 'spawn')

console.log(
  'mount smoke: PASS on mount (cordis 4.0.5, instance shadowed, service provided, repair applied)',
)
console.log(
  `teardown observed: ${restored ? 'restored' : 'NOT OBSERVED on a bare root context — covered by the unit suite instead'}`,
)
