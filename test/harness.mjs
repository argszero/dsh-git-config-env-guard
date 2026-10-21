/** Shared fixtures: a subprocess service with prototype methods, and a minimal context. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A subprocess service whose methods live on the prototype, the way the shipped
 * provider's do — which is what makes "restore" mean `delete`, not reassign.
 * @returns a fresh service instance recording every spec it is handed.
 */
export function makeService() {
  class FakeSubprocess {
    constructor() {
      this.calls = []
      this.terminals = []
    }

    spawn(spec) {
      this.calls.push(spec)
      return { kind: 'handle', spec }
    }

    async spawnTerminal(spec) {
      this.terminals.push(spec)
      return { kind: 'terminal', spec }
    }
  }
  return new FakeSubprocess()
}

/**
 * The smallest context the plugin touches.
 * @param impl - what `ctx.get('subprocess')` should answer with.
 * @returns the context, its disposers, and the services it was asked to provide.
 */
export function makeCtx(impl) {
  const provided = new Map()
  const disposers = []
  const warnings = []
  return {
    get: (name) => (name === 'subprocess' ? impl : undefined),
    provide: (name, value) => {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    effect: (execute) => {
      const disposer = execute()
      disposers.push(disposer)
      return disposer
    },
    logger: { warn: (message) => warnings.push(message) },
    provided,
    warnings,
    async dispose() {
      while (disposers.length > 0) await disposers.pop()?.()
    },
  }
}

/**
 * Run a body with specific environment names set, restoring the previous state.
 * @param names - name to value (`undefined` removes) to apply for the body.
 * @param body - the work to run while they are in place.
 * @returns whatever the body returns.
 */
export async function withEnv(names, body) {
  const saved = new Map()
  for (const [name, value] of Object.entries(names)) {
    saved.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return await body()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/**
 * An empty temporary directory that removes itself.
 * @returns the path and a cleanup function.
 */
export function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'git-config-env-guard-'))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}
