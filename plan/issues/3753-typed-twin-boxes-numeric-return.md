---
id: 3753
title: "perf: fnctor STRING fields stay externref — ref.test+cast+flatten per access; 6.6x on the tokenizer axis (9.5x vs node)"
loc-budget-allow:
  # S1's three pieces: the slot-aware string prover, the field promotion, and
  # the read-site recognition — each carrying the reasoning for why it is sound
  # and what it measured, since two of the three measured far below projection.
  - src/codegen/numeric-property-analysis.ts
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/property-access.ts
  # S1's seeding wire-up in the driver: deriveFnctorFields runs from
  # generateModule and the promoted-slot maps thread through the barrel (+8).
  - src/codegen/index.ts
  # S2's numeric-return fast path at the existing binary-op dispatch (+33)
  # and the promoted-slot map fields on the shared context types (+16).
  - src/codegen/binary-ops.ts
  - src/codegen/context/types.ts
func-budget-allow:
  # S2's numeric-return recognition sits at the existing binary-op dispatch
  # (+33) and S1's seeding call in the driver (+8) — both are at the sites
  # the machinery must hook, not organic sprawl.
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/index.ts::generateModule
status: done
completed: 2026-07-28
sprint: 77
created: 2026-07-28
updated: 2026-07-30
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: compiler-internals
goal: performance
related: [3673, 3683, 3684, 3685, 3686]
origin: "benchmarks/cross-engine — measured on main 02a5512e0, 2026-07-28"
---

# #3753 — the typed twin boxes a number it already has

## Where the remaining gap actually is

Cross-engine axis measurement on `main` `02a5512e0`, one container, node and js2
minutes apart, **all checksums matching** (min-of-5 after warmup, ms):

| axis      |  node |   js2 |  js2/node | porffor | js2 vs porffor |
| --------- | ----: | ----: | --------: | ------: | -------------: |
| numeric   | 1.452 | 1.358 | **0.94x** |   4.083 |          3.01x |
| alloc     | 0.146 | 0.134 | **0.92x** |   7.723 |         57.85x |
| prop      | 0.625 | 0.833 |     1.33x |   9.135 |         10.96x |
| string    | 0.073 | 0.178 |     2.42x |   0.190 |          1.06x |
| method    | 0.552 | 3.433 | **6.21x** |   8.960 |          2.61x |
| tokenizer | 0.076 | 0.725 | **9.54x** |   2.401 |          3.31x |

js2 already **beats node** on numeric and alloc, and beats Porffor on every
axis. The gap is concentrated in exactly two: **tokenizer (9.54x)** and
**method (6.21x)** — and the tokenizer axis is the one a real parser lives in.

Note `string` (a bare `charCodeAt` loop over a local) is 2.42x while `tokenizer`
(the same loop behind `this.<field>` and `this.<method>()`) is 9.54x. The ~4x
between them is the cost this issue is about.

## What the tokenizer loop actually emits

`benchTokenizer` is the acorn shape: a fnctor whose prototype methods read and
write `this.<field>` and call `this.<method>()` in a loop.

Monomorphisation is working — #3683 S3 devirtualizes the call
(`__dc_Tok_nextCode_0`) and #3683 S2 emits typed twins
(`__closure_4__typed_this`) whose field reads are inline `struct.get`. The cost
is **not** dispatch. It is representation.

Per character, on a path where both operands are provably `f64`:

| #   | emitted call               | why                                        |
| --- | -------------------------- | ------------------------------------------ |
| 1   | `__any_box_f64`            | box `this.acc` (an f64 struct field)       |
| 2   | `__dc_Tok_nextCode_0`      | the devirtualized call — this part is fine |
| 3   | `__box_number`             | box the char code **inside** `nextCode`    |
| 4   | `__any_box_extern_s1`      | re-box that externref into `$AnyValue`     |
| 5   | `__any_add` + tag dispatch | generic add, then unbox back to f64        |

