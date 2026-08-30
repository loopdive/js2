---
id: 5207
title: IIFE arguments are evaluated in the CALLEE's scope — silent wrong values whenever the callee declares a binding with the caller's name
status: done
completed: 2026-08-29
sprint: current
priority: high
horizon: m
goal: core-semantics
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
---

# #5207 — IIFE argument-list scope leak (silent wrong values)

## Problem

Ninth Temporal module-init blocker (#4628), and a general-purpose
correctness bug well beyond Temporal. An immediately-invoked function
expression/arrow whose body declares any binding named `X` (`var`, `let`,
`const`, or a parameter) makes a bare `X` in its own ARGUMENT LIST read as
`null` — the argument is evaluated in the callee's scope instead of the
caller's:

```js
function C(e, t) {
  return (function (e) { let t, n = e; return n === null ? "NULL" : "len" + n.length; })(t);
}
C("x", [1, 2]);   // native: "len2"   ·   js2wasm: "NULL"
```

**Silent wrong value, not a throw** — and minifiers reuse short names
constantly, so every minified bundle with an IIFE is exposed. Fails after
init too (not the timing family). Pre-existing on main.

## Measured matrix (dev-5206, 2026-08-29)

| shape | js2wasm | native |
| --- | --- | --- |
| IIFE param `x`, inner `let t`, called `(t)` | `NULL` | `len2` |
| IIFE param `e`, inner `let q`, called `(t)` | `len2` | `len2` |
| inner `var t` / `const t` | `NULL` | `len2` |
| arrow instead of function expression | `NULL` | `len2` |
| caller binding is a `const`, not a param | `NULL` | `len3` |
| inner PARAMETER shadows (no `let`) | `NULL` | `len2` |
| argument is `t.length` rather than `t` | `undefined` | `2` |
| function stored in a variable, then called | `len2` | `len2` |
| hoisted named function called normally | `len2` | `len2` |

Trigger = the IIFE call form specifically (likely the inlining/direct-call
lowering resolving argument identifiers against the callee's binding
environment).

## Temporal context and one open caveat

The polyfill's failing statement is exactly this shape
(`GregorianBaseHelper`'s constructor IIFE over `t`, throwing
`RangeError: Invalid era data: eras are required` because the era table
arrives empty). Caveat from the reducer: the reduced repro delivers `null`
at that argument while the polyfill delivers an *empty host array* — same
call site, same symptom (caller's value does not arrive), but NOT yet
proven to be one root cause. Verify both shapes when fixing.

## Acceptance criteria

1. The full matrix above passes, host AND standalone; new
   tests/issue-5207-*.test.ts failing on base for every currently-wrong
   row.
2. The polyfill shape: an IIFE inside a constructor over a parameter whose
   name is shadowed inside — verify the era-table case specifically (if the
   empty-array variant is a second root cause, file it, don't fold it in).
3. Temporal harness advances past "Invalid era data" on the full stack
   (#5252 → #5258 → #5262 → #5264 → #5266 → #5271 → this). New later
   blocker → file it; `moduleInitRuns` true → say so LOUDLY.
4. No regressions in equivalence shards + closure/IIFE scoped runs (name
   them). Gates green.

## Implementation notes (2026-08-29)

**Root cause — one line, in `src/codegen/expressions/call-tail-dispatch.ts`.**
The inline-IIFE arm entered `enterInlineIifeBindingScope(fctx, iifeBindingNames)`
and only THEN compiled the argument expressions. That scope exists for the
right reason (#3128): the inline path splices the callee's body into the
CALLER's `FunctionContext`, so it must hide every name the callee declares or
the body would read the caller's same-named locals. `collectDirectEvalBindingNames`
returns exactly that set — parameters, `arguments`, and every recursively
nested `var`/`let`/`const`/class/function-declaration/catch-parameter name —
plus the function expression's own name. Hiding them is correct for the BODY
and wrong for the ARGUMENT LIST, which is caller-scope by §12.3.6.1 and is
evaluated before the callee's environment exists. A bare argument identifier
whose name the callee happened to reuse therefore missed `fctx.localMap`
entirely and lowered to a null/absent read — silently, with no throw.

This also explains why the matrix's "function stored in a variable" and
"hoisted named function" rows were correct: neither takes the inline arm.

**Fix.** Argument evaluation moved OUT of the scope, into the new
`src/codegen/expressions/inline-iife-arguments.ts`
(`compileInlineIifeArguments`, plus `compileDiscardedArgument` moved along with
it — its only callers). Two details are load-bearing:

- The parameter slots are allocated there but deliberately **not** registered
  in `fctx.localMap` (an `allocLocal` without its name half). Registering
  eagerly would shadow the caller's binding for the REMAINING arguments;
  `(function (a, b) {…})(b, a)` must read the caller's `a`. Slot names keep the
  real parameter name so `deduplicateLocals` (which merges only `__`-prefixed
  temps) cannot collapse a parameter into an unrelated slot.
- `call-tail-dispatch` binds the names to those slots immediately after
  entering the scope — the first moment the body can observe them. Binding
  patterns are still materialized by `destructureParamObject`/`Array` further
  down, unchanged.

Extra arguments past the declared parameter list were caller-scope too and had
the same defect; they moved with the rest.

**Two shapes beyond the reported matrix** were wrong on base and are now
covered by tests: later arguments seeing the caller's binding for a name an
earlier parameter shadows, and extra arguments past the parameter list.

**The empty-array caveat resolved as ONE root cause, not two.** The reduced
repro delivered `null` and the polyfill delivered an empty host array, but both
are the same missing read at the same site: an unresolved argument identifier.
The faithful constructor repro moved from `Cannot read properties of null
(reading 'filter')` on base to a different, later error with the fix, and the
harness's era-data throw disappeared.

**Temporal harness (`node --import tsx tests/dogfood/temporal-polyfill-harness.mjs`),
full stack.** `moduleInitRuns` is still **false** — the ESM lane advanced from
`WebAssembly.Exception thrown from module init` (the compiled
`RangeError: Invalid era data: eras are required` throw) to a host
`TypeError: filter is not a function` inside `GregorianBaseHelper_init`. The
era blocker is cleared; the next one is a separate pre-existing defect (an
array-literal constructor argument reaching the host extern-method dispatcher
as a compiled vec struct, reproducible with NO IIFE at all — see the PR body).

## Notes

- Found by dev-5206 while validating PR #5271; repro scripts were in that
  worktree's `.tmp/s14.js`/`.tmp/s15.js` (reproduce fresh).
- Sibling #5208 covers the compiled-Date ↔ host-Date bridging gap noted at
  the same site.
- Id #5207 reserved with a degraded PR scan; manually verified against
  open PR head branches 2026-08-29. `check:issue-ids:against-main`
  arbitrates.
