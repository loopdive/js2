---
id: 4122
title: "perf regression: `bindingHasMixedAssignmentCarrier` treats an UNRESOLVABLE assignment as a cross-domain one, boxing every numeric accumulator fed by a dynamic call — `method` axis 1.56x → 5.26x"
status: done
sprint: 78
created: 2026-08-03
updated: 2026-08-18
completed: 2026-08-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: value-representation
goal: performance
related: [3961, 4121, 3683, 3754, 3765]
origin: "git bisect of the cross-engine `method` axis, 2026-08-03"
# The verdict must reach `bindingHasMixedAssignmentCarrier`, which runs before
# any carrier type exists — there is no subsystem module upstream of it to hold
# the field, so the context gains one line plus its doc.
loc-budget-allow:
  - src/codegen/context/types.ts
---

# #4122 — an unresolvable assignment is not a mixed-domain assignment

## The regression

Bisected on the cross-engine `method` axis, all legs same container, checksums
(`chk=45000150000`) correct at every step, no skipped commits.

| commit                                | `method` js2/node |
| ------------------------------------- | ----------------: |
| `82c3ea98d` (parent)                  |          **1.56** |
| **`9a91db042`** (first bad)           |          **5.26** |
| `d369562d7` (current main)            |          **5.42** |

Absolute js2 `method` goes **0.82 ms → 2.92 ms in one commit**.

First bad commit: `9a91db04255f086e20d47a6d9332debbdebb2bb5` —
`fix(react): preserve dynamic value semantics in Wasm`, landed via PR #4008 for
issue #3961.

**Ablation** (diagnostic only, reverted, nothing pushed): commenting out the one
line below restores an `f64` accumulator and a loop body byte-identical to the
parent commit's.

- at `9a91db042`: 5.26 → **1.48**
- at current main `d369562d7`: 5.42 → **1.68**

So this single line accounts for the entire regression; nothing in the ~110
commits since compounds it, and there is no residual second regression
(HEAD-with-line-disabled 1.68 ≈ known-good 1.65).

## The line

`src/codegen/statements/variables.ts:150`, in `localTypeForDeclaration`:

```ts
if (decl && bindingHasMixedAssignmentCarrier(ctx, decl)) return { kind: "externref" };
```

## The defect

`src/codegen/analysis/mixed-assignment-carrier.ts`:

```ts
const assignedTag = ctx.oracle.staticJsTypeOf(node.right);
if (assignedTag === "mixed" || carrierDomain(assignedTag) !== initialDomain) {
  mixed = true;
```

`"mixed"` is what the oracle returns when it **cannot resolve** an expression —
not when it has proven that two domains collide. So *absence of evidence* is
treated as *evidence of mixing*, and the binding is demoted to the boxed
`externref` carrier.

The function's own name and doc describe the real hazard accurately ("an i32
boolean slot destroys a later string assignment by coercing it to truthiness")
— that hazard is genuine and the demotion is right for it. The bug is that the
unresolvable case is folded into the same branch.

Note the asymmetry already present in the code: a `"mixed"` **initializer**
returns `false` (no demotion, line 40), while a `"mixed"` **assignment** demotes.
The same unknown is read two different ways.

## What it costs

`benchMethod` is the plain-JS accumulator shape:

```js
var s = 0;
for (…) { s = s + p.inc(); }
```

`p.inc()` is a prototype method reached by dynamic dispatch, so
`staticJsTypeOf(s + p.inc())` is `"mixed"` (unresolvable), which differs from the
initializer's `"number"` domain. `s` is demoted from an `f64` local to a boxed
`externref` local:

```wat
 (func $benchMethod
-    (local $s f64)
+    (local $s externref)
 ...
     local.get 1
+    call $__unbox_number
     local.get 0
     call $inc
     f64.add
+    call $__box_number      ;; heap allocation, every iteration
     local.set 1
```

That is **300,000 `__box_number` allocations + 300,000 unboxes per bench call**,
where the accumulator previously lived in an f64 register.

**The blast radius is much wider than React**: any JS-source `var acc = 0`
accumulator updated from a dynamically-typed call is now boxed. That is the
single most common shape in ordinary JavaScript.

## Fix direction

Do **not** revert — #3961's hazard is real. Split the two cases:

