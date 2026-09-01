---
id: 5166
title: "IR: nested-vec element carrier — `number[][]` claims via concrete-ref elements; unblocks #4470 destructuring for-of heads"
status: done
completed: 2026-08-29
sprint: current
created: 2026-08-28
updated: 2026-08-29
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
  # Granted 2026-08-29 for the landed change-set. `resolvePositionType`'s two
  # array arms + the carrier helper (index.ts); the `layoutFor` vec-element arm,
  # its recursive element resolver and the async fulfilled-resume guard
  # (prepared-vector-support.ts); the for-of head-pattern arm (select.ts); the
  # head-lift leaf binding (from-ast.ts); the `const null` physical-carrier
  # resolution for a logical `vec` result type (lower.ts — without it the first
  # nested-vec OOB read is an untyped invariant, i.e. a hard compile error); the
  # `oobOverride` parameter that keeps a destructured leaf's missing-element
  # value identical to legacy's (array-element-lowering.ts).
  - src/codegen/index.ts
  - src/codegen/program-abi-type-planning.ts
  - src/ir/prepared-vector-support.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/lower.ts
  - src/ir/array-element-lowering.ts
func-budget-allow:
  # Same 2026-08-29 grant: the `const null` arm sits inside `emitInstrTree`,
  # which is nested inside `lowerIrFunctionBody`, so one +16-line block is
  # counted against both.
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
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

---

## Resolution (2026-08-29)

Landed S1 + S2 + S3 + S4. Every acceptance criterion is met; the carrier turned
out to need **two more arms than the plan named**, both of which were untyped
`Error`s (hard compile errors) on an otherwise fully lowerable claim.

### What changed

**S1(A) — `resolvePositionType`, `src/codegen/index.ts`.** Both array arms
(`T[]` and the `Array<T>` twin) gained one branch via a new
`nestedVecElementValType` helper: when the element resolves to a LOGICAL
`irVec`, register the inner physical vec (`getOrRegisterVecType(ctx, "f64" |
"i32", …)`) and feed its `{ kind: "ref_null", typeIdx }` into the EXISTING
`ref_<idx>` elemKey path. That is legacy `resolveWasmType`'s own carrier —
outer `__vec_ref_<inner>` whose Wasm array element is `(ref null $__vec_f64)`,
no anyref, no cast-on-get — so `number[][]` now resolves exactly the way
`string[][]` already did. Depth 3+ falls out of the recursion for free: a
`number[][]` element is already a physical `val` by the time the outer arm sees
it.

**S1(B) — `layoutFor`, `src/ir/prepared-vector-support.ts`.** A vec-element arm.
The element ValType derivation moved into a recursive `physicalElementFor`
(primitive via `asVal`, `string` via `resolveString`, nested vec via
`resolveVecForElement` on the inner element), and the allowlist accepts a
nested element alongside the materializer kinds and native-string refs. Like
native-string vecs the outer deliberately gets NO `physicalVectors` entry:
there is no `__vec_from_extern_*` for a vec-of-vecs element. The async
fulfilled-resume path is guarded with a TYPED `type-resolution-unsupported`
@resolve **before** `fromExternFor` is reached, so its `prepared async vector …
lost its physical layout` plain `Error` — which `classifyIrFailure` buckets as
an untyped invariant, i.e. the #4486 hard-error class — stays unreachable.

**Not in the plan, found by measurement — `vectorLogicalOrdinal`,
`src/codegen/program-abi-type-planning.ts`.** With S1 applied, every nested
shape hard-failed at `invariant/unexpected-internal-throw@resolve` with
`vector layout vec<vec<f64>?> has no stable Program ABI order`: the ordinal
came from a four-entry `switch` over the flat keys. It is now a pure
**structural** function of the `irTypeKey` grammar — parse the `vec<…>` nesting
(with its optional `?` suffix), then `(depth − 1) × 4 + leafOrdinal`. Two
properties matter and both hold by construction: it is identical on every
compilation of the same program (no encounter-order counter), and distinct for
every distinct nesting, so two carriers never collide on one ordering tuple.
Depth-1 keeps ordinals 0–3, so no existing module's bytes move.

**Not in the plan either — `const null`'s result type, `src/ir/lower.ts`.**
Next failure after the ordinal: `WasmGcEmitter: cannot materialize null for
IrType 'vec'`, again an untyped invariant. `emitSafeVecGet`'s out-of-bounds arm
emits `const null` typed with the ELEMENT type; that element is a physical vec
ref, and `attachIrVecLayouts` maps physical vec refs BACK to a logical
`IrType.vec`, while every backend's `emitNull` answers on ValTypes. The `const`
case in `lowerIrFunctionBody` now resolves a `vec` result type to its physical
carrier before handing the instruction to the emitter. Scoped to `vec` — every
other non-`val` result type reaches the emitter unchanged.

