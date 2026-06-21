---
id: 2029
title: "standalone: `Binary emit error: u32 out of range: -1` on builtin subclassing, disposal protocol, Object.create, Iterator.prototype (497 tests)"
status: in-progress
sprint: 65
created: 2026-06-10
updated: 2026-06-17
priority: critical
assignee: ttraenkler/cs-2160
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

## Slice (2026-06-18, cs-2160) — `extends Error` standalone `__get_undefined` leak

**Status stays `in-progress`** — one more independent host-import-leak slice.

The `__new_Error` leak noted above was already gone by current main (the WASI
native Error constructor path covers `extends Error`/`TypeError`). The remaining
leak for `class E extends Error {}` standalone was **`env::__get_undefined`** —
the module instantiated FINE in gc/host mode but **failed to instantiate with an
empty import object** standalone (`env: module is not an object or function`),
so the whole subclass cluster produced zero standalone passes.

**Root cause:** three `__get_undefined` emit sites called `ensureLateImport`
DIRECTLY and only fell back to `ref.null.extern` when it returned `undefined` —
but `ensureLateImport` does NOT refuse `__get_undefined` (it's not on any
refusal/native list), so under `--target standalone` it REGISTERED and leaked
the host import; the intended fallback never fired. The canonical
`ensureGetUndefined` (`expressions/late-imports.ts`) already guards on
`ctx.nativeStrings`; the direct sites did not.

**Fix:** mirror the canonical guard at the two reachable direct sites —
`emitUndefinedValue` (`src/codegen/type-coercion.ts`, the `pushDefaultValue`
externref default used by the implicit derived-ctor forwarder) and
`emitBoundsCheckedArrayGetUndef` (`src/codegen/destructuring-params.ts`). When
`ctx.nativeStrings`, skip the import and emit `ref.null.extern` (undefined ≡
null standalone, by design). gc/host mode keeps the host import (the guard is
`nativeStrings`-only). The third site (`calls.ts` padStart/endsWith) is reached
only on the JS-host string path and was left unchanged.

**Validation.** `tests/issue-2029-error-subclass-get-undefined-standalone.test.ts`
(3/3): `extends Error` / `extends TypeError` / `extends Error` with `super(msg)`,
each instantiated with an EMPTY import object (proves no env leak) standalone +
WASI, plus a gc-mode no-regression guard. Existing #2029 subclass-emit suite
(8/8) and standalone string suites green. tsc + prettier + biome lint +
coercion-sites + any-box gates clean. (Pre-existing unrelated failure on main:
issue-1025 nested-pattern test — fails identically on pristine `origin/main`.)

**Still open (the bucket):** TypedArray subclass (`class X extends Uint8Array {}`)
still leaks `__new_<TypedArray>` — needs native vec-struct construction in the
externref-backed implicit forwarder (overlaps #2159). `DisposableStack` /
`AsyncDisposableStack` leak `DisposableStack_new`. Both are separate slices.

## Slice triage (2026-06-21, dev-carla) — DisposableStack/AsyncDisposableStack is SUBSTRATE-BLOCKED, not a dev slice

Probed `new DisposableStack()` standalone: confirmed it leaks `DisposableStack_new`
(and `AsyncDisposableStack_new`) — the constructor + all methods route through the
host `externClasses` table (`src/codegen/index.ts:11134`), no native runtime.

Attempted to scope a native sync-DisposableStack runtime (struct + LIFO disposer
list + use/adopt/defer/dispose/move, modeled on set-runtime.ts). **Blocked on
missing ERM substrate** — measured, not assumed:

1. **`Symbol.dispose` / `Symbol.asyncDispose` value-read is unsupported standalone.**
   `const f = o[Symbol.dispose]` and `o[Symbol.dispose]()` both CE with
   `"Symbol.dispose built-in static property value read is not supported"`. Reading
   a disposer off a resource is the foundational op `use()`/`adopt()`/scope-exit all
   require, so the runtime cannot store or invoke disposers without it.
2. **There is NO native dispose-dispatch helper at all** (`grep __run_disposers /
   __dispose / disposeStack` → 0 hits). Even plain `using r = {[Symbol.dispose](){}}`
   leaks `__box_symbol` and defers the actual disposal to the host runtime — the
   "call Symbol.dispose LIFO at scope exit" primitive is host-backed, not Wasm-native.

The native closure-invoke primitive (`__call_fn_method_N`) DOES exist, so once the
two substrate gaps above land, the runtime itself is a straightforward set-runtime
-style build. But building it now would require first implementing native
`Symbol.dispose` builtin-symbol value-read + a native dispose-dispatch substrate —
foundational ERM/symbol-property-read work that spans the standalone object model,
i.e. senior-dev/value-rep scope (overlaps the #2158 class/descriptor object-model
epic and the symbol-keyed builtin-read path), **not a contained dev slice**.

**Disposition:** DisposableStack/AsyncDisposableStack standalone (the ~44-test
cluster) is **blocked on native ERM substrate** (`Symbol.dispose` builtin value-read
+ dispose-dispatch). DO NOT re-dispatch as a dev slice until that substrate exists.
Route the substrate to senior-dev. No code pushed.
