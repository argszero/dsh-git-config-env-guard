import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import plugin from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('the manifest points at files that exist', () => {
  assert.equal(pkg.name, '@argszero/dsh-git-config-env-guard')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.publishConfig.access, 'public')
  for (const path of [pkg.main, pkg.types, pkg.exports['.'].default, pkg.exports['.'].types, pkg.dsh.bundle.patch]) {
    assert.equal(existsSync(join(root, path)), true, `${path} is missing`)
  }
})

test('the shipped file list is the runtime and nothing else', () => {
  assert.deepEqual(pkg.files, ['lib/**/*.js', 'lib/types/**/*.d.ts', 'cordis.patch.yml', 'README.md', 'LICENSE'])
  for (const path of ['README.md', 'LICENSE', 'cordis.patch.yml', 'lib/index.js', 'lib/guard.js', 'lib/group.js', 'lib/scrub.js']) {
    assert.equal(existsSync(join(root, path)), true, `${path} is missing`)
  }
})

test('there are no runtime dependencies', () => {
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.optionalDependencies, undefined)
  assert.deepEqual(Object.keys(pkg.peerDependencies), ['@deepseek-ai/cordis', '@deepseek-ai/dsh-subprocess'])
})

test('the bundle overlay is a top-level array of loader patch entries', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const body = patch.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  assert.equal(body[0], '- insert:', 'a `plugins:` mapping is not an overlay and is rejected on install')
  assert.match(patch, new RegExp(`^      name: '${pkg.name.replaceAll('/', '\\/')}'$`, 'mu'))
})

test('the loader contract is exactly name, inject and apply', () => {
  assert.deepEqual(Object.keys(plugin).sort(), ['apply', 'inject', 'name'])
  assert.equal(Object.hasOwn(plugin, 'Config'), false)
})

test('nothing in the published entry reaches for a built-in the sandbox would refuse', () => {
  for (const file of ['index.js', 'guard.js', 'group.js', 'scrub.js']) {
    const source = readFileSync(join(root, 'lib', file), 'utf8')
    assert.equal(/from 'node:/.test(source), false, `${file} imports a built-in`)
    assert.equal(/require\(/.test(source), false, `${file} uses require`)
  }
})

test('the install line names the version the manifest declares, and that version is a git tag', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const lines = readme.split('\n').filter((line) => line.includes('dsh plugin') && line.includes('add '))
  assert.ok(lines.length > 0, 'the README carries no install command at all')

  for (const line of lines) {
    // A spec without a ref resolves to whatever the branch head is on the day it
    // runs, so two readers following one page get two different trees.
    const pinned = /github:argszero\/dsh-git-config-env-guard#(v\d+\.\d+\.\d+)/.exec(line)
    assert.ok(pinned, `the install line names no tag: ${line.trim()}`)
    assert.equal(pinned[1], `v${pkg.version}`, `${pinned[1]} is not the version this tree declares (${pkg.version})`)
  }
})