**S3 — the #4470 head lift.** `isPhase1ForOfInScope` accepts an
`ArrayBindingPattern` head gated on the existing `isPhase1BindingPattern`
(identifier leaves, sparse holes allowed, no defaults / rest / nesting), and
adds the leaf names to the inner scope; object patterns reject on
`forof-head-object-pattern`, wider array patterns on
`forof-head-pattern-complex`. `lowerForOfVec` takes the pattern, restricts the
row leaf to f64/i32, declares one SLOT per leaf outside the body collector, and
writes them inside it ahead of the user statement so the reads re-run per
iteration.

Two deliberate departures from the plan's sketch, both measured:

- **`lowerArrayPattern` is NOT reused.** Its `vec.get` is unchecked and TRAPS
  on a short row — measured on unmodified main, `const [a, b] = xs` over `[1]`
  is `RuntimeError: array element access out of bounds` on the IR path where
  legacy answers correctly. Reusing it would have turned `for (const [a, b] of
  rows)` over ragged data from a working legacy program into a runtime trap.
  Leaves use `emitSafeVecGet` instead.
- **The out-of-bounds value is the element ZERO, not NaN.** `emitSafeVecGet`
  gained an `oobOverride` parameter for this. Legacy binds `0` for a missing
  leaf (measured: `for (const [a, b] of [[1], [2, 3]])` sums to 3, and `b !== b`
  is false, so it is `0` and not NaN); NaN is the right answer for an `arr[i]`
  READ but would have been a silent IR-vs-legacy divergence here. Neither
  matches Node's `undefined` — see the known divergence below.
- **Leaves are SLOTS, not SSA locals.** With locals, `for (let [a, b] of m) { a
  = a + 1; … }` was a HARD error at the assignment site (`assignment to
  non-slot binding "a"`). Slots also match what the IDENTIFIER head already
  does.

### Measured — the acceptance shapes (probe `.tmp/nvc-probes.mts`)

`compile({ experimentalIR: true, trackIrOutcomes: true })`, subject `f`, run
in-process via `buildImports`/`instantiateWasm`.

| shape | before | after | ran |
| --- | --- | --- | --- |
| `number[][]` identifier-head for-of | `unsupported/type-resolution-unsupported@resolve` | **emitted** | 5 ✓ |
| `m[0][1]` | same | **emitted** | 2 ✓ |
| `row.length` | same | **emitted** | 3 ✓ |
| `number[][]` return position | same | **emitted** | 8 ✓ |
| depth-3 `number[][][]` | same | **emitted** | 9 ✓ |
| `Array<Array<number>>` | same (via the `Array<T>` arm) | **emitted** | 30 ✓ |
| `boolean[][]` (i32 leaf) | same | **emitted** | true ✓ |
| pass-through `T[][]` param→return | same | **emitted** | 5 ✓ |
| `string[][]` structure-only | same | **emitted** | 2 ✓ |
| `any[][]` / `unknown[][]` / `Uint8Array[]` | same | **emitted** | ✓ |
| `{ v: number }[][]` (object element) | soft demote | soft demote (unchanged) | 2 ✓ |
| `[number, number][]` (tuple element) | soft demote | soft demote (unchanged) | ✓ |
| local `const m: number[][]` ANNOTATION | rejects at `vardecl-typenode:ArrayType` | unchanged — follow-up | 3 ✓ |

### Measured — OOB / op differential (S2)

Same source compiled twice, IR overlay on vs forced legacy, both instantiated
and run. **18 lanes, 0 IR-vs-legacy mismatches.** The rows where the two agree
but Node does not are pre-existing legacy behaviour, identical before and
after:

| case | Node | legacy | IR | verdict |
| --- | --- | --- | --- | --- |
| `m[5]` → `typeof` | `"undefined"` | `"object"` | `"object"` | match-legacy |
| `m[5] === undefined` / `=== null` / `== null` | true / false / true | 1 / 0 / 1 | 1 / 0 / 1 | match-legacy |
| `m[0][9]` leaf OOB | `undefined` | `NaN` | `NaN` | match-legacy |
| `m[0][9]` is NaN | false | 1 | 1 | match-legacy |
| `row.length`, outer `m.length`, empty inner row | 3 / 3 / 3 | = | = | match |
| nested write `m[0][1] = 42`, row write `m[1] = r` | 45 / 77 | = | = | match |
| nested for-of both levels, depth-3 `m[0][1][0]` | 21 / 9 | = | = | match |
| depth-3 OOB `m[0][5] === undefined` | true | 1 | 1 | match-legacy |
| `string[][]` count / inner length / `rows[1][0]` | 2 / 3 / `"c"` | = | = | match |

