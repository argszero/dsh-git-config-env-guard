# @argszero/dsh-git-config-env-guard

Keep Git's command-line-configuration channel atomic across the harness's
environment scrub, so a git child started by the agent stops dying before it reads
any configuration at all.

```sh
npm install @argszero/dsh-git-config-env-guard
```

Or mount it as a bundle: the package ships `cordis.patch.yml`, so adding it to a
profile mounts and enables it with no further configuration.

## The defect

`scrubbedParentEnv()` — `packages/subprocess/subprocess/src/index.ts:66` — builds
the base environment every harness child starts from. It copies the ambient
environment minus any variable whose **name** matches

```ts
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i   // :47
```

Git's command-line configuration (`git -c a.b=c …`, and the same channel exported
to hook children) is one setting spelled as several variables:

| variable | meaning |
|---|---|
| `GIT_CONFIG_COUNT` | how many `-c` pairs follow |
| `GIT_CONFIG_KEY_<n>` | the key of pair `n` |
| `GIT_CONFIG_VALUE_<n>` | the value of pair `n` |
| `GIT_CONFIG_PARAMETERS` | the older single-variable spelling of the same thing |

Exactly one of those names contains a word from the credential vocabulary —
`GIT_CONFIG_**KEY**_<n>`. So the scrub deletes the keys, keeps the counter and the
values, and hands the child a counter whose pairs are gone. Git refuses to read
*any* configuration from that state, which means the child fails before it does
anything at all.

Measured with **git 2.50.1 (Apple Git-155)**, each shape run as `git status` in an
ordinary repository:

| environment | exit | message |
|---|---|---|
| channel absent | 0 | — |
| `COUNT=1`, `KEY_0`, `VALUE_0` | 0 | — |
| `COUNT=1`, `KEY_0`, empty `VALUE_0` | 0 | — |
| **`COUNT=1`, `VALUE_0` only — what the scrub produces** | **128** | `error: missing config key GIT_CONFIG_KEY_0` |
| `COUNT=1`, `KEY_0` only | 128 | `error: missing config value GIT_CONFIG_VALUE_0` |
| `COUNT=2`, index 0 only | 128 | `error: missing config key GIT_CONFIG_KEY_1` |
| `COUNT` not a non-negative integer | 128 | `error: bogus count in GIT_CONFIG_COUNT` |
| `GIT_CONFIG_PARAMETERS` only | 0 | — |
| stray `VALUE_0`, no `COUNT` | 0 | inert — git never walks the pairs |

The channel therefore has exactly one legal intermediate state: complete, or
absent. Every other state is fatal for **every** git child of that process — not
only for the call that set it — and the message names a variable the user never
wrote, which is what makes it hard to diagnose.

## What this plugin does

It shadows `spawn` and `spawnTerminal` on the **subprocess service instance** — the
one object every consumer resolves methods through (`bash`, subagents, MCP stdio,
LSP, worktree) — and judges the environment each child is about to receive:

- **orphaned** (counter without its pairs) or **malformed** (counter git cannot
  parse) → the channel is removed whole, with the documented `undefined`
  tombstones, so the child starts from "absent";
- **intact** → forwarded untouched, byte for byte, because a caller that supplied a
  complete group made a deliberate choice;
- anything else → forwarded untouched.

Nothing else about the environment changes, and no spawn is ever blocked: a
judgement that throws forwards the original spec and counts the failure.

Removing the channel whole is the same repair the repository already applies to
its own git calls — `packages/experimental/worktree/src/process.ts` clears
`GIT_CONFIG_COUNT`, and `packages/boot/plugin-manager/tests/git-environment.ts`
deletes the group before spawning git, naming `missing config key
GIT_CONFIG_KEY_0` in its own comment. Dropping the group rather than reconstructing
it is also the security-correct direction: `GIT_CONFIG_VALUE_<n>` is exactly where
`http.extraHeader` credentials travel.

## Configuration

```yaml
plugins:
  '@argszero/dsh-git-config-env-guard':
    mode: repair     # repair | drop | report | off
    warn: true
```

| `mode` | behaviour |
|---|---|
| `repair` (default) | remove a channel git cannot read; leave an intact one alone |
| `drop` | also remove inert stray members, and an ambient group even when it is complete |
| `report` | judge and count, change nothing |
| `off` | do not mount the shadow at all |

A configuration that does not match is refused at mount time rather than
defaulted — a silently defaulted filter reports success while doing something else.

Note that in `repair` mode an **ambient** group is always removed, because the
scrub removes exactly its keys: a channel that came from the parent process can
never reach the child intact. The only channel that survives is one the caller
supplies in the spawn spec's own `env`, which the provider merges after the scrub.

## Diagnostics

The plugin provides `gitConfigEnvGuard` on the context:

```js
const { report } = ctx.get('gitConfigEnvGuard')
report()
// { mode: 'repair', spawns: 41, examined: 41, repaired: 41,
//   byShape: { absent: 0, inert: 0, intact: 0, orphaned: 41, malformed: 0 },
//   last: [ { shape: 'orphaned', missing: ['GIT_CONFIG_KEY_0'], dropped: [...] } ],
//   pending: ['GIT_CONFIG_COUNT', 'GIT_CONFIG_VALUE_0'], firstRepairAt: '…' }
```

`pending` lists the channel members still present in the ambient environment — the
ones this guard will repair on the next child — and `scrubSource` says whether the
credential rule came from `@deepseek-ai/dsh-subprocess` (`module`) or from the
bundled fallback, which only happens if a line stops exporting it.

One warning is logged per repaired shape, not per child.

## Coverage — what this plugin does not reach

The shadow covers spawns that go through `ctx.subprocess`. These callers build
their own child environment from `scrubbedParentEnv()` and never enter that
seam, so the guard cannot see them:

- `packages/boot/plugin-manager/src/operations.ts` (`dsh plugin add` / `remove`,
  which spawns its own git with `extendEnv: false`),
- `packages/boot/plugin-manager/src/github-connection.ts` (`ls-remote`),
- `packages/host/open-in-app/src/resolver.ts`,
- `packages/bundle/web-app/src/index.ts`,
- `packages/experimental/browser-use-stagehand-native/src/launch.ts`.

For those, the fix is one line in `scrubbedParentEnv()`: treat the channel as one
unit and skip it whole instead of letting the name rule take half of it.

```ts
// before the name loop, in scrubbedParentEnv()
if (GIT_COMMAND_LINE_CONFIG.test(key)) continue   // whole channel, never half of it
```

That belongs to the core, and this plugin is the mitigation available before it
lands — not a substitute for it.

## Requirements

- `@deepseek-ai/cordis` `^4.0.2` (peer)
- `@deepseek-ai/dsh-subprocess` must be installed, because `subprocess` must exist
  for the plugin to mount; the plugin reads that package's `SENSITIVE_ENV_PATTERN`
  and `DSH_ENV_PREFIX` rather than copying them, so its judgement tracks the
  shipped rule instead of a snapshot of it.

No runtime dependencies, no build step, no sandbox changes.

## License

MIT
