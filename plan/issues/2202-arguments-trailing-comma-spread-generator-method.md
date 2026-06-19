---
id: 2202
title: "arguments.length wrong for trailing-comma + spread call args in generator / class-method bodies (~30 test262 fails)"
status: suspended
assignee: ttraenkler/sen-1
sprint: 64
created: 2026-06-19
updated: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arguments-object
goal: spec-completeness
related: [1726, 2079]
test262_bucket: arguments-trailing-comma-spread
test262_count: 30
es_edition: es2017
origin: "2026-06-19 sprint-64 standalone failure mining: language/arguments-object/*gen-meth*-args-trailing-comma-spread* fail `arguments.length`."
---

# #2202 — `arguments.length` / `arguments[i]` wrong for SPREAD call args (callee reads `arguments`)

## Corrected framing (sd3, 2026-06-19) — supersedes the original problem statement

The original issue framed this as generator/class-method-specific and
trailing-comma-related. **Both are wrong**:

- **The trailing comma is a pure no-op** (§13.3.8 — grammar only). It does not
  affect the count at all; it is not the bug.
- **Not generator-specific.** The bug reproduces for ANY call where the callee
  reads `arguments` and an argument is a **spread**: a plain non-generator
  `obj.m(...[1,2,3])` fails identically (the issue's "non-generator form works
  today" claim is incorrect — verified, it returns `arguments.length === 1`).

**The actual bug:** a spread call argument (`...arr`) is counted as a SINGLE
element for the `arguments` object. Two coupled breaks:

1. **`__argc` is set from the STATIC `expr.arguments.length`** (the number of AST
   argument nodes) at ~10 call-dispatch arms via `emitSetArgc` /
   `maybeSetArgcForKnownCall`. A spread node counts as 1.
2. **The spread's elements past the first never reach `__extras_argv`**, so the
   materialized `arguments` vec only gets `arguments[0]`; `arguments[1..]` read
   as `NaN`/`undefined`.

Param VALUES expand correctly for the call itself (`f(...[1,2,3])` → params get
1,2,3); only the `arguments` object is starved.

**Repro (object-literal generator method, the dominant test262 shape):**
```js
var arr = [2, 3];
var obj = { *method() {
  assert.sameValue(arguments.length, 4);   // got 1
  assert.sameValue(arguments[3], 3);       // got NaN
}};
obj.method(42, ...[1], ...arr,).next();
```
The `*method()` declares **0 formal params** → all args should flow to
`__extras_argv`, `__argc = 0`.

## Failing test262 cluster

`test/language/arguments-object/*gen-meth*-args-trailing-comma-spread*` and the
`cls-*-gen-meth-*-spread*` variants — ~30 sync + async. Assertion:
`assert.sameValue(arguments.length, N)`. (async-gen variants also need the
async-gen state machine — out of this slice.)

## Suspended Work (sd3 → sen-1, 2026-06-19)

**Branch:** `issue-2202-arguments-length-generator`
**Worktree:** `/workspace/.claude/worktrees/issue-2202-arguments-length-generator`

### What landed in the WIP branch
Added an **additive, spread-aware extras builder**
`emitSetExtrasArgvWithSpread(ctx, fctx, args, paramCount)` in
`src/codegen/statements/nested-declarations.ts`, delegated to from
`emitSetExtrasArgv` when `startIdx === 0 && args.some(isSpreadElement)`. It builds
the `__extras_argv` vec at RUNTIME: per-arg, fixed → one boxed externref;
spread → loops the spread array (`array.get` + per-element box by the spread's
declared element ValType, since the spread data array may be f64/i32/externref)
and appends. Scope-gated to `paramCount === 0` (all-args-to-extras — the test262
`*method()` cluster); returns `false` for `paramCount > 0` (needs a runtime
formal/extra split) so the static path is unchanged. Late-import flush
(`ensureLateImport(__box_number)` + `flushLateImportShifts`) added up front to
avoid the index-shift hazard.

### Verified working
- `arguments.length` correct for the **variable-spread** 0-param shape:
  `const a=[1,2,3]; obj.m(...a).next()` → length **3** ✓.
- Non-spread regressions intact: `obj.m(1,2,3)` → 3, `obj.m()` → 0.
- `tsc --noEmit` clean.

### NOT working (why it's suspended → senior-dev / #1726/#2079 timing)
1. **`arguments[i]` CONTENTS wrong**: `obj.m(...a)` then `arguments[0]` returns
   `1` (the count), not the element. The extras vec has the right LENGTH but the
   re-compiled+boxed elements don't land where the indexed read expects.
2. **Inline array-literal spread** (`obj.m(...[1,2,3])`) emits **invalid Wasm**,
   while a variable spread validates — re-compiling the inline literal in the
   helper desyncs the stack/types vs what the call dispatch already set up.

**Root cause of both:** `emitSetExtrasArgv` is invoked **mid call-dispatch** —
the receiver and the spread are already partially compiled/expanded for the
ACTUAL call on the wasm operand stack. The helper's re-compilation of the spread
source + struct-building corrupts that in-flight frame and double-evaluates. The
correct fix captures the spread expansion **once** and shares it between the
call's arg-pass and the `arguments`-vec population — a coordinated change to the
call-dispatch **arg sequencing** that the `__argc`/`__extras_argv` protocol
(shared with #1726, #2079) owns. This is the tripwire: not a contained additive
helper. Routed to senior-dev (`sen-1`).

### Resume steps for sen-1
1. `cd /workspace/.claude/worktrees/issue-2202-arguments-length-generator`
   (re-claim with `--force` if needed).
2. The additive helper is sound for the count; the missing piece is sequencing —
   capture each spread's expanded element array into a local at the SAME point
   the call dispatch expands it (so it's evaluated once), then feed BOTH the call
   args and the extras vec from that local. The 0-param all-to-extras case is the
   target; keep the `paramCount > 0` split deferred.
3. Re-validate the standalone regression gate (net ≥ 0) before any enqueue.
