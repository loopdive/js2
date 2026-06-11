---
id: 2029
title: "standalone: `Binary emit error: u32 out of range: -1` on builtin subclassing, disposal protocol, Object.create, Iterator.prototype (497 tests)"
status: done
sprint: Backlog
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: critical
feasibility: medium
reasoning_effort: high
model: fable
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

## Producer diagnosis (2026-06-10, from the #1923 always-on validation — sd-fable-emit)

The #1923 PR landed inline emit-time index validation; the minimal repro now
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

## Implementation notes (2026-06-11, sd-fable-emit — branch issue-1915-stringglobal-sentinel)

**Why the standalone no-op never fired:** `ensureLateImport` follows a
register-anyway contract — for any name not in `UNION_NATIVE_HELPER_NAMES`,
`OBJECT_RUNTIME_HELPER_NAMES`, or the `STANDALONE_REFUSED_IMPORT` list it
adds the `env` import and returns a defined funcIdx even under standalone.
`__set_subclass_proto` is in none of those lists, so the documented
"standalone: no-op" early-return (`setProtoIdx === undefined`) was dead code,
and codegen fell through to the sentinel `global.get -1`.

**Which consumers actually produce the emit bucket:** compiler.ts returns
`success: false` BEFORE emit when any queued error starts with
"Codegen error:" (compiler.ts:731). So consumers behind *refused* imports
(`__extern_*` Phase A names, `__defineProperty_desc`, …) never reach the
encoder — the producers are exactly the sites behind (a) natively-routed
helpers (`__extern_get/set`, `__object_create`, `__defineProperty_value`,
`__extern_method_call`, …) and (b) silently-leaked imports
(`__set_subclass_proto`, `__tag_user_class`, `__get_globalThis`,
`__promise_subclass_ctor`, `__instanceof`, `__throw_reference_error`, …).

**Fix:** every nativeStrings-reachable `stringGlobalMap.get` consumer now
routes string materialization through `stringConstantExternrefInstrs`
(native-strings.ts:167) — byte-identical `global.get` in JS-host mode,
inline NativeString + `extern.convert_any` under nativeStrings. In addition
`emitSetSubclassProto` and the `__tag_user_class` ctor tagging are gated on
`noJsHost(ctx)` BEFORE `ensureLateImport`, so the unsatisfiable env imports
no longer leak into standalone modules at all. Files: class-bodies,
object-ops, binary-ops, literals, statements/loops, expressions/{assignment,
identifiers,calls,new-super,extern}, index.ts ($sfnames CSV), array-methods
(join default separator). Host-mode-only arms in string-ops.ts (concat
"undefined"/"null", throw helper) were intentionally left as raw global.get —
they sit behind `ctx.nativeStrings` early branches and can't see the sentinel.

**Validated on the merged base (post 180-commit upstream sync):**
- minimal repro `class MyArr extends Uint8Array {}` compiles standalone; the
  module's only env import is `console_log_bool` (no proto/tag/new leak).
- cluster probe (6 subclass-builtins, 8 Object/create, 6 Iterator/prototype,
  6 DisposableStack, 4 for-await-of, 3 Array/prototype/flat samples via
  wrapTest + target standalone): zero `u32 out of range` / `global index out
  of range` signatures remain. Tests now compile or refuse loudly with the
  named #1472/#1907 errors.

## Residuals (out of #2029 scope, tracked elsewhere)

- **`function index out of range — undefined at function 'g'`** on
  `built-ins/Iterator/prototype/drop/limit-{greater-than-total,tonumber}.js`
  (harness-wrapped generators + iterator helpers): a *function*-index
  stale-capture, the #1919 residual-signature family / #1984/#1985
  structural fix — not a stringGlobalMap consumer.
- **`__str_flatten` stale funcIdx** (Wasm validation: "call[1] expected type
  (ref null 5), found i32.const"): the subclass-builtins repro now emits but
  the binary fails validation on this known #1919 signature. The #2029 test
  asserts compile success + no leaked imports via the import manifest and
  cites #1919 for the validation gap.
