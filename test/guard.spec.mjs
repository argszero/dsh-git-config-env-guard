import assert from 'node:assert/strict'
import test from 'node:test'

import { GUARD_MARKER, createRepair, hasChannel, shadowInstance } from '../lib/guard.js'
import { scrubPredicate } from '../lib/scrub.js'
import { makeService, withEnv } from './harness.mjs'

const scrub = scrubPredicate(new RegExp('KEY|PASSWORD|SECRET|TOKEN', 'i'), 'DSH_')
const clock = () => '2026-10-22T00:00:00.000Z'

const repairFor = (mode, ambient) => createRepair({ mode, ambient, isScrubbed: scrub.isScrubbed, now: clock })

test('hasChannel sees the channel and nothing else', () => {
  assert.equal(hasChannel({ GIT_CONFIG_COUNT: '1' }), true)
  assert.equal(hasChannel({ GIT_CONFIG_KEY_7: 'a' }), true)
  assert.equal(hasChannel({ GIT_CONFIG_GLOBAL: '/x', PATH: '/' }), false)
  assert.equal(hasChannel(undefined), false)
  assert.equal(hasChannel({}), false)
})

test('a spawn untouched by the channel is forwarded byte-identical and not even examined', () => {
  const { repair, report } = repairFor('repair', { PATH: '/usr/bin' })
  const spec = { argv: ['git', 'status'], cwd: '/', env: { PATH: '/usr/bin' } }
  assert.equal(repair(spec), spec, 'the very same object must come back')
  const snapshot = report()
  assert.equal(snapshot.spawns, 1)
  assert.equal(snapshot.examined, 0, 'the fast path must not resolve an environment it has no use for')
})

test('the reported defect is repaired: the orphaned channel is dropped whole', async () => {
  const { repair, report } = repairFor('repair', () => ({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.pager',
    GIT_CONFIG_VALUE_0: 'cat',
    PATH: '/usr/bin',
  }))
  const spec = { argv: ['git', 'status'], cwd: '/' }
  const forwarded = repair(spec)
  assert.notEqual(forwarded, spec)
  assert.equal(forwarded.env.GIT_CONFIG_COUNT, undefined)
  assert.equal(forwarded.env.GIT_CONFIG_VALUE_0, undefined)
  assert.equal(Object.hasOwn(forwarded.env, 'GIT_CONFIG_COUNT'), true, 'the tombstone must be present, not merely undefined')
  assert.deepEqual(forwarded.argv, ['git', 'status'])
  const snapshot = report()
  assert.equal(snapshot.repaired, 1)
  assert.equal(snapshot.byShape.orphaned, 1)
  assert.equal(snapshot.firstRepairAt, clock())
  assert.deepEqual(snapshot.last.at(-1).dropped, ['GIT_CONFIG_COUNT', 'GIT_CONFIG_VALUE_0'])
})

test('an ambient complete group cannot survive the scrub, so repair mode always drops it', () => {
  // The scrub removes exactly the keys of a complete group, so what the child would
  // have received is orphaned even though the parent's environment was not. That is
  // why `repair` needs no policy of its own for ambient channels.
  const { repair, report } = repairFor('repair', () => ({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.pager',
    GIT_CONFIG_VALUE_0: 'cat',
  }))
  const forwarded = repair({ argv: ['git', 'status'], cwd: '/' })
  assert.equal(forwarded.env.GIT_CONFIG_COUNT, undefined)
  assert.equal(report().byShape.orphaned, 1)
  assert.equal(report().byShape.intact, 0)
})

test('an intact group that reaches the child is left alone in repair mode', () => {
  // The one way a complete group survives is the caller's explicit layer, which the
  // provider merges after the scrub. That is a deliberate opt-in, so repair keeps it.
  const { repair, report } = repairFor('repair', () => ({ PATH: '/usr/bin' }))
  const spec = { argv: ['git'], cwd: '/', env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' } }
  assert.equal(repair(spec), spec, 'the very same object must come back')
  assert.equal(report().byShape.intact, 1)
  assert.equal(report().repaired, 0)
})

test('drop mode removes an intact ambient group but keeps one the caller supplied', () => {
  const ambient = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' }
  const { repair } = repairFor('drop', () => ambient)
  const dropped = repair({ argv: ['git'], cwd: '/' })
  assert.equal(dropped.env.GIT_CONFIG_COUNT, undefined)

  const supplied = repair({ argv: ['git'], cwd: '/', env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' } })
  assert.equal(supplied.env.GIT_CONFIG_COUNT, '1', 'an explicit complete group is a deliberate opt-in')
  assert.equal(supplied.env.GIT_CONFIG_KEY_0, 'a.b')
})

test('drop mode also removes an inert stray pair', () => {
  const { repair, report } = repairFor('drop', () => ({ GIT_CONFIG_VALUE_0: 'true' }))
  const forwarded = repair({ argv: ['git'], cwd: '/' })
  assert.equal(Object.hasOwn(forwarded.env, 'GIT_CONFIG_VALUE_0'), true)
  assert.equal(forwarded.env.GIT_CONFIG_VALUE_0, undefined)
  assert.equal(report().byShape.inert, 1)
})

test('report mode judges and never modifies', () => {
  const { repair, report } = repairFor('report', () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'true' }))
  const spec = { argv: ['git'], cwd: '/' }
  assert.equal(repair(spec), spec)
  const snapshot = report()
  assert.equal(snapshot.repaired, 0)
  assert.equal(snapshot.byShape.orphaned, 1)
  assert.equal(snapshot.last.at(-1).acted, false)
})

test('a malformed counter is repaired as well', () => {
  const { repair } = repairFor('repair', () => ({ GIT_CONFIG_COUNT: 'abc' }))
  const forwarded = repair({ argv: ['git'], cwd: '/' })
  assert.equal(forwarded.env.GIT_CONFIG_COUNT, undefined)
})

test('a caller-supplied key completes the group the scrub broke', () => {
  const { repair, report } = repairFor('repair', () => ({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'a.b',
    GIT_CONFIG_VALUE_0: 'c',
  }))
  const spec = { argv: ['git'], cwd: '/', env: { GIT_CONFIG_KEY_0: 'a.b' } }
  assert.equal(repair(spec), spec, 'the caller already made the channel whole')
  assert.equal(report().byShape.intact, 1)
})

test('a throwing judgement forwards the original spec', () => {
  const { repair, report } = repairFor('repair', () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'true' }))
  const spec = { argv: ['git'], cwd: '/', env: { get GIT_CONFIG_COUNT() { throw new Error('boom') } } }
  assert.equal(repair(spec), spec)
  assert.equal(report().failed, 1)
})

