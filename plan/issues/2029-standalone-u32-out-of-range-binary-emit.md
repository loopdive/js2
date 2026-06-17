---
id: 2029
title: "standalone: `Binary emit error: u32 out of range: -1` on builtin subclassing, disposal protocol, Object.create, Iterator.prototype (497 tests)"
status: in-progress
sprint: 63
created: 2026-06-10
updated: 2026-06-15
priority: critical
feasibility: medium
reasoning_effort: high
model: opus
task_type: bugfix
area: codegen, emit
language_feature: classes, explicit-resource-management, objects
goal: standalone-mode
related: [1809, 1839, 1888, 1666]
test262_bucket: standalone-emit-u32-range
test262_count: 497
es_edition: multi
origin: "2026-06-10 standalone-vs-host baseline diff (test262-standalone-current.jsonl, run 10.6.2026 00:56): 497 host-pass tests emit `u32 out of range: -1`/`undefined` under --target standalone."
---

# #2029 — standalone: `Binary emit error: u32 out of range: -1` bucket

## Problem

497 tests that pass in JS-host mode die at **emit time** under
`--target standalone` with the raw encoder error
`Binary emit error: u32 out of range: -1` (a smaller sub-bucket says
`u32 out of range: undefined`). The compiler never produces a binary — these
are hard compile errors, not refusals, so the whole file (often L1:1) is lost.

Path clusters (from the 2026-06-10 standalone baseline JSONL, gap rows where
host passes):

| Count | Cluster |
| ---: | --- |
| 83 | `language/statements/class` (incl. all `subclass-builtins/*`) |
| 74 | `built-ins/Object/create` |
| 45 | `language/expressions/class` |
| 44 | `built-ins/Iterator/prototype` |
| 29 | `built-ins/Array/prototype` |
| 24 + 20 | `built-ins/DisposableStack` + `AsyncDisposableStack` |
| 23 | `language/statements/for-await-of` |
| rest | `await-using`, `for-of`, `assignment`, dynamic-import namespace… |

## Minimal repro (confirmed on main @ 936d1ac51, 2026-06-10)

```bash
npx tsx src/cli.ts repro.ts --target standalone -o out/
# repro.ts:
#   class MyArr extends Uint8Array {}
#   const a = new MyArr();
#   console.log(a instanceof MyArr);
```

→ `repro.ts:1:1 - error: Binary emit error: u32 out of range: -1`

The same file compiles and runs in default (gc/JS-host) mode.

Other failing shapes from the bucket:

- `class A extends BigUint64Array {}` (any builtin subclass)
- `await using x = { [Symbol.asyncDispose]() {} }` / DisposableStack methods
- `Object.create(proto, …)` forms in `built-ins/Object/create`
- `Iterator.prototype` helper tests

## Root cause in compiler

`RangeError` thrown by the LEB encoder at `src/emit/encoder.ts:21` — some
index field is `-1` (failed map lookup) or `undefined` when the module is
serialized.

