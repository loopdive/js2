---
id: 2001
title: "sparse arrays: holes materialize as element-type defaults and HOFs visit them — [1,,3].forEach runs 3×, b[5]=9 join shows zeros"
status: ready
sprint: 64
created: 2026-06-10
updated: 2026-06-21
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: array-methods
goal: core-semantics
related: [1359, 1024, 2000]
origin: "2026-06-10 spec-conformance sweep (arrays agent): verified on main"
---

# #2001 — dense WasmGC vec representation has no hole concept

## Problem

```ts
const a: any[] = [1, , 3]; let c = 0; a.forEach(() => c++); c
// wasm: 3   node: 2
const b: any[] = [1]; b[5] = 9; b.join(",")
// wasm: "1,0,0,0,0,9"   node: "1,,,,,9"
```

## Root cause

Dense WasmGC vec representation — `array.new_default` fills holes with
element-type defaults; `src/codegen/array-methods.ts` HOF loops (e.g.
`compileArrayForEach` ~5721) never perform the spec's `HasProperty(O, k)`
hole skip (§23.1.3.15 step 7.b). #1359 (done) explicitly listed this as
gap 4 but closed without fixing it.

## Fix direction

Needs a representation decision (hole sentinel vs side bitmap vs accepting
divergence for typed arrays and fixing only `any[]`). Architect input
recommended before dev dispatch; intersects #1852 per-backend value
representation.

## Acceptance criteria

- forEach/map skip holes on `any[]`; join renders holes as ""
- Documented decision for typed `number[]` (where TS semantics make holes
  unrepresentable anyway)

## Dupe check

#1359 residual (explicitly unfixed gap 4); #1024 covers holes in
destructuring only. Refiled as residual.

## Addendum (2026-06-11 iterators-agent sweep)

