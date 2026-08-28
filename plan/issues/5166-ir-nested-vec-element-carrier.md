---
id: 5166
title: "IR: nested-vec element carrier — `number[][]` claims via concrete-ref elements; unblocks #4470 destructuring for-of heads"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: adoption
area: ir
language_feature: arrays
goal: ir-full-coverage
related: [4470, 4486, 3577, 2379]
origin: "2026-08-28 IR-takeover session — scout probes .tmp/nvc-*.ts; supersedes the carrier half of #4470's blocker analysis"
loc-budget-allow:
  - src/codegen/index.ts
  - src/ir/prepared-vector-support.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
---

# #5166 — nested-vec element carrier (T[][])

## Problem

`number[][]` cannot claim anywhere in the IR: an identifier-head `for (const
row of m)` over a `number[][]` param claims at select then withdraws at
resolve (`array element TypeNode ArrayType could not be lowered to a primitive
ValType`); a local `const pairs: number[][] = [...]` rejects even earlier at
`vardecl-typenode:ArrayType` (isPhase1TypeNode accepts only `number[]`,
select.ts:5791-5793); `string[][]` resolves the OUTER type but dies at the
prepared-vector allowlist (`prepared vec element vec<externref>? is not
supported` — the #4486 typed demote at prepared-vector-support.ts:98-102).
This carrier gap blocks #4470 (destructuring for-of heads).

Measured 2026-08-28 (probes `.tmp/nvc-*.ts`): all of the above are SOFT
demotes on current main (#4486 landed — no hard invariant remains), legacy
runtime results correct. ALSO measured: **#3577's flatMap depth-1 illegal-cast
repro PASSES on current main** (`[1,2,3].flatMap(e => [[e*2]])` → 246) — the
buildElemCoerce ref/ref_null arm (type-coercion.ts:1037-1063) now recurses via
buildVecFromExternref with a cycle guard. #3577 closes done-by-other-means
(the landed mechanism differs from its reserve-pass sketch — see S4).

### Why this is smaller than the issue history suggests

The machinery is ALREADY nested-capable except two producer arms:

- `IrType.vec` is recursive (nodes.ts:365-370); vec-layout.ts mapType recurses
  (inner layout computed before the outer's layoutFor, :86-100, 131-136).
- integration.ts resolveVecForElementImpl keys ref/ref_null elements as
  `ref_<typeIdx>` (:4060-4064, matching legacy); resolvePhysicalVecImpl reads
  back ref elements verbatim (:4102); the GC emitter's emitElemGet is a bare
  typeIdx-driven `array.get`.
- Legacy T[][] on WasmGC is vec-of-CONCRETE-refs: inner `ref_null $__vec_f64`,
  outer struct `__vec_ref_<idx>` whose array element IS `(ref null $__vec_f64)`
  (codegen/index.ts:10796-10830). No anyref, no cast-on-get.

The two refusing arms:
1. `src/codegen/index.ts:1134-1137` (+ Array<T> twin at 1189-1192) —
   resolvePositionType's array arm throws when the element is a logical vec
   (a `number[]` element returns irVec(f64), which matches no elemVal arm).
   Asymmetry: a `string[]` element returns PHYSICAL irVal(ref_null
   $vec_externref) and passes via elemKey `ref_<idx>` — which is why string[][]
   gets one gate further.
2. `src/ir/prepared-vector-support.ts:73-102` — layoutFor's element allowlist
   (f64/i32/externref/native-string ref only).

## Implementation Plan

**Fable lane, 2026-08-28 (from the measured scout).** Mirror legacy's
concrete-ref carrier — NOT anyref+cast.

### S1 (S) — the carrier

(A) In resolvePositionType's two array arms (index.ts:1116-1145, 1169-1200):
when `elemIr.kind === 'vec'`, register the inner physical vec
(`getOrRegisterVecType(ctx,'f64'|'i32',...)`) and feed its
`{kind:'ref_null',typeIdx}` into the EXISTING `ref_<idx>` elemKey path —
number[][] then resolves exactly like string[][] does today.
(B) In layoutFor (prepared-vector-support.ts:73-102): add a vec-element arm —
the inner layout is already computed by mapType's recursion; build the outer
via `input.resolveVecForElement({kind:'ref_null',typeIdx:innerStructIdx})`,
register the layout, and deliberately SKIP physicalVectors/fromExtern for the
outer (the same treatment native-string-element vecs get). Guard async
fulfilled-resume of a nested vec with a TYPED unsupported so fromExternFor's
"lost its physical layout" plain-Error invariant is unreachable (do not
recreate the #4486 hard-error class).

### S2 (S) — op audit + OOB differential

Verify emitSafeVecGet's ref_null OOB arm (array-element-lowering.ts ~:519) for
`m[5]`, `m[0][9]`, null inner row — legacy vs IR vs Node differential tests.
`.length`, nested writes `m[0][1] = x`. JS `m[5]` is undefined; a
`(ref null $inner)` slot carries null — the next op's null-vs-undefined
behavior must MATCH LEGACY (test, don't assume).

### S3 (S) — #4470 head lift

select.ts:3961 (`!ts.isIdentifier(decl.name)` in isPhase1ForOfInScope) accepts
array binding patterns (isPhase1BindingPattern-gated); from-ast
lowerForOfVec (:10092) binds the element slot per leaf via lowerArrayPattern
(:3725) emitted inside collectBodyInstrs ahead of the user statement. f64/i32
LEAF elements only; string[][] excluded from the head lift initially (the
externref-string leaf `.length` hard error is the known adjacent trap —
anything missed soft-demotes per #4486). Re-run the 5 destructuring programs
from #4470's regression table base-vs-change: zero hard CEs.

### S4 (docs, same PR) — bookkeeping

- Close #3577 done-by-other-means: quote the passing flatMap probe (246) and
  the depth-always-one mechanism that actually landed (buildElemCoerce
  recursion), noting it differs from the issue's reserve-pass sketch.
- Flip #4470 frontmatter blocked→ready (or set done if S3 fully lands its
  scope) and flip the DESIGNED pins: tests/issue-4470.test.ts section C and
  tests/issue-4486.test.ts assert irBodyEmitted:false for these shapes
  deliberately ("the assertion that flips when #4470 adopts nested-vec
  carriers") — the carrier PR must flip those pins.

### Constraints

- S1 widens the claim surface: pass-through T[][] functions (param→arg→return,
  no vec ops) currently demote at resolve but would claim AND emit — needs
  equivalence A/B and ABI-signature parity vs legacy callers (shared
  getOrRegisterVecType identity should hold; verify against the class-claim
  typeIdx-parity guard).
- vec-layout.ts:93-94 "already carries a different prepared layout" invariant:
  outer/inner layout identity must be stable across mapType invocations —
  registry.prepareVectorLayout canonicalizes by logicalKey; VERIFY, don't
  trust.
- Out of scope: string[][] leaf ops; tuple elements; any[][] boxed-any (#2379);
  async nested-vec resumes; the local `number[][]` ANNOTATION arm
  (vardecl-typenode, isPhase1TypeNode select.ts:5791) — that selector arm is a
  separate follow-up; document it.

## Acceptance criteria

1. number[][] identifier-head for-of, `m[0][1]`, `row.length`, return
   position, and depth-3 `number[][][]` each compile with irBodyEmitted:true
   (or a documented soft demote), and run correctly in-process (the
   issue-4486.test.ts:36-42 buildImports/instantiateWasm pattern) against
   Node answers.
2. string[][] structure-only for-of stays SOFT (emit or
   type-resolution-unsupported@resolve; never invariant).
3. OOB differential (S2) matches legacy in every lane tested.
4. #4470 section C / #4486 section A pins flipped; `pnpm run check:ir-only`
   host lane stays 37/37; `pnpm run check:ir-fallbacks` banks decreases, no
   unintended growth; `node scripts/gen-ir-adoption.mjs --check` clean after
   the ForOfStatement row update.
5. Ratchet gates chained bare; scoped equivalence only; CI merge_group is the
   conformance gate.