**Important diagnostic finding:** the existing env-gated guard
`JS2WASM_VALIDATE_FUNCREFS=1` (`validateFuncRefs`, `src/emit/binary.ts:105`)
does **NOT** fire on the minimal repro — the error stays the raw encoder
message. So this is *not* (only) the known late-import `call`/`ref.func`
funcIdx-shift class (#1809/#1839): the `-1` lives in a u32 the walker does not
cover — candidates: a type index (`ref null <t>`/`call_ref`/`struct.new`
typeIdx), a global index, an export index, or a table/element field. The
standalone path (no JS-host imports → different import-section layout and
late-import flushing) is what exposes it.

## Suggested fix

1. Extend `validateFuncRefs` (or add a sibling `validateIndices`) to check
   every u32 index field the encoder writes (typeIdx, globalIdx, tableIdx,
   localIdx, exports) so the failure becomes a named, located codegen error —
   then the actual broken producer is identifiable in one compile.
2. Run the minimal repro, identify the producer (likely builtin-subclass
   class layout or the disposal/iterator-helper lowering registering a type
   or global only on the JS-host path), and fix the standalone branch.
3. Keep the dual-mode invariant from #1888: if a construct genuinely cannot
   lower standalone yet, it must refuse loudly via `reportError*`, never
   reach the encoder with a poisoned index.

## Acceptance criteria

- `class MyArr extends Uint8Array {}` compiles (or refuses loudly with a
  specific message) under `--target standalone`.
- `test/language/statements/class/subclass-builtins/*`,
  `built-ins/Object/create/*`, and the DisposableStack/await-using clusters
  no longer report `u32 out of range` in the standalone lane.
- Emit-time index validation produces a named error with location for any
  future `-1`/`undefined` index (no more opaque encoder RangeError).
- Bucket reduced from 497 toward 0; no host-mode regressions.

## Producer diagnosis (2026-06-10, from the #2043 always-on validation — sd-fable-emit)

The #2043 PR landed inline emit-time index validation; the minimal repro now
fails with the named error instead of the raw RangeError:

```
Codegen error: global index out of range — -1 (valid: [0, 3)) at function 'MyArr_new'. …
```

**Confirmed producer for the builtin-subclass cluster:** under
standalone/nativeStrings, `addStringConstantGlobal`
(`src/codegen/registry/imports.ts:74`) stores the documented **-1 sentinel**
in `ctx.stringGlobalMap` ("no host import — materialize inline at use
sites", #1174). `emitSetSubclassProto` (`src/codegen/class-bodies.ts:230-254`)
then reads `ctx.stringGlobalMap.get(subName/parentName)` and guards only
`undefined` — NOT the -1 sentinel — before emitting
`{ op: "global.get", index: subNameGlobal }` into the if/else arm. Note the
flow also implies `ensureLateImport("__set_subclass_proto", …)` returned a
defined index under `--target standalone` (the early standalone return did
not trigger) — check whether that import should exist standalone at all.

**Fix shape:** in `emitSetSubclassProto`, treat `-1` like the comment in
`addStringConstantGlobal` prescribes (use the native string materialization
path, or skip the proto adjustment + record a standalone fallback), and
audit every other `stringGlobalMap.get` consumer for the same missing
sentinel check — the Object.create / Iterator.prototype / DisposableStack
clusters in this bucket are likely the same pattern. `grep -n
"stringGlobalMap.get" src/codegen/` and check each use site emits
`global.get` only for `idx >= 0`.

## PR-1 landed (2026-06-15, sdev3) — builtin-subclass cluster

Applied the prescribed fix shape to the confirmed producer. `emitSetSubclassProto`
(`src/codegen/class-bodies.ts`) now skips the prototype-adjustment arm when
either class-name string global is the `-1` sentinel (standalone/`nativeStrings`),
in addition to the existing `=== undefined` guard. The arm exists only to feed
the `__set_subclass_proto` HOST import (unavailable standalone anyway), and the
WasmGC instance `__tag` already carries class identity for `instanceof`, so
skipping is semantically correct standalone.

**Fixed (compile-time emit crash gone):** `class X extends Error/TypeError/
Uint8Array {}` and `extends`-builtin with own field / explicit `super()` /
implicit ctor / 3-level hierarchy / class-expression — all the
`language/{statements,expressions}/class` + `subclass-builtins/*` clusters
(≈128 of the 497) now COMPILE under `--target standalone` instead of dying with
`u32 out of range: -1`. Test: `tests/issue-2029-subclass-builtin-standalone-emit.test.ts`
(8 compile-success cases). Zero host-mode regressions (the new branch only fires
on the `-1` sentinel, which never occurs in gc/host mode where globals are real).

**Audit of other `stringGlobalMap.get` consumers:** the remaining clusters in
the bucket — `built-ins/Object/create` (74), `Iterator/prototype` (44),
`DisposableStack`/`AsyncDisposableStack` (44), `for-await-of` (23) — all COMPILE
in standalone on current main now (probed: no `-1`/`u32-out-of-range` emit), so
they were either already resolved by later work or never shared this exact
`emitSetSubclassProto` site. The other `stringGlobalMap.get` use sites that
push `global.get` with a `!` non-null assertion (string-ops.ts, object-ops.ts,
literals.ts) are reached only on the **legacy/host** string path (their callers
gate on `!ctx.nativeStrings` or route through `compileNativeStringLiteral` /
`stringConstantExternrefInstrs` in standalone), so they don't hit the sentinel.

**Remaining (separate, NOT this PR):** runtime behaviour of `extends Error`
standalone still leaks the `__new_<Builtin>` HOST import (`class-bodies.ts:1423/2187`)
— a host-import-retirement concern, not the emit crash. Kept #2029 `in-progress`:
the emit-crash cluster (the headline) is fixed; the `__new_<Builtin>` standalone
runtime path is the residual. Reassess closing once that lands.
