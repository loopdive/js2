---
id: 4174
title: "perf: the scanner re-flattens the source string PER CHARACTER — `__str_flatten` is 3.7% of the standalone acorn parse, called from `skipSpace`/`fullCharCodeAt`; likely the cheapest slice the profile found"
status: done
assignee: ttraenkler/claude-fable-3
sprint: 78
created: 2026-08-06
updated: 2026-08-18
completed: 2026-08-06
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
goal: performance
related: [4157, 3926, 4173]
# LOC grant: the implementation lives in the new src/codegen/string-materialize.ts;
# these god-files carry only thin call sites (+6/+3) and an env-gated ABI-parity
# debug print (+5) that cannot shrink below their frozen baselines.
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/string-ops.ts
  - src/ir/integration.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/ir/integration.ts::compileIrPathFunctions
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
origin: "2026-08-06 post-campaign CPU profile (#4157, PR #4143) — one of two measured buckets with no owning issue"
---

# #4174 — per-character `__str_flatten` in the scanner

## Problem (measured, not estimated)

The 2026-08-06 post-campaign profile (full table in
`plan/issues/4157-close-the-acorn-node-performance-gap.md`) attributes
**3.7% of total self-time** to `__str_flatten`, and the caller attribution
shows it entered **once per scanned character** from the tokenizer's
`skipSpace` and `fullCharCodeAt` paths.

That shape is the bug: a 226 KB source string is flattened (rope/concat form
normalized into a contiguous array) on EVERY `charCodeAt`-style access, when
one flatten at scanner entry — or a flat-fast-path check — should make the
per-character cost a bounds-checked array read. The profiler called this
"likely the cheapest slice found," and no issue owned it before this one.

## Direction (verify against source before implementing)

- Find the `charCodeAt`/code-unit-read lowering that calls `__str_flatten`
  (native-strings runtime; grep `__str_flatten` callers in `src/codegen/`).
- Likely fixes, in ascending ambition: (a) an `is-already-flat` fast path
  that skips the call when the rope depth is 0 (if the check is not already
  there, or is there but behind the call boundary so the call cost is paid
  anyway — the profile suggests the CALL is the cost); (b) inline the flat
  check + direct array read at the read site; (c) flatten once at a
  well-defined boundary (e.g. `String(input)` at parser construction already
  produces flat — if so, find what re-introduces rope-ness).
- Note the #3753 lesson from this same program: measure WHERE the reads
  route before assuming the fix moved them.

## Acceptance criteria

- [x] `__str_flatten` self-time drops from 3.7% on the profile driver
      (`scripts/profile-buckets.mjs`), or the issue records why not.
      (3.75% → 2.64%; the per-character scanner component is eliminated —
      see Results.)
- [x] `standaloneDynamic` A/B (3 pairs, std reported) per #4157 rules.
- [x] String semantics pinned: the string-method and template equivalence
      suites green before/after; no new host imports; canaries unchanged.

## Results (2026-08-06, ttraenkler/claude-fable-3)

### Root cause — WHY the flatten ran per character

Two compounding causes, both verified in emitted WAT (probe:
`.tmp/probe-string-ctor.mjs`-style mini ctor + the acorn twins):

