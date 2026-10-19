---
id: 7011
title: "Regime gap: `new SharedArrayBuffer(n)` still emits the host `SharedArrayBuffer_new` import on host-free builds"
status: done
created: 2026-10-19
updated: 2026-10-19
completed: 2026-10-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler, runtime
language_feature: SharedArrayBuffer
goal: architecture
sprint: current
parent: 5385
related: [6979, 6705]
assignee: ttraenkler/opus-7011-sab
loc-budget-allow:
  # 2026-10-19 (#7011): thin routing lines only — the semantics live in the new
  # src/codegen/buffers/ and src/codegen/atomics/ provider modules.
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/ta-dyn-mop.ts
func-budget-allow:
  # 2026-10-19 (#7011): one adapter call (+ gate) per surface into the provider.
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/property-access-dispatch.ts::tryBufferViewAttributeReads
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/expressions/new-indexed.ts::tryCompileIndexedBuiltinNew
  - src/codegen/ta-dyn-mop.ts::fillTaDynViewMopArms
import-cycles-allow:
  - largestSccSize: 720 # 2026-10-19 (#7011; 720 re-measured on the merge preview after #7090 landed, 717 → 720): atomics/atomics-native.ts, buffers/shared-array-buffer.ts and buffers/shared-array-buffer-mop.ts join the codegen SCC — they are called from array-object-proto.ts / call-builtin-static.ts / ta-dyn-mop.ts and use shared.js coerceType/ensureLateImport, like the other native providers
---

# #7011 — `SharedArrayBuffer` construction on the native regime

