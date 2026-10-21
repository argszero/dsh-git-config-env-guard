import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_COUNT, classify, familyNames, isFamilyName, tombstones } from '../lib/group.js'
import { survivingMembers, resolveChannel, scrubPredicate } from '../lib/scrub.js'

const scrub = scrubPredicate(new RegExp('KEY|PASSWORD|SECRET|TOKEN', 'i'), 'DSH_')

test('family names are exactly the channel and nothing near it', () => {
  for (const name of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_12']) {
    assert.equal(isFamilyName(name), true, name)
  }
  for (const name of ['GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_KEY', 'GIT_CONFIG_KEY_', 'git_config_key_0', 'GIT_CONFIG_COUNT_X']) {
    assert.equal(isFamilyName(name), false, name)
  }
})

test('an absent channel is absent, not inert', () => {
  assert.equal(classify({}).shape, 'absent')
  assert.equal(classify({ PATH: '/usr/bin' }).shape, 'absent')
})

test('the reported defect: counter without its key is orphaned', () => {
  const verdict = classify({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'true' })
  assert.equal(verdict.shape, 'orphaned')
  assert.equal(verdict.count, 1)
  assert.deepEqual(verdict.missing, ['GIT_CONFIG_KEY_0'])
})

test('a key without its value is orphaned too (measured: exit 128)', () => {
  const verdict = classify({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager' })
  assert.equal(verdict.shape, 'orphaned')
  assert.deepEqual(verdict.missing, ['GIT_CONFIG_VALUE_0'])
})

test('every missing index is named, not only the first', () => {
  const verdict = classify({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' })
  assert.equal(verdict.shape, 'orphaned')
  assert.deepEqual(verdict.missing, ['GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1'])
})

test('a complete group is intact, an empty value included', () => {
  assert.equal(classify({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' }).shape, 'intact')
  assert.equal(classify({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '' }).shape, 'intact')
  assert.equal(classify({ GIT_CONFIG_COUNT: '0' }).shape, 'intact')
})

test('stray members without the counter are inert, never acted on', () => {
  assert.equal(classify({ GIT_CONFIG_VALUE_0: 'true' }).shape, 'inert')
  assert.equal(classify({ GIT_CONFIG_KEY_0: 'a.b' }).shape, 'inert')
  assert.equal(classify({ GIT_CONFIG_PARAMETERS: "'a.b=c'" }).shape, 'inert')
})

test('pairs past the counter are reported as trailing and do not change the shape', () => {
  const verdict = classify({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c', GIT_CONFIG_VALUE_9: 'x' })
  assert.equal(verdict.shape, 'intact')
  assert.deepEqual(verdict.trailing, ['GIT_CONFIG_VALUE_9'])
})

test('a counter git cannot parse is malformed, with the reason named', () => {
  for (const value of ['abc', '-1', '1.0', ' 1', '0x10', '']) {
    const verdict = classify({ GIT_CONFIG_COUNT: value })
    assert.equal(verdict.shape, 'malformed', JSON.stringify(value))
    assert.equal(verdict.reason, 'count-not-a-number', JSON.stringify(value))
  }
})

test('an absurd counter is refused before it is walked', () => {
  const verdict = classify({ GIT_CONFIG_COUNT: String(MAX_COUNT + 1) })
  assert.equal(verdict.shape, 'malformed')
  assert.equal(verdict.reason, 'count-too-large')
  assert.equal(classify({ GIT_CONFIG_COUNT: String(MAX_COUNT) }).shape, 'orphaned')
})

test('tombstones remove the whole channel but leave the legacy spelling alone', () => {
  const drop = tombstones({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'a.b',
    GIT_CONFIG_VALUE_0: 'c',
    GIT_CONFIG_PARAMETERS: "'x.y=1'",
    GIT_CONFIG_GLOBAL: '/tmp/x',
    PATH: '/usr/bin',
  })
  assert.deepEqual(Object.keys(drop).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'])
  assert.equal(Object.values(drop).every((value) => value === undefined), true)
})

test('familyNames is stable and sorted', () => {
  assert.deepEqual(familyNames({ GIT_CONFIG_VALUE_0: 'a', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'b' }),
    ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'])
  assert.deepEqual(familyNames(undefined), [])
})

test('the shipped rule removes the key and keeps the counter — the defect, reproduced', () => {
  const survivors = survivingMembers({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.pager',
    GIT_CONFIG_VALUE_0: 'cat',
    PATH: '/usr/bin',
  }, scrub.isScrubbed)
  assert.deepEqual(Object.keys(survivors).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_VALUE_0'])
  assert.equal(classify(survivors).shape, 'orphaned')
})

test('an explicit layer overrides the base, and undefined removes a member', () => {
  const ambient = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' }
  assert.equal(classify(resolveChannel(ambient, {}, scrub.isScrubbed)).shape, 'orphaned')
  const restored = resolveChannel(ambient, { GIT_CONFIG_KEY_0: 'a.b' }, scrub.isScrubbed)
  assert.equal(classify(restored).shape, 'intact')
  const cleared = resolveChannel(ambient, { GIT_CONFIG_COUNT: undefined }, scrub.isScrubbed)
  assert.equal(classify(cleared).shape, 'inert')
  // A tombstone must remove the name, not leave it holding an undefined value: the
  // channel membership is what the rest of this plugin reports and acts on.
  assert.deepEqual(familyNames(cleared), ['GIT_CONFIG_VALUE_0'])
})

test('the predicate keeps its provenance, so a drifted copy cannot pass as the shipped rule', () => {
  assert.equal(scrub.source, 'module')
  assert.equal(scrubPredicate(undefined, undefined).source, 'fallback')
  assert.equal(scrubPredicate(new RegExp('nothing', 'g'), '').isScrubbed('KEY_0'), false)
  // One predicate, asked twice: a `g`-flagged pattern carries `lastIndex` between
  // calls, so cloning the shipped rule without stripping the flag would answer
  // false on every second name.
  const global = scrubPredicate(new RegExp('KEY', 'gi'), undefined)
  assert.equal(global.isScrubbed('GIT_CONFIG_KEY_0'), true)
  assert.equal(global.isScrubbed('GIT_CONFIG_KEY_0'), true, 'a global-flagged pattern must not alternate its answer')
})
