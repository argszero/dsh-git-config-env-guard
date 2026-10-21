/**
 * Give the test run something to resolve `@deepseek-ai/dsh-subprocess` to.
 *
 * The plugin reads that package's two public exports instead of copying them, so
 * its judgement tracks the shipped rule. The package itself is a peer — present in
 * every install that can mount this bundle — and a repository checkout has it only
 * after an install, which these tests must not require. This writes a minimal
 * stand-in carrying exactly the two exports, and nothing else: a stand-in that grew
 * a `subprocess` service would start lying about the package it stands for.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'node_modules', '@deepseek-ai', 'dsh-subprocess')

await mkdir(target, { recursive: true })
await writeFile(join(target, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-subprocess',
  version: '0.0.0-test-standing',
  type: 'module',
  exports: { '.': './index.js' },
}, null, 2))
await writeFile(join(target, 'index.js'), [
  '// Stand-in for @deepseek-ai/dsh-subprocess: the two public exports this plugin reads.',
  "export const DSH_ENV_PREFIX = 'DSH_'",
  'export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i',
  '',
].join('\n'))
console.log(`test stand-in written: ${target}`)
