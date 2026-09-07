---
id: 5384
title: "standalone: a throwing module does NOT export `__exn_render_prepare` / `__exn_render_char`, so every host-free WasmGC throw renders as \"non-stringifiable payload\" — the #2962 renderer is unreachable outside the test262 lane"
status: ready
sprint: current
priority: medium
horizon: s
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/dev-5383
created: 2026-09-07
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
