---
id: 5384
title: "standalone: a throwing module does NOT export `__exn_render_prepare` / `__exn_render_char`, so every host-free WasmGC throw renders as \"non-stringifiable payload\" — the #2962 renderer is unreachable outside the test262 lane"
status: done
sprint: current
priority: medium
horizon: s
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/dev-5383
created: 2026-09-07
completed: 2026-09-07
assignee: ttraenkler/senior-dev
# (2026-09-07, #5384) The fix needs one ctx flag and one collector line: the
# field + its "why not exnTagIdx, here is the 6,076 -> 49,032 B measurement"
# doc in types.ts, the 3-line record in unifiedVisitNode, and the initializer.
# Splitting a boolean flag out of the collector/context would cost more than it
# explains; the export-policy change itself lives in host-bridge-exports.ts.
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/declarations/import-collector.ts
func-budget-allow:
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  - src/codegen/context/create-context.ts::createCodegenContext
---

# #5384 — the standalone exception renderer is not reachable

## Problem

#2962 added `__exn_render_prepare` / `__exn_render_char` so a natively-thrown
WasmGC payload can be rendered ("TypeError: boom") with **zero host imports** —
the module runs the payload through its own `__any_to_string` chain and exposes
the flat string one code unit at a time. `scripts/lib/wasm-exn-render.mjs`
(`tryNativeExnRender`) is the only consumer, and when the exports are absent it
returns `null` and the caller falls back to the opaque
`"uncaught Wasm-GC exception (non-stringifiable payload)"`.

**Measured 2026-09-07, on clean main + the #5383 S1 branch:** an ordinary
standalone compile does not get those exports at all.

```js
// .tmp/s2d.mts
const src = `throw new TypeError("boom from top level");\nexport function run() { return 1; }`;
await compileMulti({ "t.js": src }, "t.js",
  { target: "standalone", hostBridge: "off", allowJs: true, deferTopLevelInit: false });
```

→ export list is exactly **`run,__exn_tag`**. `__exn_render_prepare` is not
there, with or without `deferTopLevelInit`.

This is not an unmet precondition. Every gate `emitExceptionRenderExports`
documents PASSES (instrumented, then reverted):

| gate | value |
| --- | --- |
| `ctx.standalone` | `true` |
| `ctx.nativeStrings` | `true` |
| `ctx.exnTagIdx` | `0` (≥ 0 — the module can throw) |
| `funcMap.has("__exn_render_prepare")` | `false` (not already emitted) |
| `anyToStrIdx` / `flattenIdx` / `flatTypeIdx` / `dataTypeIdx` | `2097220` / `2097153` / `7` / `5` — all resolved |

So the emitter runs past all four early returns and reaches its
`mod.exports.push({ name: "__exn_render_prepare", … })`
(`src/codegen/native-strings.ts` ~L2367), yet the export is not in the finished
binary. Something after this point drops it, or the export list the emitter
writes to is not the one that gets encoded. **That is the thing to find** — the
functions themselves are almost certainly present.

Note there are TWO finalize call sites for it (`src/codegen/index.ts` L6156 and
L11456); the probe above goes through `compileMulti`. Check whether both paths
reach the same `mod`.

## Why it matters

Without a renderer, a host-free standalone throw is **unattributable**. This
blocked #5383 S2 concretely: the standalone `@js-temporal/polyfill` provider
instantiates cleanly with an empty import object and then throws from its own
`__module_init`, and there is no way to learn which error it is — the payload is
host-opaque and the renderer that exists precisely for this is not exported.
Every host-free debugging session on the standalone lane pays this cost.

## Acceptance criteria

1. A standalone (`hostBridge: "off"`) module that throws exports
   `__exn_render_prepare` and `__exn_render_char`.
2. `renderHarnessThrownText(error, instance)` returns `"TypeError: boom from top
   level"` for the two-line reduction above — a test, not a manual check.
3. The JS-host / `gc` lane is byte-identical (the emitter is already gated on
   `standalone || wasi`).
4. Re-run the #5383 S2 probe (`.tmp/s2c.mts` in the S1 worktree, or recreate it:
   compile the linked polyfill standalone with `deferTopLevelInit: true` and call
   `__module_init`) and record what the polyfill's init actually throws.

## Notes

- Found while implementing #5383 S1; the fix is not on that PR's critical path
  (S1 landed without it) but S2 cannot be diagnosed without it.
- Predecessors: #2962 (the renderer), #3469 (the sibling `__stdout_prepare` /
  `__stdout_char` sink, same export-at-finalize pattern — compare how it lands),
  #2870 (the opaque fallback this leaves in place).