Same representation family, different trigger: array destructuring past
the source length on numeric element types binds the typed default
instead of undefined — `const [p, q] = [1]` → `q` stringifies "0"
(node: "undefined"); `const [a=5, b=6] = [undefined, null]` → `b` →
"0" (node: "null" — default correctly NOT applied to null, but the
null is then erased). `emitBoundsCheckedArrayGetUndef`
(`src/codegen/destructuring-params.ts:141-190`) only yields JS
undefined for externref element types. Fold into the same
representation decision as the hole semantics above (#1852/#1931).

## Re-validation (2026-06-17, dev-1, against origin/main @330b3cb66)

RE-VALIDATED per the s63 verify-still-repros-first discipline. The repro is
**still live** — all four documented cases reproduce on current main
(sprint-62 value-rep work did NOT fix it):

| Case | wasm (got) | node (exp) |
|---|---|---|
| `[1,,3].forEach(()=>c++)` count | `3` | `2` |
| `b=[1]; b[5]=9; b.join(",")` | `"1,0,0,0,0,9"` | `"1,,,,,9"` |
| `const [p,q]=[1]; String(q)` | `"0"` | `"undefined"` |
| `const [a=5,b=6]=[undefined,null]; String(b)` | `"0"` | `"null"` |

**Disposition: NOT a developer point-fix despite the task framing.** The
issue's "Fix direction" gates this behind a representation decision (hole
sentinel vs side bitmap vs accept-divergence for typed arrays) and states
"Architect input recommended before dev dispatch; intersects #1852
per-backend value representation." That gate is unmet, blast radius is the
whole dense-WasmGC-vec representation (every array program), and
feasibility is `hard` / reasoning_effort `high`. Routing back to
architect for the representation ratification (as #2001/#1852/#1931) before
any dev implementation — dev-1 is moving to standalone-priority work per
tech-lead direction.

> **Spec is in (2026-06-21).** Representation decision ratified below: a
> `$Hole` anyref singleton sentinel for `any[]`/untyped vecs only; typed
> `number[]`/`boolean[]` accept divergence (out of scope). Staged into S1–S4,
> three of which are independently landable. Status kept `ready` — implementable.

## Implementation Plan (architect spec — 2026-06-21)

### 0. Re-grounded current behavior (probed on this branch, host mode)

Before specifying, the four documented repros plus four discriminating cases
were re-run with `compile()` + `buildImports()` + `setExports()` (the
`tests/array-methods.test.ts` harness). Results sharpen the root cause:

| Case | got | node | note |
|---|---|---|---|
| `[1,,3].forEach(()=>c++)` count | `3` | `2` | **true bug** — HOF visits the hole |
| `[1,,3].map(x=>x).join(",")` | `"1,,3"` | `"1,,3"` | looks right, but only because `x=>x` is idempotent and undefined ToStrings to `""`; callback still *fires* on the hole |
| `[1,,3].join(",")` (literal) | `"1,,3"` | `"1,,3"` | **right by coincidence** — hole stored as externref-`undefined`, observationally `==` explicit `undefined` |
| `[1,undefined,3].join(",")` | `"1,,3"` | `"1,,3"` | identical to the hole case — proving hole ≡ undefined today |
| `typeof a[1]` (hole read) | `"undefined"` | `"undefined"` | right by coincidence (undefined-storage) |
| `b=[1]; b[5]=9; b.join(",")` (`any[]`) | `"1,0,0,0,0,9"` | `"1,,,,,9"` | **true bug** — index-grow gap fills with element default, not holes |
| `b=[1]; b[5]=9; b.forEach(()=>c++)` | `6` | `2` | grow-gap is reachable (length jumped to 6) and visited |
| `const [p,q]=[1] as any[]; typeof q` | `"undefined"` | `"undefined"` | already correct for **externref** element |
| `const [p,q]=[1]; String(q)` (numeric tuple) | `"0"` | `"undefined"` | **addendum bug** — numeric default bound |

**Refined diagnosis.** The dense vec is `struct(field0 length:i32, field1
data:(ref $__arr_<elem>))`. For `any[]` the element type is `externref`, and a
literal elision (`OmittedExpression`) is lowered through
`compileExpression(el, externref)` → `expressions.ts:851` → `emitUndefined` →
the slot holds JS `undefined`. So **a hole is stored identically to an explicit
`undefined`**. That makes *reads* and *join* look correct, but it is
impossible for any HOF to honour §-step "HasProperty(O, ‹k›) is false ⇒ skip"
because the hole carries no distinguishing mark. The visit-skip semantics
(forEach/map/filter/some/every/reduce/indexOf) are the irreducible part that
*requires* a representation change; join/read correctness then rides on the
same mark (and becomes robust rather than coincidental).

### Root cause (one line)

`any[]` holes are stored as externref-`undefined`, indistinguishable from a
real `undefined`, so no HOF can perform the spec's HasProperty hole-skip; and
the index-grow path (`b[5]=9`) fills the gap with `array.new_default`
element defaults (null/0) instead of holes.

### Representation decision — RATIFIED: `$Hole` anyref singleton sentinel (option 1)

**Chosen:** a single module-global **`$Hole`** sentinel — a unique, immutable
heap ref in the anyref domain, distinct from every value the language can
produce (including JS `undefined`, `null`, `$box_number`, `$box_boolean`,
NativeString, `$Object`, closures, `i31ref`). A vec slot equal to `$Hole`
(by ref identity / `ref.eq`) **is** an absent index; anything else is present.

**Why this and not the alternatives:**

- **vs. side bitmap** (a parallel `(array i8)`/bitset of presence bits per
  vec): doubles the vec footprint, must be threaded through *every* vec
  producer (literal, `array.new_fixed`, push/pop/shift/unshift/splice/slice/
  concat/fill/copyWithin/with/toReversed/toSorted/toSpliced, spread, grow) and
  kept in lockstep on every mutation — a large, error-prone surface with a
  permanent cost on the **dense common case**. A sentinel costs nothing until a
  hole actually exists and reuses the slot already present.
- **vs. accept-divergence-everywhere**: fails the acceptance criterion
  ("forEach/map skip holes on `any[]`").
- **Fit with #1852 (ratified).** #1852's GC dynamic residue is exactly "an
  anyref-domain typed heap-struct family dispatched by `ref.test`/`br_on_cast`"
  (`$box_number`/`$box_boolean`/`$BigInt`/NativeString/`$Object`). `$Hole` is
  one more singleton arm in that family — **standalone-native** (no host
  import), dispatched the same way the existing `__is_truthy`/`__typeof_*`/
  strict-eq helpers dispatch the box structs. It is the smallest possible
  addition that is consistent with the ratified representation, and it lives
  **only** in the dynamic (`externref`/anyref) residue — exactly where #1852
  says the boxed family belongs and nowhere near the typed mainline.

**Sentinel shape.** Register one empty WasmGC struct type `$Hole = (struct)`
(no fields) and one module-global immutable `(global $__hole (ref $Hole)
(struct.new $Hole))`, exposed via a getter helper `__hole_sentinel() ->
(ref $Hole)` so codegen sites can push it. Identity test is `ref.test (ref
$Hole)` on an `anyref`/`externref` (after `any.convert_extern` when the value
is in externref interchange form). Do **not** reuse i31ref or a magic boxed
number — those collide with real small ints/NaN (the #1852 G3 hazard notes).

**Critical invariant — a hole is never observed *as* the sentinel.** Per
§ToObject/Get, reading `a[i]` for an absent `i` yields `undefined`, NOT the
sentinel. Therefore **every value-producing read of a vec slot that may hold
`$Hole` must map `$Hole → undefined` at the read boundary.** The sentinel is
an *internal* in-array marker; it must not leak into a binding, a callback
argument, an arithmetic coercion, or `===`. This is the single most important
correctness rule for implementers and is the gating check in S1's tests.

`length` is unaffected — it is the explicit `field0`, already independent of
slot contents; holes count toward length exactly as the spec requires.

### Scope boundary (documented divergence — required by acceptance criteria)

- **In scope:** `any[]`, `unknown[]`, and **untyped array literals whose vec
  resolves to an `externref` element type** (this is what `[1,,3]` /
  `const a: any[] = …` lower to today — see literals.ts:3298-3309 `any[]`
  tag-recovery widening). These are the ONLY arrays where TS semantics make a
  hole representable: an `any`/`unknown` element may legitimately be "absent".
- **Out of scope (accepted divergence):** typed `number[]`, `boolean[]`,
  `string[]`, struct `T[]` — their element ValType is `f64`/`i32`/`ref`, and
  TS's type system guarantees every element *is* a `number`/`boolean`/… so a
  hole is unrepresentable in the source type anyway. `[1,,3]` declared
  `number[]` keeps materializing `0` at the hole and HOFs keep visiting it.
  This matches V8-vs-typed-array intuition and keeps the **dense numeric
  kernel byte-identical** (see Regression mitigation). Document this in the
  test file header and the `compileArrayLiteral` comment.
- **Gate everywhere on `elemWasm.kind === "externref"`** (the vec's element
  ValType), never on the TS type — the element ValType is the single source of
  truth that the slot can physically hold a ref and therefore the sentinel.

### Slices (independently landable marked)

#### S1 — `any[]` literal elision stores `$Hole`; reads + join map it back. **[independently landable]**

This is the foundation: introduce the sentinel and make literal holes real,
without yet changing HOF visit semantics (so no behavior regresses; join stays
`"1,,3"`, reads stay `undefined`, but now *because* of the sentinel).

- **Register the type + global.** Add `$Hole` struct type and `$__hole`
  global + `__hole_sentinel`/`ref.test`-helper registration alongside the
  existing box-struct family. Likely in `src/codegen/index.ts` near the
  `$box_number`/`$box_boolean` registration (`index.ts:~8121` per #1852 §0) so
  it participates in the same dynamic-family dispatch and dead-elim survives it
  (register **once, late** — heed the type-index-shift hazard in
  `project_type_index_shift_and_deadelim`: do not push the struct type
  mid-class-collection).
- **Literal lowering — `src/codegen/literals.ts:3318-3330`** (the no-spread
  `array.new_fixed` path). Today every element (incl. an `OmittedExpression`)
  goes through `compileExpression(el, elemWasm)`. Add: **iff `elemWasm.kind ===
  "externref"` AND `ts.isOmittedExpression(el)`**, push `$Hole`
  (`call __hole_sentinel; extern.convert_any` to land it as the externref the
  `array.new_fixed` expects) instead of `emitUndefined`. An explicit
  `undefined` literal element is NOT a hole — keep its current `emitUndefined`.
  - Mirror in the **spread fill loop** (`literals.ts:3340+`) for any
    `OmittedExpression` interleaved with spreads.
  - Leave the f64 sNaN-sentinel branch (literals.ts:3323) and the tuple path
    (`compileTupleLiteral`, literals.ts:2621-2649) untouched — those are typed
    and out of scope.
- **Element read — map `$Hole → undefined`.** Find the externref element-access
  read (`compileElementAccess` for a vec with externref element). After the
  bounds-checked `array.get`, add: `local.tee $tmp; ref.test (ref $Hole)` and
  if true substitute `emitUndefined`. Implement as a small reusable helper
  `emitHoleToUndefined(ctx, fctx)` (stack: `[externref] → [externref]`) so S2/S4
  reuse it. Grep the element-access read site:
  `grep -n "array.get" src/codegen/property-access.ts src/codegen/expressions.ts`
  and gate on the vec elem ValType being externref.
- **join — `compileArrayJoinNative` (array-methods.ts:5063-5079) and the host
  `compileArrayJoinExtern`/`compileArrayJoin` lanes.** The externref element
  branch currently calls `__extern_toString` on the raw slot. Per §Array.join
  step "If element is undefined or null, let R be ''… (and a hole is treated as
  undefined)", add a `ref.test (ref $Hole)` ahead of the `__extern_toString`
  call: hole ⇒ empty native string; else existing path. (Today this is right
  only because the hole *is* undefined; after S1 the slot is `$Hole`, so this
  branch is REQUIRED to keep `"1,,3"` — S1 must land join-awareness in the same
  PR or join regresses to `"[object Object]"`/garbage.)
- **Acceptance (S1):** `[1,,3].join(",") === "1,,3"`; `typeof [1,,3][1] ===
  "undefined"`; `[1,,3][1] === undefined` (strict-eq must see undefined, not
  the sentinel — exercises the read-boundary invariant); `String([1,,3][1])
  === ""`; `[1,,3].length === 3`. Plus a typed-array guard:
  `([1,,3] as number[]).join(",") === "1,0,3"` UNCHANGED.

### S1 landed (2026-06-21, sendev-holes-s1)

**Done.** The `$Hole` anyref singleton sentinel is registered
(`src/codegen/array-holes.ts` — lazy `ensureHoleType`: a zero-field immutable
`(struct)` type + an immutable `(global $__hole (ref $Hole) (struct.new $Hole))`
const-init singleton, no host import, dead-elim-pruned when unused). A literal
elision (`OmittedExpression`) in an `externref`-element (`any[]` / untyped) vec
now stores `$Hole` instead of `emitUndefined` (`literals.ts` — both the
`array.new_fixed` no-spread path and the spread fill loop). A cheap AST pre-scan
(`scanForArrayHoles` → `ctx.usesArrayHoles`, wired in `index.ts` beside
`scanForNewTarget`) gates everything; hole-free and typed (`number[]`/`boolean[]`
= f64/i32 element) modules are byte-identical (verified: deterministic-bytes +
op-unchanged guards).

**Scope-of-change finding — the read-boundary mapping is NOT confined to
`a[i]` + join.** The spec scoped S1 to "literal store + element-read + join" and
deferred all HOFs to S2. Implementing it revealed that **storing `$Hole`
regresses every value-producing reader that was not simultaneously updated** —
`for-of`, array destructuring, and *all* HOFs (`forEach`/`map`/`filter`/`some`/
`every`/`find`/`findLast`/`findIndex`/`reduce`/`reduceRight`/`indexOf`/
`lastIndexOf`/`includes`), plus `at`/`pop`/`shift` — because before S1 a hole was
stored *as* `undefined`, so all of them already read `undefined`; after S1 they
read the raw `$Hole` struct (`typeof === "object"`). A hole reaching an
un-mapped reader between S1 and S2 landing is a real regression, so the
representation change is **not independently landable as "store-only"**. S1 was
therefore widened to land the **universal `$Hole → undefined` value-read
mapping** at every value boundary (the reusable `emitHoleToUndefined` /
`holeToUndefinedInstrs` helper, gated on `usesArrayHoles && externref`). This is
the §ToObject/Get invariant ("an absent index reads as `undefined`, never the
sentinel"), now enforced everywhere.

What S1 does **NOT** do (still genuinely S2/S3/S4 — visit *semantics*, not value
leaking): the HOF **visit-skip** (`forEach` still *visits* the hole, observing
`undefined`; spec wants the callback NOT called) (#2001 S2); `map` producing a
**result-hole** at the hole index rather than `undefined` (S2); `indexOf`
**skipping** holes rather than reading them as undefined (S2 — note `includes`
is already spec-correct since it uses Get); **index-grow** `b[5]=9` filling the
gap with `$Hole` rather than the element default (S3); and **destructuring-past-
length** numeric-default fix (S4). Copy methods (`slice`/`concat`/`spread`/etc.)
preserve holes correctly by copying the externref unchanged.

Key implementation note for follow-ups: `holeToUndefinedInstrs` calls
`emitUndefined`, whose late-import flush mutates `fctx.body`; when used inside a
**detached** instruction-list builder (the HOF callback-arg path,
`indexOf`/`lastIndexOf`/`includes` loop bodies, `reduce`/`reduceRight`), the
caller **must pre-register + flush `__get_undefined`** (via `ensureGetUndefined`
+ `flushLateImportShifts`, or rely on `setupArrayLoop` which now does it) BEFORE
building the detached list — otherwise the flush shifts an already-captured
closure/import funcIdx out from under a baked `call_ref`/`call` → runtime
null-deref. This is done at every such site.

Tests: `tests/issue-2001-s1-hole-literal.test.ts` (host + standalone, 31 cases —
literal read/join/length, the read-boundary invariant across for-of /
destructuring / all HOFs / at / pop / slice, typed no-regression + deterministic
bytes). Gates green: tsc, prettier, biome lint, `check-test262-hard-errors` (0,
no growth), `check:ir-fallbacks` (no increase).

### S2 landed (2026-06-21, sd-1838)

**Done.** HOF visit-SKIP semantics on the dense WasmGC vec, the headline fix
(`*-ary-forEach-15.4.4.18-2-9` family + the `does-not-visit-deleted/absent`
suite). Two reusable gate helpers in `src/codegen/array-holes.ts`:

- `holeSkipGate(ctx, data, i, arrTy, work, onHole?)` — wraps a branch-free
  per-iteration `work` in `if ($Hole) onHole else work`; used by
  `forEach`/`filter`/`map`. For `map`, `onHole` writes `$Hole` into the result
  slot (and the result vec is forced to externref-element so it can hold the
  sentinel) → a source hole yields a **result hole** (`[1,,3].map(x=>x*10)` →
  `"10,,30"`).
- `holeContinueGate(ctx, data, i, arrTy, onHole?, reverse?)` — for loop bodies
  whose `work` contains its OWN `br` into the loop/block (`some`/`every`
  early-exit `br 2`, `indexOf`/`lastIndexOf` match-break, `reduce`/`reduceRight`
  fold). Emits the hole test at the SAME control depth and, on a hole, does
  `i±1; br 1` (continue) directly — so the present-index work that follows is
  UNGUARDED and its branch depths are unchanged (avoids the depth-off-by-one
  hazard of nesting the work in an extra `if`). `reverse` flips `i++`→`i--` for
  reduceRight / lastIndexOf.

Per-method: `forEach`/`some`/`every` skip (callback not called, scan continues);
`map` skips + result-hole; `filter` omits; `indexOf`/`lastIndexOf` skip (a hole
never matches — supersedes S1's hole→undefined read-map for these two);
`reduce`/`reduceRight` skip the fold AND seek the first/last **present** element
for the no-initial-value seed (empty/all-holes ⇒ TypeError). `includes` is
UNCHANGED (uses Get → `[,].includes(undefined) === true`, keeps S1's read-map),
and `find`/`findIndex`/`findLast`/`findLastIndex` are UNCHANGED (Get semantics —
they VISIT a hole observing `undefined`, not HasProperty-skip). All gated on
`ctx.usesArrayHoles && elemType.kind === "externref"` → typed `number[]`
(f64/i32) kernels are byte-identical (no `ref.test`).

Tests: `tests/issue-2001-s2-hof-skip.test.ts` (21 cases — forEach/map/filter
visit-skip, some/every skip-not-undefined, indexOf/lastIndexOf skip vs
includes/find Get, reduce/reduceRight skip+seed-seek+empty-throw, typed
no-regression + deterministic bytes + standalone). The S1 read-boundary HOF
assertions in `issue-2001-s1-hole-literal.test.ts` were updated from S1's interim
"visit-as-undefined" to S2's spec-correct visit-skip.

#### S2 — HOF visit-skip on the dense vec (forEach/map/filter/some/every/reduce/indexOf). **[depends on S1]**

The headline fix. The `$Object`-backed array-like path already has the
machinery — `__extern_has_idx` + `gatedBody`/`hasIdxCheck`
(array-methods.ts:848-869). The gap is the **dense vec** loop driver
(`setupArrayLoop` at array-methods.ts:5665; `loopExitCheck`/`emitArrayLoop` at
6040-6051; consumed by `compileArrayForEach` 6628, `compileArrayMap` 6187,
`compileArrayFilter` 6101, `compileArraySome`/`Every`/`Reduce`/`indexOf`).

- Add a **hole gate** to the dense-vec per-iteration body, parallel to
  `gatedBody`: emit `data[i]; ref.test (ref $Hole); i32.eqz; if (…body…)`,
  **only when the vec elem ValType is externref** (so number[] loops are
  untouched, no `ref.test` on an f64). Thread an `elemIsExternref` flag through
  `setupArrayLoop`'s return (`ArrayLoopLocals`) and wrap each method's
  `loopBody` with `gateHoleSkip(loop, inner)` at the call sites
  (`compileArrayForEach:6654`, `compileArrayMap:6164`, `compileArrayFilter`,
  etc.). The hole index is simply skipped (fall through to `loopIncrement`).
- **Per-method spec nuances** (cite §23.1.3.* in the PR):
  - `forEach`/`some`/`every`/`find`/`findIndex`: callback NOT called for holes;
    `some`/`find` keep scanning, `every` does not falsify on a hole.
  - `map`/`filter`: a hole in the source produces a **hole in the result** at
    the same index (map) / is omitted (filter). For `map` this means the result
    vec slot must itself be `$Hole` at that index, not `undefined` — write
    `$Hole` into the result `array.set` when the source slot tests `$Hole`
    (array-methods.ts:6164/6273). For `filter`, holes contribute nothing.
  - `reduce`/`reduceRight`: holes are skipped for both the initial-accumulator
    seek (the existing forward/back HasProperty scan at array-methods.ts:1189/
    1347 is the `$Object` analog — mirror it for the dense vec) and the fold.
  - `indexOf`/`lastIndexOf`: skip holes (never match). `includes`: per spec uses
    Get (holes ⇒ undefined), so `[,].includes(undefined) === true` — do NOT
    hole-skip includes; let it read `$Hole→undefined` via S1's read mapping.
- **Callback argument is undefined, never the sentinel** — but since holes are
  *skipped*, the callback never receives a slot value for a hole. The only
  place the sentinel could leak to a callback is `map`'s result read-back or a
  non-skipping method; covered by the S1 read-boundary mapping. Add an explicit
  test that a callback that records `typeof arg` never sees anything for a hole
  index.
- **Acceptance (S2):** `[1,,3].forEach` count `2`; `[1,,3].map(x=>x*10)`
  visits `2`, result `join` `"10,,30"`; `[1,,3].filter(()=>true).length === 2`;
  `[1,,3].some(x=>x===undefined) === false` (hole skipped, not seen as
  undefined) BUT `[1,undefined,3].some(x=>x===undefined) === true`;
  `[1,,3].indexOf(undefined) === -1`; `[1,,3].includes(undefined) === true`;
  `[5,,,2].reduce((a,b)=>a+b) === 7`. Typed guard: `([1,,3] as
  number[]).forEach` count stays `3`.

#### S3 — index-grow past length writes holes, not element defaults. **[independently landable after S1]**

`b[5]=9` on a `length-1` `any[]`: the grow path
(`src/codegen/expressions/assignment.ts:3103-3193`) does
`array.new_default(newCap)` + `array.copy` of the old `[0,oldCap)` + `array.set
data[idx]=val`, then bumps `vec.length` to `idx+1`. The indices `[oldLen, idx)`
become reachable (within length) but hold the element default — for an
externref vec that is `ref.null extern` (which currently ToStrings via
`__extern_toString` to `"0"`, the observed bug), for f64/i32 it is `0`.

- **Only for externref-element vecs**, after the grow `array.copy` and before
  the `array.set data[idx]=val`, **fill the gap `[oldLen, idx)` with `$Hole`**.
  Emit a tiny fill loop (or `array.fill $arr data $hole start=oldLen
  count=idx-oldLen` if `array.fill` is in the Instr union — grep
  `"array.fill"`; the existing `compileArrayFill` at array-methods.ts:7652 uses
  it). Note: the gap is `[currentLength, idx)`, where `currentLength` is
  `vec.length` *before* the bump, NOT `oldCap` — capacity may already exceed
  length from a prior shrink. Read `field0` into a local before the grow `if`
  and use it as the fill start.
- The grown trailing capacity `(idx, newCap)` stays `array.new_default`; it is
  beyond `length` so never observed (the same as today).
- Typed vecs (f64/i32): unchanged — the gap stays `0`/default (accepted
  divergence). Gate the whole fill on `elemWasm.kind === "externref"`.
- **Acceptance (S3):** `b=[1] as any[]; b[5]=9; b.join(",") === "1,,,,,9"`;
  same `b`, `forEach` count `2`; `typeof b[3] === "undefined"`; `b.length ===
  6`; `b[5] === 9`. Typed guard: `b:number[]=[1]; b[5]=9; b.join(",")` stays
  `"1,0,0,0,0,9"`.

#### S4 — destructuring past source length binds `undefined`, not the numeric default. **[independently landable; addendum]**

`const [p,q]=[1]` (numeric tuple/array) binds `q=0`; should be `undefined`.
`emitBoundsCheckedArrayGetUndef` (`destructuring-params.ts:185-235`) already
yields JS `undefined` for **externref** element types (probe confirms `const
[p,q]=[1] as any[]; typeof q === "undefined"` works today). The bug is the
**numeric** element path: it falls through to `emitBoundsCheckedArrayGet`
(line 192) which returns the f64/i32 default `0` for OOB.

- This is genuinely the same representation family but, unlike S1–S3, a numeric
  tuple element **cannot** hold `$Hole` (the binding target's ValType is f64).
  Two viable approaches — spec prefers **(a)**:
  - **(a) sNaN sentinel for f64 OOB (reuse the existing `#1024` mechanism).**
    `emitBoundsCheckedArrayGet` for an f64 element already coexists with the
    sNaN `0x7ff00000deadc0de` default-trigger sentinel used by the literal
    path (literals.ts:3324) and recognized by `emitDefaultValueCheck`. Make the
    **OOB branch** of the f64 bounds-checked get return the sNaN sentinel
    instead of `0`, so the destructuring default-check fires and, with no
    default present, the binding is initialized to `undefined` (its declared
    slot, which for a `let`/`const` of inferred-`any` is externref-undefined;
    for a numeric-typed binding it stays NaN, which is the closest representable
    — but `const [p,q]=[1]` infers `q: number`, and `String(NaN)==="NaN"` not
    `"undefined"`). **Therefore approach (a) only fully fixes the case where the
    binding's static type is `any`/`unknown`** (externref slot). For a
    genuinely `number`-typed binding bound OOB, TS itself would error or infer
    `number` and the divergence (`NaN` vs `undefined`) is in the same
    accepted-divergence bucket as typed holes — document it.
  - **(b) widen the tuple/array vec to externref when a destructuring pattern
    is longer than the literal** so OOB reads hit the working externref-undef
    path. Heavier; only if (a)'s `any`-binding fix is judged insufficient.
  - Recommended: ship **(a)** for the `any`/`unknown` binding case (matches the
    issue's `String(q)` repro when `q` is untyped), and **explicitly document**
    that a statically `number`-typed OOB binding yields `NaN` (accepted
    divergence, same root as typed holes). The `const [a=5,b=6]=[undefined,
    null]` sub-case is a *different* axis (explicit `null`/`undefined` element,
    not OOB) — `b` should be `null` (default not applied to `null`); that is the
    null-erasure path in literals.ts:3150-3159 (`hasNullLiteral` widening) and
    should already widen `[undefined,null]` to externref — verify with a test;
    if it still binds `0`, the fix is to ensure the `[undefined, null]` literal
    picks externref (it contains a `null` literal ⇒ the `hasNullLiteral` branch
    should fire), not a destructuring change.
- **Acceptance (S4):** `const [p,q]=[1]; String(q)` → `"undefined"` for an
  untyped `q`; `const [a=5,b=6]=[undefined,null]; String(b)` → `"null"`;
  `const [x=9]=[]; x === 9` (default still applies on true absence).

### Standalone parity (required — dual-mode)

No new host import. `$Hole` is a pure WasmGC struct + global; the
`ref.test`/`ref.eq` dispatch is engine-native and works identically under
`--target standalone`/`wasi`. The read-boundary `$Hole→undefined` mapping uses
the existing standalone undefined path (`ensureGetUndefined`/the externref
undefined global), NOT `__get_undefined` host import — mirror the guard in
`emitBoundsCheckedArrayGetUndef` (destructuring-params.ts:199-206) that already
forces the standalone fallback when `ctx.nativeStrings`. join already has a
native lane (`compileArrayJoinNative`) where the `$Hole` test must land. Add a
standalone variant of at least one S1 and one S2 acceptance test (the
`tests/issue-2505-anyarray-join.test.ts` `runStandalone` harness pattern:
`compile(src,{target:"standalone"})` + `WebAssembly.validate` + empty imports).

### Regression mitigation (keep the dense numeric kernel byte-identical)

- **Every sentinel touch point is gated on `elemWasm.kind === "externref"`** —
  the vec element ValType. number[]/boolean[]/string[]/struct[] vecs never see
  a `ref.test (ref $Hole)`, never get a hole-skip gate, never change a single
  emitted op. This is the #1852 §3 typed-mainline-unboxed invariant applied
  locally.
- **Guard test (per the #1852 §3 pattern):** an op-count / WAT snapshot on a
  typed numeric kernel — e.g. `const a=[1,2,3,4]; let s=0; a.forEach(x=>{s+=x});
  return s;` — asserting the emitted forEach loop body is unchanged by S1–S4.
  Put it in the S2 PR (the one that touches `setupArrayLoop`).
- **Dead-elim / type-index safety:** registering `$Hole` adds a type; follow
  `project_type_index_shift_and_deadelim` — register late and once, after class
  collection, so the struct typeidx does not desync. If `$Hole` is unreferenced
  in a module (no `any[]`), dead-elim should prune it; ensure the global +
  getter are only emitted when first referenced (lazy registration like the box
  structs), or that they survive pruning cleanly.
- **i31ref interaction (#1852 G3):** when G3 lands, small-int dynamic values may
  arrive as `i31ref`. `ref.test (ref $Hole)` is disjoint from `i31` (struct vs
  i31), so the hole test is unaffected; but ensure the hole test runs on the
  raw slot BEFORE any i31/box unwrap so a present small-int is never mistaken
  for a hole (it can't be — different ref kinds — but order the test first for
  clarity).

### Test plan

- **Vitest acceptance** (new `tests/issue-2001-sparse-holes.test.ts`, host
  mode via `buildImports`+`setExports`): the per-slice acceptance bullets above.
  Group by slice so a partial landing (e.g. S1+S2 without S3) still has a green
  subset.
- **Standalone subset** (`runStandalone` harness): one literal-hole join + one
  forEach-skip + one index-grow join, asserting `WebAssembly.validate` and
  correct lengths (use `.length`/`.charCodeAt` returns to avoid native-string
  decoding, per the #2505 test pattern).
- **Typed no-regression guards:** `([1,,3] as number[]).join` → `"1,0,3"`;
  `number[]` forEach count unchanged; the op-count snapshot above.
- **test262 family** (the conformance lift — non-failing dashboard, but track
  the delta): `built-ins/Array/prototype/{forEach,map,filter,some,every,
  reduce,reduceRight,indexOf}/` — each has ~3 sparse/HasProperty-skip cases
  (e.g. `forEach/15.4.4.18-2-9.js`, the `*-9-b-*` "does not visit deleted/absent
  elements" family); `language/expressions/array/S11.1.4_A*` (elision length /
  trailing-comma length). NB: most of these create holes via `delete`/
  `Object.defineProperty`/length-extension on a plain array — those reach the
  vec via different producers; the literal-elision + index-grow paths this spec
  fixes are the js2wasm-reachable subset. Expect movement primarily in the
  array-literal-elision and `arr[k]=v`-grow tests; `delete arr[i]` hole creation
  is a **follow-up** (the `delete` operator on a vec index would need to write
  `$Hole` too — note it as a known gap, not in scope here).

### Effort / risk

- **S1:** medium (~120 LOC) — type/global registration + 3 read/write
  boundaries. Risk: low, gated; the join branch is the only must-land-together
  coupling. Independently landable.
- **S2:** medium-hard (~150 LOC) — touches the shared dense-vec loop driver and
  6+ method call sites; map result-hole write and reduce seed-scan are the
  fiddly bits. Risk: medium (loop-depth/`br` arithmetic when adding the gate
  `if` — mind the `gatedBody` depth+1 note at array-methods.ts:858). Depends
  on S1.
- **S3:** small-medium (~60 LOC) — one fill loop in the grow path, gated.
  Risk: low. Independently landable after S1.
- **S4:** small (~40 LOC) — one OOB-branch sentinel swap, plus a `[undefined,
  null]` widening verification. Risk: low-medium (the typed-binding `NaN`
  divergence must be documented, not "fixed"). Independently landable.
- **Overall:** `hard` confirmed, but **decomposed into one medium-hard slice
  (S2) and three small/medium independently-landable slices.** Recommended
  landing order S1 → S2, with S3 and S4 parallel after S1. Each slice ships its
  own acceptance subset and its own typed-array no-regression guard.
