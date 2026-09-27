---
id: 6689
title: "S3-c: dynamic `length` write traps with an illegal cast in `__extern_set_decide` under the native regime in a JS environment"
status: done
completed: 2026-09-27
assignee: ttraenkler/opus-6689
created: 2026-09-26
updated: 2026-09-27
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: property-access
goal: architecture
sprint: current
parent: 5385
depends_on: [6685]
related: [4504, 6686, 6687]
# 2026-09-27 (#6689): +5 lines in `ensureObjectRuntime` — the fnctor-prototype
# start of `__extern_set_decide` gains a `ref.test` guard (one extra
# `any.convert_extern`) plus a 4-line comment naming the trap it prevents.
loc-budget-allow:
  - src/codegen/object-runtime.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
---

# #6689 — S3-c: `__extern_set_decide` illegal cast under the native regime

Slice S3-c of the #5385 "Implementation Plan v2". 73 nightly rows in the
native-first measurement lane (`built-ins/Array/prototype/reduce/15.4.4.21-*`,
`reduceRight/15.4.4.22-*`, plus `map` siblings) fail with

```
illegal cast [in __extern_set_decide() ← __extern_set ← __set_member_nonstrict_length ← __module_init_chunk_N]
```

The same rows pass in BOTH the host lane and the standalone lane.

## Reproduction (measured 2026-09-26, main @ 0631fa543e)

`test262/test/built-ins/Array/prototype/reduceRight/15.4.4.22-5-6.js`:

```js
foo.prototype = new Array(1, 2, 3);
function foo() {}
var f = new foo();
var o = { valueOf: function () { return 0; } };
f.length = o;               // ← the write that traps
assert.throws(TypeError, function () { f.reduceRight(cb); });
```

Compile through the real assembled harness (`assembleOriginalHarness` +
`parseMeta`, `skipSemanticDiagnostics: true`, `inferModuleStrictArguments:
false`, `emitWat: true`) under `semanticProviders: "native-first"` with
`JS2WASM_NATIVE_REGIME_JS=1`, and under `target: "standalone"`. Both compile
and validate; the WAT differs exactly here:

| build      | `__extern_set` body | `__extern_set_decide` present |
| ---------- | ------------------: | ----------------------------- |
| regime/JS  |         8,614 lines | yes (378 lines)               |
| standalone |         2,307 lines | **no**                        |

`__set_member_nonstrict_length` is identical in both (it falls to
`__extern_set` for a non-vec receiver). The regime `__extern_set` is composed
with the #4504 **inherited-set decision runtime** (`__extern_set_decide`,
`__extern_set_own`, the `setDecision` result global) plus JS-env arms
(`__boundary_object_set`, `__proxy_set_dispatch`, `__protoidx_brand_off`,
`__instance_field_resurrect`, `__regexp_lastindex_key`,
`__regexp_getter_only_set`, `__vec_from_extern_2`), while the standalone
build takes the plain insert/update path. The trap is inside the decision
runtime: one of its arms `ref.cast`s the receiver (`f`, a native `$Object`
whose prototype is a native vec) to a carrier it does not have.

## Why the runtime is active only in the regime build

`src/codegen/object-runtime.ts` ≈ L3316:

```ts
const inheritedSetRuntimeActive = ctx.standalone && inheritedSetAnyDirty(ctx);
```

(same predicate at `object-runtime-proxy.ts` ≈ L1956 and
`instance-tombstones.ts` ≈ L255). For this source `inheritedSetAnyDirty(ctx)`
is **false** in the standalone build and **true** in the regime/JS build, so
its inputs are populated by an environment-shaped analysis (a JS-env arm that
marks descriptor state dirty — find the writer of the flag it reads; start at
the definition of `inheritedSetAnyDirty` and its `*Dirty` inputs). Two
possible fixes, in order of preference:

1. The dirty-marking writer is itself environment-shaped (host descriptor
   bookkeeping) → gate that writer on `hostFreeEnvironment(ctx)` /
   `jsValueBoundary(ctx)` per the S1/S2 predicates, so the regime build
   composes the same `__extern_set` as standalone for this source.