1. **Proven cross-domain** (`carrierDomain(assignedTag) !== initialDomain`, both
   resolved) → demote, as today.
2. **Unresolvable** (`assignedTag === "mixed"`) → do **not** demote on that
   alone. Consult the whole-program numeric fixpoint
   (`analyzeNumericPropertyNames`) first: if every definition of the slot is
   provably numeric, the binding is numeric and the f64 carrier is correct.
   `s = s + p.inc()` is exactly the shape that fixpoint already answers, via
   `numericFunctions` for `inc`.
3. If the fixpoint cannot prove it either, *then* demote — genuinely unknown.

Treat the initializer/assignment asymmetry as part of the same fix: whichever
reading of `"mixed"` is correct, both sites should use it.

This is the narrow, immediate slice of #4121 (generic carrier unboxing), and it
is worth landing on its own because it is a measured 3.5x regression on main.

## Acceptance criteria

- [x] `var s = 0; for (…) s = s + p.inc();` emits an `f64` local and no
      `__box_number` in the loop body, when `inc` is provably numeric.
      Measured: `$s` externref → **f64**, box 3 → 1, unbox 2 → **0**.
- [x] Cross-engine `method` axis back to ≤2.0x vs node, measured same-container
      interleaved with matching checksums. **2.85–3.01 ms → 0.813 ms (3.6x)**,
      i.e. **1.35–1.67x vs node**, `chk=45000150000` on every leg.
- [x] The #3961 / PR #4008 hazard still behaves — pinned by three explicit
      cross-domain tests, not just a green suite.
- [x] A binding genuinely assigned across domains (`let b = true; b = "s";`)
      still gets the boxed carrier, with a test.
- [x] No equivalence-suite regressions, confirmed by a full-capture run plus a
      kill-switch A/B of the failing set (not by a count match).

## Result

| axis                  | before | after | node        |
| --------------------- | -----: | ----: | ----------- |
| method                |   2.93 | 0.813 | 0.49 – 0.60 |
| tokenizer (unchanged) |  0.253 | 0.257 | 0.17        |

## The fix took three parts, not one

Consulting the fixpoint was the easy part. Two gaps in the analysis had to close
first, each verified by querying the verdict directly before and after:

1. **Self-reference.** `s = s + f()` cannot be proven by a plain least fixpoint —
   proving `s` numeric requires `s` numeric. The grounded set now assumes the
   slot while judging its own definitions (the same induction `withSelf` gives
   the property path), then re-checks **groundedness with the assumption
   withdrawn**, so `var s = s + 1` — self-justifying, and NaN in JS — is still
   rejected, and a mutual cycle `var a = b; var b = a` still cannot enter
   (the assumption covers a slot's own name, never its partner's).

2. **`numericFunctions` on a non-`this` receiver.** The verdict was consulted
   only for `this.m()`:

   ```ts
   if (recv.kind === ts.SyntaxKind.ThisKeyword) return sets.numericFunctions.has(callee.name.text);
   ```

   `numericFunctions` is whole-program and NAME-keyed — "every visible function
   of this name returns a number on every path" — which is exactly as true of
   `p.inc()`. The restriction was conservatism, not a consequence of the
   verdict. Widened to a bare-identifier receiver only, so member chains
   (`a.b.inc()`) and call results (`f().inc()`) keep the old answer.

   This does widen a trust boundary: an `inc` that is not statically visible
   (a host/builtin method behind an opaque receiver) cannot demote the name.
   That exposure already existed for `this.m()`, whose receiver is equally
   unconstrained at runtime, and it is the same name-keying trade the file
   documents throughout.

3. **The split itself**, in `bindingHasMixedAssignmentCarrier`.

Behind `JS2WASM_MIXED_CARRIER_NUMERIC=0` (part 3). Parts 1–2 are analysis
precision improvements and are not separately gated — they can only ever add
slots to a grounded set that every consumer already treats as advisory.

## Reproduce

```bash
node benchmarks/cross-engine/run-node-porffor.mjs 2>&1 | grep '^method'
node --import tsx benchmarks/cross-engine/run-js2.mjs  2>&1 | grep '^method'
```

Ratio `js2/node`; expect ~5.3x on current main, ~1.6x with the line at
`variables.ts:150` disabled.
