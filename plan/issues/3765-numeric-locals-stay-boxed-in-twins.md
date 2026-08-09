---
id: 3765
title: "perf: a provably-numeric LOCAL still boxes inside a typed twin — 3 of the 4 per-character calls in the tokenizer's hot body"
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: compiler-internals
goal: performance
related: [3753, 3754, 3755, 3683]
origin: "measured on claude/numeric-return-twin-3754, 2026-07-28"
---

# #3765 — provably-numeric locals stay boxed

## The finding

After #3754's numeric-return twin landed, the tokenizer axis did **not** move
(0.76 → 0.74 ms, inside noise) even though the twin for `nextCode` _is_ refined
— `__dc_Tok_nextCode_0`'s result local is `f64`. So the return box was not what
that axis was paying for.

Dumping the `nextCode` twin's body shows four calls per character:

```
__str_flatten, __box_number, __to_primitive, __unbox_number
```

The fields are already physical f64 slots (#3683 S4a) and the return is already
f64 (#3754). The remaining three are the **local**:

```js
Tok.prototype.nextCode = function () {
  var c = this.input.charCodeAt(this.pos); // __box_number   — boxed on write
  this.pos = this.pos + 1;
  return c; // __to_primitive + __unbox_number
};
```

Rewriting the same method without the intermediate local is the control:

| body                                   | twin size | calls in body                                                       |
| -------------------------------------- | --------: | ------------------------------------------------------------------- |
| `var c = …charCodeAt(…); …; return c;` |  64 lines | `__str_flatten`, `__box_number`, `__to_primitive`, `__unbox_number` |
| `return …charCodeAt(this.pos++);`      |  53 lines | `__str_flatten`                                                     |

Three of the four calls, and 11 lines, are attributable to one `var`.

## Why this is tractable

`analyzeNumericPropertyNames` **already computes the verdict**. Its fixpoint
maintains `numericSlots` — the set of `Slot`s whose every definition is provably
numeric — and uses it internally in `makeProver`. But `PropertyKindVerdicts`
only exports `numeric`, `string` and `numericFunctions`; `numericSlots` never
leaves the pass, so nothing types the local.

This is the same shape as #3683 S4a (numeric FIELDS → f64 slots) and #3754
(numeric RETURNS → f64 results), applied to the third and last carrier. The
analysis exists; the consumer does not.

This is also, precisely, the local half of what #3753 called
"S2 — the ~1.4x from return/local typing". #3754 did the return half. #3753's
own five-variant A/B priced the local half at **variant B, 1.34x** on the
tokenizer shape, measured before any of this work landed.

## Sketch

1. Export `numericSlots` from `analyzeNumericPropertyNames` (a `Set<Slot>`,
   already built) alongside the other three verdicts.
2. Thread a name→verdict view onto the context the way `numericPropertyNames` /
   `numericFunctionNames` already are.
3. At local ALLOCATION inside a typed twin, give a provably-numeric slot an
   `f64` local instead of `externref`, and let the existing `coerceType` handle
   both ends — the same "impose the type, let coercion be total" formulation
   #3754 used, which is what makes it safe when the analysis is imprecise.

## Risks

- Slot identity is per-scope; the verdict must be keyed on the resolved `Slot`,
  not on the NAME, or two different `c`s in two functions would share a verdict.
  (`numericFunctions` gets away with name-keying because it is deliberately a
  whole-program property; slots are not.)
- A local that is captured by a closure lives in a ref cell, not a wasm local —
  those must decline.
- `undefined` before first assignment: a `var` read before its write is
  `undefined`, which an f64 cannot represent. The slot verdict requires every
  DEF numeric but says nothing about a read that precedes them all.

## Acceptance criteria

- [x] `__box_number` / `__to_primitive` / `__unbox_number` disappear from the
      `nextCode` twin's body for the benchmark shape. **64 lines / 4 calls →
      59 lines / 1 call** (`__str_flatten` alone); the twin body is now pure
      f64/i32 arithmetic with a direct `array.get_u`.
- [x] Tokenizer axis measured by same-container interleaved A/B behind a kill
      switch (`JS2WASM_NUMERIC_LOCALS=0`), checksums matching. **0.60 → 0.26 ms,
      ≈2.3x** — see below.
- [x] A captured local, and a `var` read before assignment, both still behave.
      Both decline, with tests.
- [x] No equivalence-suite regressions. **The first full run found one** — see
      "The boolean carrier" below. Fixed, with a regression test; re-run clean.

## Result

| axis      | before | after |  node | after vs node |
| --------- | -----: | ----: | ----: | ------------: |
| tokenizer |   0.60 |  0.26 | 0.256 |    **parity** |

Same-container interleaved, checksums equal (`chk=2768640`), 5 rounds. The axis
was **2.4x slower than node**; it is now at parity. (Porffor: 2.50 ms.)

## How it was built

The lever is NOT a new mechanism. #684's `UsageInference` is already "the SINGLE
codegen entry point" for narrowing an `any` local to f64, shared by all three
local-slot minting sites. It rejected the tokenizer's `c` for one reason:
`return c` is not ToNumber-invariant.

That is a **use-site** proof — "every use already applies ToNumber". The
whole-program fixpoint has the **definition-site** dual — "every definition is
already a number" — which makes every use safe _whatever it is_. So the fix is a
second admission route into the same entry point, not a parallel path:

1. `analyzeNumericPropertyNames` exports `isNumericLocal(node, name)`.
   A **resolver**, not a set: slot identity is per-`(frame, name)`, and a
   name-keyed export would merge two different `c`s into one verdict.
2. `UsageInference.setNumericLocalOracle` installs it. Route 1 (use-site) and
   route 2 (def-site) are independent; either alone admits.
3. Three facts stay required, because neither proof speaks to them: **capture**
   (lives in a ref cell, not a wasm local), **read-before-declaration** (an f64
   slot reads 0/NaN where JS says `undefined` — a proof about what writes STORE
   says nothing about a read that precedes them all), and **bigint**.

### The grounded slot set

`numericSlots` is a GREATEST fixpoint — it starts with every slot optimistically
numeric and withdraws. That is right for its own consumer (the property verdicts
apply their own groundedness filter afterwards) but it lets a pure cycle survive
with no numeric evidence anywhere:

```js
var a = b; // `b` is in the set, so `a` stays
var b = a; // `a` is in the set, so `b` stays
```

Both are `undefined` at runtime; an f64 local would read `0`. So this consumer
gets a LEAST fixpoint instead — start empty, only ever ADD a slot provable
against slots already admitted, which a cycle can never enter. Test:
"declines a pure definition cycle".

### The boolean carrier — the one real bug this introduced

The full equivalence run caught `coercion/tostring > standalone-O > template
over any-boolean`. The mechanism is worth recording because it is a trap
inherited from the pass, not a slip in the new code:

**`isNumeric` deliberately answers TRUE for booleans.** `true`/`false` literals
and every `BOOLEAN_BINARY` comparison are numeric by that prover's definition.
For a FIELD that is correct-by-construction: #2847 brands boolean fields as
branded i32, and the property path defers to the brand with an explicit
`anyBoolean` filter ("ANY boolean write, not just an all-boolean set").

A LOCAL has no brand path. So an f64 local holding `this.n < 10` makes
`` `${b}` `` print `"1"` where JS says `"true"`.

The grounded slot set therefore applies the same ANY-booleanish exclusion. The
lesson generalises: **reusing a prover means inheriting the assumptions of its
original consumer**, and `isNumeric`'s boolean answer is only safe downstream of
a brand that the local path does not have.

## The finding that actually unblocked the measurement

The first measurement showed **zero** movement, and the twin was demonstrably
better (4 calls → 1). The reason was not the lever: with the benchmark's REAL
35 KB subject the promotion **never fired at all**, while it fired on a small
string-literal subject.

`run-js2.mjs` builds its subject as `__parts.join("")` (a single 35 KB literal
overflows the compiler's expression recursion). `Array.prototype.join` was
missing from the string-producer whitelist, so `input` was not a proven string
carrier ⇒ `input.charCodeAt(pos)` not proven numeric ⇒ the local not promoted ⇒
`this.acc + c` REJECTed. The whole chain failed on the exact shape it targets.

`join` returns a String for ANY array (§23.1.3.16), so no element proof is
needed. It needed adding in **two** places — `makeProver`'s `isString` AND
`collectStringProperties`'s own `isGroundString`, which is the one that actually
decides `stringProperties` — plus identifier/slot resolution in `isArray`, which
previously only recognised literal expressions.

This is worth recording as a measurement lesson: _a differential of zero across
a kill switch does not distinguish "the lever is worthless" from "the lever
never engaged"._ Confirming the emitted code changed on the REAL input, not a
reduced one, is what separated them. (#3755 was correctly closed on a zero
differential — but only after confirming the code did change.)

## What is left on this axis (follow-on)

With fields (#3683 S4a), returns (#3754) and now locals unboxed, the twin body
is essentially optimal. The remaining per-character cost is visible in the
trampoline, not the body — `__dc_Tok_nextCode_0` is 20 instructions of prologue
around a ~20-instruction body:

```wat
global.get 1 / local.set 1      ;; save __prev_this
local.get 0  / global.set 1     ;; set   __prev_this
i32.const 0  / global.set 70
... any.convert_extern / ref.cast (ref 17) / call $__closure_6__typed_this ...
i32.const -1 / global.set 70
local.get 1  / global.set 1     ;; restore
```

Six global accesses plus a cast per call. Since the axis is now at node parity
this is no longer the top lever, but it is the next one on this shape.