2. The decision runtime is legitimately active → the trapping arm must
   `ref.test` before it casts (the #2863/#2868 "ref.test-before-cast" rule)
   and fall through to the plain insert path for a native `$Object` receiver.

Do not change `__set_member_nonstrict_length`, the vec length path, or the
host-assisted profile's output.

## Acceptance

- [x] `reduceRight/15.4.4.22-5-6.js`, `15.4.4.22-5-7.js`, `reduce/15.4.4.21-7-7.js`
      pass under `JS2WASM_EVAL_ENGINE=interpreter TEST262_SEMANTIC_PROVIDERS=native-first TEST262_PATH_FILTER=… pnpm run test:262`.
- [x] Focused test: the assembled repro validates and runs under the regime;
      standalone and default `gc` binaries for it are byte-identical to before.
- [x] `tests/issue-4396-target-profile.test.ts` byte-identity green; 321-row
      sample not below the S1/S2 number.
- [ ] Nightly lane: the `__extern_set_decide` illegal-cast signature drops to
      zero (record before/after). — scoped proxy measured (38 → 0 over
      `reduce`/`reduceRight`/`map`, 8 → 0 in the 321 sample); confirm on the
      next nightly.

## Resolution (2026-09-27, main @ 4b5193844c)

**Root cause is fix (2), not (1).** No environment-shaped writer marks the
#4504 state dirty. The writer is `scanForArrayHoles`' dynamic-code arm
(`isDynamicCodeUse` → `dynamicCodeDirty` → `inheritedSetDescriptorDirty`),
and it fires on a real `eval(sourceText)` — the host fallback inside the
harness's `$262.evalScript`. The two builds scan different source: host-free
targets run the #3418 dead-binding elision pre-pass
(`src/compiler.ts`, gated on `environment === "none" | "wasi"`), which blanks
the unused `$262` / `print` bindings before parsing; the JS-environment regime
build does not, so only it sees the `eval`.

The trap itself is a latent standalone bug: `__extern_set_decide` starts its
inherited walk at `__fnctor_proto_start(receiver)` and `ref.cast` the result to
`$Object` unconditionally. For `foo.prototype = new Array(1, 2, 3)` the store
holds a native vec. A standalone build of the same test with one LIVE
`Function("…")` call traps identically (`illegal cast` in
`__extern_set_decide ← __extern_set ← __set_member_nonstrict_length`).

**Fix:** `ref.test` before the cast (the #4639 rule `__extern_get` already
follows at the same store). A non-`$Object` or null prototype ends the explicit
walk; the builtin-companion tail still runs and a miss takes the own-insert
path — correct here, since an array's `length` is a writable data property.
`__set_member_nonstrict_length`, the vec length path and host-assisted output
are untouched.

**Left alone deliberately:** the elision gate. Extending #3418 elision to the
regime would also hide this source's `eval`, but it changes regime output for
every module and does not fix the cast. It is a candidate for a later S-slice
(the elision is not host-import-specific in effect). The `__extern_has` fnctor
arm (`object-runtime.ts` ≈ L4715) still has a naked `ref.cast` of the same
store; not reached by any measured row, so not changed here.

## Test Results (measured 2026-09-27)

| guard | before | after |
| --- | --- | --- |
| 3 repro rows (`JS2WASM_EVAL_ENGINE=interpreter`, native-first) | 0/3 (all `__extern_set_decide` illegal cast) | 3/3 |
| 321-row sample (`Object/keys`, `Array/prototype/map`, `class/accessor`, 2 workers) | 219/321, 8 decide-cast rows | 227/321, 0 (+8 `map/15.4.4.19-9-*`, 0 regressions; one `compile_timeout` → worker SIGABRT, neither passes) |
| `Array/prototype/{reduce,reduceRight,map}/` (736 rows, 3 workers) | 246 pass, 38 decide-cast rows | 284 pass, 0 decide-cast rows; 38 fail→pass, 0 regressions |
| repro binary sha256, standalone | `c07c767d…6ec0` | identical |
| repro binary sha256, default gc | `11864455…efdf6` | identical |
| repro, regime | validates, runs → `illegal cast` | validates, runs clean |
| repro + live `Function(…)`, standalone | runs → `illegal cast` | runs clean |
| `tests/issue-4396-target-profile.test.ts` | — | 12/12 |
| `tests/issue-6689-extern-set-decide-fnctor-proto.test.ts` | red (both run arms) | 3/3 |
| regime `issue-4397` + `issue-6686` (`JS2WASM_NATIVE_REGIME_JS=1`, 4 GB fork) | — | 34/35 — only the known object-rest (`assignmentRest`) provider red |
| `check:host-import-policy` | — | green |

The full nightly lane was not re-run; the 73-row count in the header covers
more directories than the 38 measured here.