Found by the S7-b slice of #6979 (2026-10-15): `new SharedArrayBuffer(n)`
is the only construct in the Atomics test262 rows (4 corpus programs in the
1-in-97 sample) whose sole implementation is the host import
`SharedArrayBuffer_new`. S7-b classifies it under the explicit `regime-gap`
family (owner #5385) so the universal publication gate does not reject it;
closing this issue lets that family entry be deleted.

## Plan

1. Measure: which test262 rows under `built-ins/SharedArrayBuffer/` and
   `built-ins/Atomics/` reach the import on standalone and native-first
   (`TEST262_PATH_FILTER`), and what `ArrayBuffer` does today on the native
   path (`src/codegen/dataview-native.ts`, the typed-array native layer).
2. Implement natively: a `SharedArrayBuffer` object whose backing store is
   the same native byte array as `ArrayBuffer` (there is no shared memory
   between Wasm instances to honour, so the semantic difference is the
   constructor identity, `[[ArrayBufferData]]` sharing on `slice`, and
   `growable`/`maxByteLength`); `Atomics.*` operate on the native store with
   the ordinary (single-agent) semantics. Keep the JS-host accelerator-free:
   no host import; a `--target standalone` build must link with no `env`
   import.
3. Tests: a focused test under native-first and standalone (construction,
   `byteLength`, `slice`, a typed-array view, `Atomics.add`/`load`); the
   test262 subset counts before/after.
4. Acceptance: equivalence gate "No new equivalence regressions"; the
   `regime-gap` entry for `SharedArrayBuffer_new` deleted from
   `src/host-import-policy.ts` and its probe; direct-AST freeze respected
   (native provider/runtime code).

## Measurements (2026-10-19, before any src edit, base upstream/main f92ad8af0e)

Where the import came from — there was no dedicated registration:
`SharedArrayBuffer` was collected as a generic lib **extern class**
(`collectExternFromDeclareVar` in `src/codegen/extern-declarations.ts`, the
`declare var X: XConstructor` pattern — `ArrayBuffer` is on that loop's
`BUILTIN_SKIP` list, SAB was not), so `new SharedArrayBuffer(n)` fell to the
extern-class path in `new-super.ts` and emitted `SharedArrayBuffer_new`
(+ `SharedArrayBuffer_slice`, `SharedArrayBuffer_get_byteLength`), resolved by
the runtime's generic extern-class provider.

| Construct (probe) | default `compile()` | native-first | standalone | wasi |
| --- | --- | --- | --- | --- |
| `new SharedArrayBuffer(16)` | `env::SharedArrayBuffer_new` | CE (policy rejects the import) | `env::SharedArrayBuffer_new` (CE in test262) | import dropped, value null (warning) |
| `sab.slice(…)` | `+ SharedArrayBuffer_slice` | CE | `+ SharedArrayBuffer_slice` | dropped |
| `Atomics.*` on any view | n/a | throws "unsupported in --target standalone" | same | same |

`ArrayBuffer` on the native path is the `$__vec_i32_byte` packed-byte vec
(`new-indexed.ts`), `$__resizable_ab` its resizable subtype; views are
`$__ta_view` (static) / `$__ta_dyn_view` (dynamic) over it. `Atomics.*` had NO
native implementation: `call-builtin-static.ts` threw a blanket TypeError on
every host-free lane (#3145), even for spec-valid non-shared Int32Array use.

test262 subset `TEST262_PATH_FILTER="built-ins/SharedArrayBuffer/|built-ins/Atomics/"`,
`JS2WASM_EVAL_ENGINE=interpreter`, `TEST262_WORKERS=2`, 493 rows:

| Lane | before | rows reaching `SharedArrayBuffer_*` |
| --- | --- | --- |
| standalone | 93 / 493 | 320 |
| gc (native-first default) | 149 / 493 | 6 |

## Implementation notes

Native provider/runtime code only (direct-AST freeze): every semantic is a
DEFINED Wasm helper with an externref ABI; the AST sites are one-line adapters
that evaluate operands and call the helper.

- `$__sab` (`registry/types.ts getOrRegisterSabType`): a subtype of the
  ArrayBuffer byte vec with `__maxByteLength` / `__growable` fields. Being a
  subtype makes every existing byte consumer (TypedArray/DataView construction,
  element codecs, `byteLength`, `.buffer` identity) work unchanged; the
  subtype identity is IsSharedArrayBuffer. The 4th field keeps it from
  canonicalizing with `$__resizable_ab`; the `__` prefix keeps the fields from
  leaking as dynamic `__sget_<name>` properties (measured: `g.growable` read
  the raw i32 field before the rename).
- `buffers/shared-array-buffer.ts`: `__sab_construct` (ToIndex, Object-only
  options `Get(options,"maxByteLength")` through `__extern_get` so getters and
  poisoned options work, allocation RangeErrors), `__sab_slice`, `__sab_grow`,
  `__sab_get` (byteLength/maxByteLength/growable), plus the reflective
  `SharedArrayBuffer.prototype` member bodies (`array-object-proto.ts` glue) and
  `SharedArrayBuffer.prototype.m.call(x)` routing (`calls.ts`).
- `buffers/shared-array-buffer-mop.ts`: finalize-time arms so an `any`-typed
  SAB (every test262 `var sab`) answers `__getPrototypeOf` →
  `SharedArrayBuffer.prototype` and `__extern_get` byteLength/maxByteLength/
  growable.
- `atomics/atomics-native.ts`: one `__atomics_op(op, hint, ta, index, v, w)`
  helper, so the spec order holds (ValidateIntegerTypedArray → ToIndex →
  value coercions → revalidate → access). Carriers: `$__ta_dyn_view`,
  `$__ta_view` (kind at run time) and the fresh-allocation vecs
  (`$__vec_i32_elem` / `i16_byte` / `i8_byte`, kind from the call site's static
  type). Number kinds operate in the i32 bit domain (exact modular semantics);
  BigInt64/BigUint64 views operate in i64 on the element bytes.
  Single agent: `notify` returns 0; `wait` reports AgentCanSuspend() = false
  and throws its TypeError after validation and coercions (DoWait step 10 —
  nothing could ever wake a suspended agent; test262 `CanBlockIsFalse`).
- Gating: everything above is `noJsHost` (the native regime: default `gc`,
  native-first, standalone, WASI). The opt-in `host-assisted` profile keeps the
  host extern class, so the extern-class collection is skipped only for the
  native regime rather than deleted outright.

## Results (after)

| Lane | before | after | rows reaching `SharedArrayBuffer_*` |
| --- | --- | --- | --- |
| standalone | 93 / 493 | 271 / 493 | 0 |
| gc (native-first default) | 149 / 493 | 271 / 493 | 0 |

Both "after" numbers are the vitest subset run plus an isolated re-run
(`scripts/run-test262-paths.mts`, 120 s budget) of that run's
`compile_timeout` rows: the box sat at load average 60-110 from other lanes
during the runs (standalone: 219 + 52 of 129 timeouts pass; gc: 204 + 67 of
156). Every row that read pass→non-pass in the loaded runs was a
`compile_timeout` and passes in isolation; no row regressed. Remaining
failures: `$262.agent` multi-agent rows, `waitAsync` (timer import /
TypeError), the `immutable-buffer` proposal, BigInt element reads through the
f64 element representation (#1349).

Not done / residual:
- `Atomics.waitAsync` keeps its call-site TypeError (needs a timer-backed
  promise provider; the agent rows also need `__timer_set_timeout`).
- `slice` does not consult `constructor[@@species]`; a NewTarget prototype
  (`Reflect.construct(SharedArrayBuffer, [], F)`) is not honoured; instance
  `.constructor` / `instanceof SharedArrayBuffer` on an instance answer like the
  ArrayBuffer carrier does today (false); views over a growable SAB do not
  length-track `grow`; a BigUint64Array element ≥ 2^63 boxes as its signed
  twin; `Atomics` on a fresh (non-buffer) BigInt64Array is a TypeError.
- S7-b `regime-gap` family entry for `SharedArrayBuffer_new` (lives on the S7
  stack, not on main) can be dropped: no native-regime program emits it.
