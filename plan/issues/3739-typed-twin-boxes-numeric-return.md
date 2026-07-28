---
id: 3739
title: "perf: a typed twin BOXES an f64 it already computed — 5 box/unbox ops per character in the tokenizer loop (9.5x vs node)"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
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

# #3739 — the typed twin boxes a number it already has

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

## Proposed fix (sliced)

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

- [ ] The tokenizer axis improves materially against the numbers above, with
      checksums still matching (a mismatched checksum voids the measurement).
- [ ] `dogfood:acorn-corpus` stays at 0 real gaps and the standalone canaries
      stay import-free.
- [ ] No equivalence-suite regressions, bisected against the merge parent.
- [ ] A mixed-return method still compiles (and still boxes).