test('the report is bounded and independent of its internals', () => {
  const { repair, report } = repairFor('report', () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'true' }))
  for (let index = 0; index < 40; index += 1) repair({ argv: ['git'], cwd: '/' })
  const snapshot = report()
  assert.equal(snapshot.spawns, 40)
  assert.equal(snapshot.last.length, 20)
  snapshot.last[0].shape = 'tampered'
  assert.notEqual(report().last[0].shape, 'tampered')
})

test('shadowing routes every spawn and terminal through the repair, preserving return values', async () => {
  const service = makeService()
  const seen = []
  const restore = shadowInstance(service, (spec) => {
    seen.push(spec)
    return { ...spec, repaired: true }
  })
  const handle = service.spawn({ argv: ['git'], cwd: '/' })
  assert.equal(handle.spec.repaired, true)
  assert.equal(handle.kind, 'handle')
  const terminal = await service.spawnTerminal({ argv: ['bash'], cwd: '/' })
  assert.equal(terminal.spec.repaired, true)
  assert.equal(seen.length, 2)
  restore()
})

test('restoring a prototype method deletes the own property instead of freezing a copy', () => {
  const service = makeService()
  assert.equal(Object.hasOwn(service, 'spawn'), false)
  const restore = shadowInstance(service, (spec) => spec)
  assert.equal(Object.hasOwn(service, 'spawn'), true)
  assert.equal(service[GUARD_MARKER], true)
  restore()
  assert.equal(Object.hasOwn(service, 'spawn'), false, 'the prototype method must be reachable again')
  assert.equal(service[GUARD_MARKER], undefined)
  assert.equal(typeof service.spawn, 'function')
})

test('restoring an own-property method puts the original back', () => {
  const service = makeService()
  const original = function original(spec) { return { kind: 'own', spec } }
  service.spawn = original
  const restore = shadowInstance(service, (spec) => spec)
  assert.notEqual(service.spawn, original)
  restore()
  assert.equal(service.spawn, original)
})

test('a second shadow on the same instance is refused rather than stacked', () => {
  const service = makeService()
  const restore = shadowInstance(service, (spec) => spec)
  assert.throws(() => shadowInstance(service, (spec) => spec), /already guarded/)
  restore()
  assert.doesNotThrow(() => shadowInstance(service, (spec) => spec)())
})

test('shadowing nothing is an error, not a silent no-op', () => {
  assert.throws(() => shadowInstance(undefined, (spec) => spec), /no subprocess service instance/)
  assert.throws(() => shadowInstance(null, (spec) => spec), /no subprocess service instance/)
})

test('the shadow keeps the receiver, so a provider using `this` still works', () => {
  class Counting {
    constructor() { this.count = 0 }
    spawn(spec) { this.count += 1; return spec }
  }
  const service = new Counting()
  const restore = shadowInstance(service, (spec) => spec)
  service.spawn({ argv: [], cwd: '/' })
  assert.equal(service.count, 1)
  restore()
})

test('the ambient environment is read per spawn, so a later change is seen', async () => {
  const { repair, report } = repairFor('repair', () => process.env)
  await withEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_0: undefined }, () => {
    repair({ argv: ['git'], cwd: '/' })
  })
  assert.equal(report().repaired, 1)
  await withEnv({ GIT_CONFIG_COUNT: undefined, GIT_CONFIG_VALUE_0: undefined }, () => {
    repair({ argv: ['git'], cwd: '/' })
  })
  assert.equal(report().repaired, 1, 'with the channel gone there is nothing left to repair')
})