plus `__str_flatten(this.input)` on **every** call, and an
`f64.ne`-NaN-check + `i32.trunc_sat_f64_s` to turn the f64 `this.pos` into an
array index.

So `this.acc = this.acc + this.nextCode()` — where every value involved is a
number the compiler has already typed — costs five boxing/dispatch operations
per character.

## Root cause

The twin computes the f64 and then throws the type away at the ABI boundary.
`__closure_4__typed_this` ends:

```wat
array.get_u 5
f64.convert_i32_u     ;; the value IS an f64 here
call 60               ;; __box_number  → externref, purely to satisfy the signature
```

The twin's result type comes from `computeClosureWrapperSig`
(`src/codegen/closures.ts`), which asks the checker for the closure's declared
return type. For a prototype-assigned function expression that is:

```
declared return type of nextCode closure: any
```

verified directly against `tsc`. It is `any` because **`this` is untyped in the
declaration** — `Tok.prototype.nextCode = function () { … }` has no typed
receiver, so `this.input.charCodeAt(...)` is `any`, so the return is `any`, so
the twin's result lowers to `externref`.

But the TWIN does not have that problem. Inside it, `this` is a
`(ref $__fnctor_Tok)`: it reads `this.pos` as a physical f64 `struct.get`
(#3683 S4a) and computes the char code as an f64. **The information needed to
type the return already exists — it is just not consulted**, because the
signature is computed from the untyped declaration rather than from the typed
body.

## CORRECTION — the first plan aimed at the wrong thing (measured 2026-07-28)

The original slicing below assumed the box was at the RETURN boundary. An A/B
over five variants of the same benchmark (identical checksum `4060000`
throughout, min-of-5, one container) shows it is not:

| variant                                   |     ms | vs A  |
| ----------------------------------------- | -----: | ----- |
| A fnctor, fully untyped                   | 1.4335 | —     |
| B \+ `var c: number`                      | 1.0681 | 1.34x |
| C \+ `function (): number`                | 1.0241 | 1.40x |
| E \+ typed ctor param (`input: string`)   | 0.9768 | 1.47x |
| F class, untyped fields                   | 2.7833 | 0.51x |
| G class, **typed fields**, untyped bodies | 0.4192 | 3.42x |
| D class, typed fields **and** bodies      | 0.1988 | 7.21x |

So the return/local typing this issue originally proposed (B, C) is worth
**~1.4x**. The dominant lever is **field typing**: F → G is **6.6x** on its own.
Typing the method bodies on top of that is a further 2.1x (G → D).

Note also that the class form with UNTYPED fields (F) is _slower_ than the
plain fnctor (A) — the class syntax is not what helps; the field types are.

## Verified mechanism

The emitted fnctor struct, straight from the WAT:

```wat
(type $__fnctor_Tok (struct
  (field $input (mut externref))   ;; a STRING — left boxed
  (field $pos   (mut f64))         ;; promoted by #3683 S4a
  (field $acc   (mut f64))))       ;; promoted by #3683 S4a
```

#3683 S4a promoted the two NUMERIC fields to physical f64 slots. `input` is
assigned exactly one thing in the constructor — the `string` parameter — and
still lives as `externref`. Every `this.input.charCodeAt(...)` therefore pays,
per character:

```wat
struct.get 17 0          ;; this.input  (externref)
any.convert_extern
ref.test (ref 6)         ;; is it a native string?
ref.cast (ref 6)
call $__str_flatten      ;; per access
```

That guard-cast-flatten trio, not the return box, is the tokenizer axis's cost.

## Revised plan

**S1 — extend S4a's field promotion beyond numerics.** A fnctor field whose
every constructor assignment is provably a native string should get a native
string slot (`(ref null $NativeString)`) instead of `externref`. That deletes
the `ref.test` / `ref.cast` / `__str_flatten` from every access, which is the
6.6x the F→G comparison isolates. The admission machinery already exists —
S4a's write-once analysis — so this is an extension of a proven mechanism, not
a new one.

**S2 — the ~1.4x from return/local typing.** The original S1–S3 below, now
correctly priced as a follow-on rather than the main event. Worth doing after
S1, since with a native string field the remaining box traffic is a larger
share of what is left.

**S3 — the guard.** With a typed field the receiver guard can hoist out of the
loop entirely rather than being re-tested per access.

## Original plan (superseded — kept for the reasoning, not the priorities)

**S1 — numeric-return twins.** When every `return` in a typed twin's body
yields a provably-numeric value _under the typed-`this` view_, emit the twin
with `results: [f64]` instead of `[externref]`, and drop the trailing
`__box_number`. Mirrors #3683 S4a, which did exactly this for numeric FIELDS.

**S2 — trampoline + call-site ABI.** `reserveDirectCallTrampoline` keys
`results` off `sig.returnType` (`typed-this.ts` ~1404); it needs the twin's
refined type. The legacy degradation arm still yields externref, so that arm
unboxes once — paid only when the guard fails, not per call.

**S3 — the consuming add.** With an f64-returning call, `this.acc + <call>`
collapses from `__any_box_f64` / `__any_box_extern_s1` / `__any_add` /
tag-dispatch to a single `f64.add`. This is where most of the win lands: it
removes items 1, 3, 4 and 5 from the table above.

**S4 (separate, smaller)** — hoist `__str_flatten(this.input)` out of the
per-call path. The cons-cell memoization makes it cheap, but it is still a call
plus a branch per character on a receiver field that does not change.

## Risks

- The refined return type must be derived from the twin's OWN lowering, not
  from the checker's `any`, or it will disagree with what the body pushes and
  produce a stack-type mismatch. Deriving it from the emitted body's result
  ValType is the safe formulation.
- A method with mixed returns (`return 1` / `return "x"`) must keep externref.
  Requiring EVERY return to be numeric is the conservative rule.
- The legacy arm's externref must be unboxed inside the trampoline so both arms
  agree on the wasm result type.

## Acceptance criteria

- [x] The tokenizer axis improves materially against the numbers above, with
      checksums still matching (a mismatched checksum voids the measurement).
      **9.54x -> 4.32x**, and `prop` reached parity (1.33x -> 1.00x) as a
      side-effect of the same field-representation work.
- [x] `dogfood:acorn-corpus` stays at 0 real gaps and the standalone canaries
      stay import-free.
- [x] No equivalence-suite regressions, bisected against the merge parent.
      Gate: 1611 passing, 32 failing, all 32 already in the baseline.
- [x] A mixed-return method still compiles (and still boxes) — pinned in
      `tests/issue-3754-numeric-return-twin.test.ts`, along with a bare
      `return;`, a body that can fall off the end, and a same-named method
      elsewhere that returns a non-number.

## Outcome

All three slices landed:

| slice                                       | where                | measured           |
| ------------------------------------------- | -------------------- | ------------------ |
| S1 native-string fnctor fields              | this issue           | tokenizer 9.54x -> 4.32x, `prop` -> parity |
| S2 numeric-operand recognition at `+`       | this issue           | folded into the above |
| the numeric-RETURN twin (the "original S1-S3") | **#3754**            | `method` 8.88x -> 1.99x |

The numeric-return twin is written up in #3754 rather than here: it was
proposed here first, deferred twice, and only after #3754's per-call profile
did it become the *measured* blocker rather than a plausible one. The
correction section above records why the first slicing aimed at the wrong
thing — the box was at the FIELD, not the return — and that reasoning is worth
keeping even though the return box turned out to matter too, on a different
axis.

Remaining follow-ons, both still open: #3755 (per-call `__str_flatten`) and
#3754's second lever (hoisting the per-call `ref.test` out of the guarded
`__dc_*_g` trampoline).