A further 13-lane sweep over the newly-claiming shapes (`any[][]`,
`unknown[][]`, `Uint8Array[]` incl. `m[1][0]`, `string[][][]`, index loops,
`push` on a row, inline-built `number[][]` returns) is also **0/13
mismatches**.

### Measured — the #4470 destructuring heads (S3)

15 lanes, base vs change, IR vs legacy vs Node: **0 mismatches, 0 hard CEs.**
`[a, b]` / `[a]` / `[, b]` / `let [a, b]` / break+continue / short row / empty
iterable / `boolean[][]` leaves / nested for-of all claim and emit; `[a = 1]`,
`[a, ...r]`, `[[a]]` and `{ x }` reject at select; a `string[][]` row leaf and
a non-indexable flat `number[]` leaf demote softly at build.

### Constraints checked

- **Claim-surface widening.** A pass-through `T[][]` function (param → arg →
  return, no vec ops) now claims AND emits. Equivalence A/B run above; a
  claimed `f` called from a legacy `g` returns 5 on both front-ends, so the ABI
  signature matches — both sides resolve the carrier through the shared
  `getOrRegisterVecType`, which is what makes the identity hold.
- **`vec-layout.ts` layout identity — VERIFIED, not trusted.**
  `ProgramAbiTypeRegistry.prepareVectorLayout` keys `this.vectorLayouts` by
  LOGICAL KEY and raises `logical vector … was observed with two physical
  layouts` when the carrier/data cells differ, so canonicalisation is real.
  Pinned by `tests/issue-5166.test.ts` section E: six independent producers and
  consumers of the same nestings in one module compile, and the `IR vec type
  already carries a different prepared layout` invariant does not fire.

### Gates

| gate | result |
| --- | --- |
| `tests/issue-5166.test.ts` (new) | 39/39 |
| `tests/issue-4470.test.ts` (pins flipped) | 26/26 |
| `tests/issue-4486.test.ts` (pins flipped) | 16/16 |
| `pnpm run check:ir-fallbacks` | OK — no unintended / post-claim / module-level growth |
| `pnpm run check:ir-only` | READY — host **38/38** emitted, standalone 38/38, 0 invariants (identical on base; the plan's "37/37" was stale) |
| `node scripts/gen-ir-adoption.mjs --check` | clean after the `ForOfStatement` row rewrite |
| `check-loc-budget` / `check-func-budget` | OK under the grants in this file's frontmatter, bare and with `LOC_GATE_BASE` |
| `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports` | OK |
| `pnpm run typecheck`, `pnpm run lint` | clean |

### Known divergence, preserved on purpose

A missing destructured leaf (`[a, b]` over the row `[1]`) is `undefined` in JS;
both front-ends bind the element ZERO. That is pre-existing on the LEGACY path
— `tests/issue-4470.test.ts` section B asserted the Node answer and was RED on
unmodified main before this work — and the adoption reproduces it exactly. The
test now pins the MEASURED value with the Node answer recorded alongside,
because asserting Node there would hide a real IR-vs-legacy difference behind a
red that has always been red. Fixing the `undefined` binding is a change to
BOTH front-ends and is not this issue.

### Follow-ups (documented, not done)

1. **The local `number[][]` ANNOTATION arm** — `isPhase1TypeNode`
   (`select.ts`, the `vardecl-typenode:ArrayType` reject) still refuses
   `const m: number[][] = …`, so a function whose only nested vec is a LOCAL
   keeps its legacy body. The carrier is now in place, so this is a selector
   arm, not a representation gap. Explicitly out of scope here.
2. **`string[][]` LEAF ops** — the externref string leaf's `.length` is a
   separate hard error (#4470's "adjacent pre-existing defects"), which is why
   pattern heads are restricted to f64/i32 row leaves.
3. **Tuple elements** (`[number, number][]`) and **`any[][]` boxed-any
   elements** (#2379) — both still soft-demote at `resolve`; unchanged.
4. **Async nested-vec resumes** — deliberately a typed `unsupported` (see
   S1(B)); adopting them needs a nested-vec host materializer.
5. **`lowerArrayPattern`'s trapping `vec.get`** — the VariableStatement
   destructuring row still traps on a short row where legacy binds `0` (`const
   [a, b] = [1]`). Found while measuring S3, pre-existing on main, and worth
   its own id.
