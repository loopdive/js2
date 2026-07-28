---
id: 3765
title: "perf: a provably-numeric LOCAL still boxes inside a typed twin — 3 of the 4 per-character calls in the tokenizer's hot body"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
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
(0.76 → 0.74 ms, inside noise) even though the twin for `nextCode` *is* refined
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
  var c = this.input.charCodeAt(this.pos);   // __box_number   — boxed on write
  this.pos = this.pos + 1;
  return c;                                   // __to_primitive + __unbox_number
};
```

Rewriting the same method without the intermediate local is the control:

| body                                    | twin size | calls in body                                            |
| --------------------------------------- | --------: | -------------------------------------------------------- |
| `var c = …charCodeAt(…); …; return c;`  |  64 lines | `__str_flatten`, `__box_number`, `__to_primitive`, `__unbox_number` |
| `return …charCodeAt(this.pos++);`       |  53 lines | `__str_flatten`                                           |

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

- [ ] `__box_number` / `__to_primitive` / `__unbox_number` disappear from the
      `nextCode` twin's body for the benchmark shape.
- [ ] Tokenizer axis measured by same-container interleaved A/B behind a kill
      switch, checksums matching.
- [ ] A captured local, and a `var` read before assignment, both still behave.
- [ ] No equivalence-suite regressions.