- Id reserved via `claim-issue.mjs --allocate --allow-unscanned`; the open-PR
  scan was degraded (no `gh`), so re-check for collision before merge.

## Root cause (2026-09-07)

Not the emitter — the **export policy sink**. `stripHostBridgeExports`
(`src/codegen/host-bridge-exports.ts`, #4035) listed `__exn_render_` among
`BRIDGE_PREFIXES` and deletes every matching export when `ctx.emitHostBridge`
is false. `hostBridge: "auto"` resolves to `"off"` for standalone/WASI
(`src/target-profile.ts`), so **every** deployed standalone binary lost the
pair; the emitter had already pushed it, which is exactly why every gate in
`emitExceptionRenderExports` measured as passing. Both finalize call sites
funnel into the same sink (`generateModule` → `finalizeStandaloneTimerCallbackExports`
→ `stripHostBridgeExports`, `src/codegen/index.ts` L7014), so the two paths
never disagreed.

The sibling `__stdout_*` sink is stripped by the same rule — the premise in the
Problem section that it "does land" is wrong. It only survives in the test262
lane, which pins `hostBridge: "always"` (`scripts/test262-worker.mjs`
`HARNESS_HOST_BRIDGE`, `tests/test262-runner.ts` L4358). Left as-is here: unlike
a thrown payload, printed output has a target-appropriate sink (`fd_write` on
WASI) and no host-free consumer outside the harness. Worth its own issue.

## Fix

Keep `__exn_render_*` through the policy sink **iff the source contains a
`throw` statement** (`ctx.usesSourceThrowStatement`, set by `unifiedVisitNode`
so both front-ends record it). The renderer needs no host import, so it is the
only way any host — JS, wasmtime, or another Wasm module — can read a payload it
caught via the deliberately-kept `__exn_tag`.

**Why not gate on `ctx.exnTagIdx >= 0`.** The tag is armed for essentially every
standalone module before user code is read (`recordExportSignature` →
`ensureNativeDynamicBoundaryBridge` → `addUnionImports` → `throwNativeError`), so
a tag-gated keep republishes the renderer everywhere and with it
`__any_to_string` → `number_toString` → the Ryu tables. Measured (`-O3`,
`target: standalone`, `hostBridge: "off"`): arith-only `run(n){return n}`
**6,076 → 49,032 B**. That is #4034's cascade resurrected, so the source-`throw`
gate is load-bearing, not a nicety.

### Measurements (2026-09-07, `-O3`)

| module | base | with fix |
| --- | --- | --- |
| standalone arith-only (no source throw) | 6,076 | 6,076 (identical) |
| standalone `if (n<0) throw …` | 49,016 | 49,156 (+140) |
| standalone top-level `throw` | 17,081 | 17,245 (+164) |
| WASI #4035 `REALISTIC` | 33,136 | 33,293 (+157) |

`gc` lane byte-identical: sha256 of six binaries (three modules × `{}` / `-O3`)
unchanged across an A/B file-copy revert (`.tmp/ab-base.txt` vs `.tmp/ab-new.txt`).
The sink returns early when the bridge is published, so this is structural.

## Pre-existing, NOT caused by this PR — two size guards are already red on `main`

Found while validating, verified by A/B against `origin/main`'s versions of the
only two `src/` files this branch's base changed:

- `tests/issue-4034-standalone-prelude-size.test.ts` — arith-only WASI +
  `hostBridge: "always"` asserts `< 5,000 B`, measures **31,592 B**.
- `tests/issue-4035-host-bridge-policy.test.ts` — `REALISTIC` standalone-default
  asserted `< 20,000 B`, measures **33,136 B** before this PR's +157.

Neither file is in a required gate (`select-changed-issue-tests.mjs --pinned`
does not list them; the changed-file job is advisory), which is why ~13–27 kB of
standalone growth landed unnoticed. This PR replaces #4035's stale absolute
bound with the policy DELTA it actually guards (default must stay well below the
`hostBridge: "always"` build) plus a loose ceiling, and leaves #4034 alone.
**Someone should own the underlying growth.**

## Acceptance criteria — status

1. ✅ exports present (`tests/issue-5384-standalone-exn-render-exports.test.ts`).
2. ✅ `renderHarnessThrownText` returns `"TypeError: boom from top level"` for
   the two-line reduction, with zero imports on the module.
3. ✅ `gc` lane byte-identical (six-binary A/B above).
4. See #5383 — the S2 probe is re-run there with the renderer in place.
