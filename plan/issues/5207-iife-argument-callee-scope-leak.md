---
id: 5207
title: IIFE arguments are evaluated in the CALLEE's scope — silent wrong values whenever the callee declares a binding with the caller's name
status: ready
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

## Notes

- Found by dev-5206 while validating PR #5271; repro scripts were in that
  worktree's `.tmp/s14.js`/`.tmp/s15.js` (reproduce fresh).
- Sibling #5208 covers the compiled-Date ↔ host-Date bridging gap noted at
  the same site.
- Id #5207 reserved with a degraded PR scan; manually verified against
  open PR head branches 2026-08-29. `check:issue-ids:against-main`
  arbitrates.
