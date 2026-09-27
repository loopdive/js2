---
id: 6698
title: "standalone: `__extern_get` hash-bucket ladder nests one block per field-name bucket — axios overflows the codegen stack"
status: done
sprint: current
created: 2026-09-26
updated: 2026-09-26
completed: 2026-09-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [1032, 3926, 6660, 6682]
---

# #6698 — `__extern_get` bucket ladder overflows the codegen stack (axios)

## What you will see

After [#6682](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6682-standalone-axios-redactconfig-livebodies-unbalanced),
the npm-compat **axios** standalone-dynamic lane
(`npx tsx scripts/generate-npm-compat-report.mjs --only axios --no-write --perf-only --lane standalone-dynamic`,
measured 2026-09-26 on upstream/main 36f92e8917) stops at:

```
Codegen error: Maximum call stack size exceeded (at src/codegen/fixups.ts:207:17)
```

after a 137 s compile. The reported frame moves between runs (with
`--stack-trace-limit` it reads `src/codegen/stack-balance.ts:3217:10`).

## Mechanism

Not a type/shape cycle. `JS2WASM_CODEGEN_STACK=1` gives the full trace:
1,526 frames of `fixLocalSetCoercion` recursing into nested `block` bodies
(its `visited` WeakSet already rules out a cycle). A depth probe over every
function at `stackBalance` time found `__extern_get` nested **2,296** levels
deep; everything else is at most 165.

`fillClosedStructExternGetArms` (#3926, `src/codegen/object-runtime.ts`)
dispatches a dynamic string key by `hash & mask` through ONE `br_table`.
A `br_table` can only target enclosing labels, so an N-way dispatch was N
nested blocks — one per occupied bucket of every distinct closed-struct field
name in the program. axios has 2,292 occupied buckets (table 8,192). Every
recursive post-codegen walker (`fixLocalSetCoercion`, `repairBody`, …) then
needs one JS frame per level; with `node --stack-size=7000` the compile gets
through but several walkers are super-linear in depth (a 2,400-field reduction
took 219 s; 1,200 fields 123 s).

Reduction: ~1,600 distinct field names across plain object literals read
through `o["f" + i]` overflows under the default stack.

## Implementation Plan

1. New `src/codegen/hash-bucket-dispatch.ts` (`buildHashBucketDispatch`): the
   ladder builder moved out of `object-runtime.ts` unchanged for ≤ 256 buckets
   (byte-identical shape), and a two-level form above that: an outer
   `br_table` over the masked hash selects a chunk of ~sqrt(N) consecutive
   buckets, and the chunk's own `br_table` over `slot - chunkLo` selects the
   bucket. Nesting ~2·sqrt(N) (≈100 for axios); still two O(1) table jumps;
   inner tables partition the occupied slot range, so table bytes stay the
   same order.
2. `fillClosedStructExternGetArms` builds the per-bucket probe lists in the
   same (ascending-slot) order as before and calls the helper.
3. Standalone-only by construction (`fillClosedStructExternGetArms` returns
   early for non-standalone), so JS-host output is unchanged.
4. Regression test `tests/issue-6698-wide-extern-get-dispatch.test.ts`.

## Resolution

Fixed by bounding the ladder's nesting at its producer (the walkers are
unchanged). Measured 2026-09-26:

- Reduction (`.tmp` script, 2,400 field names, standalone): parent
  `Maximum call stack size exceeded` (219 s with `--stack-size=7000`); fix
  compiles in 10.7 s and every read-back plus a miss is correct.
- Regression test: parent fails (`expected 309 to be less than 120` with a
  4 GB fork heap; the default 512 MB unit-test fork OOMs on the parent's deep
  ladder), fix 2 / 2.
- Byte identity below the limit: a 200-field program and the #4194 fixture
  produce identical binaries parent vs fix, standalone and gc.
- Scoped standalone test262 (`built-ins/Object/{assign,keys,entries,defineProperties}`,
  `built-ins/JSON/{parse,stringify}`, `language/expressions/object/*.js`,
  1,199 rows, `scripts/run-test262-paths.mts --standalone`): parent and fix
  both `pass 1096 / fail 90 / compile_error 13`, identical non-pass sets.
- JS-host control: axios dogfood suite 208/231 (unchanged).
- axios standalone-dynamic lane: `compile-error` "Maximum call stack size
  exceeded" (137 s) → `compile-error` at the next blocker, filed as
  [#6699](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6699-standalone-axios-globalthis-ensure-stack-underflow)
  (stack-balance #2090 underflow in `__native_globalThis_ensure`), compile
  66 s.
