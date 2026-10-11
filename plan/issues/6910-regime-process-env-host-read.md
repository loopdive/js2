---
id: 6910
title: "native regime in a JS environment: `process.env` / `process.platform` are host-free stand-ins instead of the Node host's values"
status: done
assignee: ttraenkler/opus-6910
created: 2026-10-07
updated: 2026-10-07
completed: 2026-10-07
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: codegen
language_feature: node-platform
goal: architecture
parent: 6749
related: [5385, 6749, 6890, 1490, 1482]
---

# #6910 — `process.*` under the native regime in a JS environment

## Problem

Found by the #6890 implementer. With `NODE_ENV=production`, the default gc lane
reads `process.env.NODE_ENV` as `"production"`, while the native regime
(`semanticProviders: "native-first"`) in the same Node environment read
`undefined`.

Two separate defects:

1. **Wrong gate.** `tryGlobalThisAndProcessRead`
   (`src/codegen/property-access-dispatch.ts`, the #1490 arm) swapped in the
   host-free empty-object stand-in for `process.env` whenever `ctx.standalone`
   was set. `ctx.standalone` is the regime ("which ECMAScript implementation
   lowers this"). Whether a host exists is the environment question,
   `hostFreeEnvironment(ctx)` (#5385 Implementation Plan v2).
2. **Unclassified, unadmitted imports.** The `__get_process*` builtins had no
   host-import policy class (`unknown`, owner #4401), so the native-first
   publication gate would have refused them. The regime also never admitted
   their results at the value boundary: `process.platform` (a host string) read
   as `[object Object]`, and member reads on `process.env` (going through
   `__boundary_object_get`) missed.

## Fix

- **Codegen.** The stand-in arm is now gated on
  `ctx.standalone && (hostFreeEnvironment(ctx) || !jsValueBoundary(ctx))`. A JS
  environment that has the value bridge falls through to the ordinary
  `__get_process_env` import. A JS environment without the bridge has no object
  MOP to read a host object with, so it keeps the stand-in. `--target
  standalone` and gc are unchanged, and WASI (`!ctx.wasi`, #1482 environ path)
  is never reached.
- **Policy.** `__get_process` and `__get_process_*` are classified as
  `platform-capability`/`node` (owner #1490), with no native fallback. They are
  a Node environment capability, the same family as the `node_builtin*`
  intents. The classification only applies where a host exists; a host-free
  build swaps in its stand-in at compile time.
- **Runtime.** The `__get_process*` readers move out of `runtime.ts` into the
  new `src/runtime/process-capability.ts`, with unchanged semantics and the
  same host-free stand-ins. `resolveImport` injects a `toNative` step: when the
  importing module is a native-regime module (`isNativeRegimeExports`), the
  value crosses `_nativeDynamicFromHost`. That admits objects (`process.env`,
  `process.argv`, the streams) so the boundary object MOP reads their members,
  and turns strings (`platform`, `arch`, `cwd()`) into native strings. Other
  lanes get the raw value, exactly as before.

Limitation (same as #6890's console): a read in the start section, before the
exports exist, passes the host value unadmitted. react and the npm-compat
harness use `deferTopLevelInit`, so their module-init reads are admitted.

## Results

| lane (`NODE_ENV=production`)          | `process.env.NODE_ENV` |
| ------------------------------------- | ---------------------- |
| default gc                            | `"production"` (unchanged) |
| native regime, JS env (`native-first`) | `"production"` (was `undefined`) |
| `--target standalone`                 | `undefined` (empty stand-in, unchanged) |
| `--target wasi`                       | #1482 environ path (untouched; bytes identical) |

- Byte identity: gc, standalone and wasi produce sha256-identical bytes on a
  3-shape probe (`process.env.HOME`, the `NODE_ENV` gate, `platform`/`arch`).
- `pnpm run check:host-import-policy`: native-first has 0 legacy and 0 unknown
  imports. `runtimeTsLines` drops from 20222 to 20207.
- Tests green: `issue-6910`, `issue-1490`, `issue-4396`, `issue-6686`,
  `issue-6890`, `issue-4401`, `issue-6663`.
- `wasi-environ.test.ts` fails 3 of 6 identically on the base branch.
  The failures predate this change, which leaves that file untouched.
- react on `js-host-native` (refusal-only provider): measured.
