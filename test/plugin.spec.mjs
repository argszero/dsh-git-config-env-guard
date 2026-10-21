import assert from 'node:assert/strict'
import test from 'node:test'

import plugin, { apply, inject, name, normaliseConfig } from '../lib/index.js'
import { GUARD_MARKER } from '../lib/guard.js'
import { makeCtx, makeService, withEnv } from './harness.mjs'

const HOSTILE = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_0: undefined }

test('the default export is the loader contract and carries no plain-object Config', () => {
  assert.deepEqual(Object.keys(plugin).sort(), ['apply', 'inject', 'name'])
  assert.equal(Object.hasOwn(plugin, 'Config'), false, 'a plain-object Config breaks the standard-schema contract')
  assert.equal(name, 'git-config-env-guard')
  assert.deepEqual(inject, ['subprocess'])
  assert.equal(plugin.apply, apply)
})

test('configuration is refused rather than defaulted', () => {
  assert.deepEqual(normaliseConfig(undefined), { mode: 'repair', warn: true })
  assert.deepEqual(normaliseConfig({}), { mode: 'repair', warn: true })
  assert.deepEqual(normaliseConfig({ mode: 'drop', warn: false }), { mode: 'drop', warn: false })
  assert.throws(() => normaliseConfig({ mode: 'fix' }), /mode must be one of/)
  assert.throws(() => normaliseConfig({ mode: 1 }), /mode must be one of/)
  assert.throws(() => normaliseConfig({ warn: 'yes' }), /warn must be a boolean/)
  assert.throws(() => normaliseConfig([]), /config must be an object/)
})

test('mounting shadows the instance and publishes the report', async () => {
  const service = makeService()
  const ctx = makeCtx(service)
  apply(ctx, {})
  assert.equal(Object.hasOwn(service, 'spawn'), true)
  assert.equal(service[GUARD_MARKER], true)
  const api = ctx.provided.get('gitConfigEnvGuard')
  assert.equal(typeof api.report, 'function')
  assert.equal(api.scrubSource, 'module')
  assert.equal(api.report().mode, 'repair')
})

test('a mounted guard repairs the spawn it forwards', () => {
  const service = makeService()
  const ctx = makeCtx(service)
  apply(ctx, { warn: false })
  return withEnv(HOSTILE, () => {
    service.spawn({ argv: ['git', 'status'], cwd: '/', env: { PATH: '/usr/bin' } })
    const forwarded = service.calls.at(-1)
    assert.equal(forwarded.env.GIT_CONFIG_COUNT, undefined)
    assert.equal(forwarded.env.GIT_CONFIG_VALUE_0, undefined)
    assert.equal(forwarded.env.PATH, '/usr/bin', 'the rest of the explicit layer is untouched')
    assert.equal(ctx.provided.get('gitConfigEnvGuard').report().repaired, 1)
  })
})

test('the warning names the missing member and the responsible rule', () => {
  const service = makeService()
  const ctx = makeCtx(service)
  apply(ctx, {})
  return withEnv(HOSTILE, () => {
    service.spawn({ argv: ['git', 'status'], cwd: '/' })
    assert.equal(ctx.warnings.length, 1)
    assert.match(ctx.warnings[0], /missing GIT_CONFIG_KEY_0/)
    assert.match(ctx.warnings[0], /GIT_CONFIG_KEY_<n> but keeps GIT_CONFIG_COUNT/)
    service.spawn({ argv: ['git', 'status'], cwd: '/' })
    assert.equal(ctx.warnings.length, 1, 'a second repair in the same state must not warn again')
  })
})

test('the warning can be turned off without turning the repair off', async () => {
  const service = makeService()
  const ctx = makeCtx(service)
  apply(ctx, { warn: false })
  await withEnv(HOSTILE, () => {
    service.spawn({ argv: ['git'], cwd: '/' })
  })
  assert.equal(ctx.warnings.length, 0)
  assert.equal(ctx.provided.get('gitConfigEnvGuard').report().repaired, 1)
})

test('off mode touches nothing at all', () => {
  const service = makeService()
  const ctx = makeCtx(service)
  apply(ctx, { mode: 'off' })
  assert.equal(Object.hasOwn(service, 'spawn'), false)
  assert.equal(ctx.provided.size, 0)
  assert.equal(ctx.warnings.length, 0)
})

test('report mode publishes counters and leaves every spawn alone', () => {
  const service = makeService()
  const ctx = makeCtx(service)
  apply(ctx, { mode: 'report', warn: false })
  return withEnv(HOSTILE, () => {
    const spec = { argv: ['git'], cwd: '/' }
    service.spawn(spec)
    assert.equal(service.calls.at(-1), spec)
    const snapshot = ctx.provided.get('gitConfigEnvGuard').report()
    assert.equal(snapshot.mode, 'report')
    assert.equal(snapshot.byShape.orphaned, 1)
    assert.equal(snapshot.repaired, 0)
  })
})

test('unmounting puts the provider back to its shipped shape', async () => {
  const service = makeService()
  const ctx = makeCtx(service)
  apply(ctx, {})
  assert.equal(Object.hasOwn(service, 'spawn'), true)
  await ctx.dispose()
  assert.equal(Object.hasOwn(service, 'spawn'), false)
  assert.equal(service[GUARD_MARKER], undefined)
  const spec = { argv: ['git'], cwd: '/' }
  service.spawn(spec)
  assert.equal(service.calls.at(-1), spec)
})

test('a context without the service fails loud', () => {
  const ctx = makeCtx(undefined)
  assert.throws(() => apply(ctx, {}), /no subprocess service to guard/)
})

test('a context that cannot provide a service still gets the repair', () => {
  const service = makeService()
  const ctx = makeCtx(service)
  ctx.provide = () => {
    throw new Error('cannot provide property "gitConfigEnvGuard" without provide')
  }
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(service[GUARD_MARKER], true)
})