1. **`String(x)` was identity for strings, so `this.input` stayed a rope.**
   The standalone-dynamic driver builds a FRESH ConsString per parse
   (`__npmCompatInput + "\n/* npm-compat-runtime:… */"`). acorn's Parser
   seeds `this.input = String(input)`; in dynamic mode that lowers to
   `__extern_toString`, whose string arm is identity — the ConsString was
   stored as-is into the (typed, #4116) `input` slot. `__str_flatten`'s
   #3673 memoization rewrites the cons's CHILDREN in place but cannot
   change the object's type, so the value stays cons-shaped for the whole
   parse and every flatten call re-runs the ~15-instruction memoized-cons
   dispatch (2 ref.tests, 4 casts, 3 struct.gets) — once per scanned
   character from `skipSpace`/`fullCharCodeAt`/`readWord1`/….
2. **The legacy native `charCodeAt` arm called `__str_flatten`
   unconditionally**, paying a cross-function call per character even for a
   flat receiver (the IR-path `__str_charCodeAt` helper already had the
   inline flat test, #3156; the legacy arm — which acorn's compiled twins
   use — did not).

### Fix (both landed; (b) is the load-bearing one)

- **(b) Flatten ONCE at the explicit `String(x)` materialization point** —
  all three arms of the builtin lowering (externref-string identity,
  ref-string identity, post-`__extern_toString` dynamic), new module
  `src/codegen/string-materialize.ts`. Deliberately NOT added to the
  generic ToString coercions (`__extern_toString`/`__any_to_string`
  themselves): those run on `+`/template concat operands, where eager
  flattening turns `s += chunk` loops O(n²) — including this very
  benchmark driver's chunk loop.
- **(a) Inline already-flat fast path in the legacy `charCodeAt` arm**
  (`ref.test $NativeString ? ref.cast : call __str_flatten`), mirroring
  the IR helper's dispatch.
- ValType-preservation matters: an early draft returned `ref_null` where
  the old identity returned `ref`, which changed legacy-inferred
  signatures and demoted 3 acorn IR bodies with "function typeIdx parity
  mismatch". `emitStringRefResultFlatten` preserves the incoming ValType
  exactly (re-asserts non-nullness via `ref.as_non_null`).

### Measured — profile (`scripts/profile-buckets.mjs`, 300 iters, same box)

| metric | base (`f31a1c3e3`) | patched |
| --- | --- | --- |
| `__str_flatten` self-time | **3.75%** | **2.64%** |
| … from `skipSpace` | 1.35 | **0 (gone)** |
| … from `fullCharCodeAt` | 0.50 | **0 (gone)** |
| … from `__fnctor_Parser_new` | — | 1.08 |
| string-runtime bucket | 5.68% | 4.58% |

The per-character flatten is fully eliminated. The remaining 2.64% is
dominated by the ONCE-per-parse real materialization copy (226 KB rope →
flat), now attributed at the ctor instead of hidden inside the scanner's
first read — that copy existed before too (it was part of `skipSpace`'s
1.35) and also happens in V8 itself on first `charCodeAt` of a cons; the
long tail (~1.2pp spread over `__extern_get`/parser frames) is legitimate
flatten traffic on small strings.

### Measured — `benchmark:acorn:standalone-dynamic` A/B, 3 back-to-back pairs

ratio = node/wasm, higher is better; ratioStd as reported by the lane.

| pair | base ratio | patched ratio | delta |
| --- | --- | --- | --- |
| 1 | 0.1085 ±0.0076 | 0.1133 ±0.0130 | +4.3% |
| 2 | 0.1096 ±0.0085 | 0.1160 ±0.0180 | +5.9% |
| 3 | 0.1122 ±0.0092 | 0.1144 ±0.0187 | +2.0% |

Patched wins **3/3 pairs**; mean ratio 0.1101 → 0.1146 (**+4.1%
relative throughput**, ~8.7x under Node from ~9.1x). Absolute wasmUs
levels (~175–188 ms/op) ran above the campaign-day 144 ms — the box was
ambiently slower/noisier (node-side medians varied ±12% across runs),
which is exactly why the ratio is the quotable metric. The direction is
consistent with the bucket math: ~1.8pp of per-character self-time
removed, ~1.1pp relocated (not removed) to the ctor.

### Canaries / gates

- acorn dogfood canaries **2, 3, 4, 5**, imports **0**, and **exactly the
  3 pre-existing IR-FALLBACKs** (verified identical on unmodified base).
- Suites green: `tests/equivalence/string-methods`, `wrapper-string-concat`,
  `tostring-valueof`, `string-arithmetic-coercion`,
  `string-relational-operators`, `issue-3085-symbol-tostring`, all four
  `issue-1470-*`, the #4155 suite (3 files), `issue-2187/2576/2682`,
  guard suite. Gates by exit code: tsc, biome, oracle-ratchet (no new raw
  checker calls), loc-budget + func-budget (thin-call-site growth granted
  in frontmatter above; implementation lives in the new module),
  dead-exports, coercion-sites, stack-balance, prettier, ir-fallbacks.

### Pre-existing main breakage found while validating (NOT from this PR)

Both reproduce byte-identically on unmodified `origin/main` @ `f31a1c3e3`
(likely from PR #4144, merged immediately before this branch):

- `tests/issue-1712-standalone.test.ts` fails: 3 IR-FALLBACKs
  ("function typeIdx parity mismatch: IR=466/467, legacy=101/102/104" for
  `parse`/`parseExpressionAt`/`tokenizer` — the IR types the `options`
  param as a shape struct, legacy as externref). The new env-gated
  `JS2WASM_DEBUG_ABI_PARITY=1` diagnostic (this PR) prints both functype
  structures for exactly this class of failure.
- `tests/issue-3156.test.ts` "substring + charCodeAt composed" (host +
  standalone): post-claim IR error "method call .charCodeAt(...) on
  string not in slice 4".

Neither file is in the equivalence-gate, changed-root selection, or guard
suite, so they do not block this PR's CI — but they need an owner.

## Dupe check

Distinct from #3926 (property lookup) and #4173 (equality) — same profile,
different helper. The string-runtime issues around `__str_toLowerCase`
(#4106-era analysis) touched adjacent code but not the flatten-per-character
pattern.
