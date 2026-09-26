---
id: 6689
title: "S3-c: dynamic `length` write traps with an illegal cast in `__extern_set_decide` under the native regime in a JS environment"
status: ready
created: 2026-09-26
updated: 2026-09-26
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

- [ ] `reduceRight/15.4.4.22-5-6.js`, `15.4.4.22-5-7.js`, `reduce/15.4.4.21-7-7.js`
      pass under `JS2WASM_EVAL_ENGINE=interpreter TEST262_SEMANTIC_PROVIDERS=native-first TEST262_PATH_FILTER=… pnpm run test:262`.
- [ ] Focused test: the assembled repro validates and runs under the regime;
      standalone and default `gc` binaries for it are byte-identical to before.
- [ ] `tests/issue-4396-target-profile.test.ts` byte-identity green; 321-row
      sample not below the S1/S2 number.
- [ ] Nightly lane: the `__extern_set_decide` illegal-cast signature drops to
      zero (record before/after).
