---
id: 5121
title: "Array.prototype.indexOf()/lastIndexOf() with NO argument return 0, not -1 (same degraded-fallback collapse as #5095)"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: array-indexof
goal: test262-conformance
origin: 5095
# Id 5121 was reserved on the `issue-assignments` ref for ttraenkler/opus-5095.
# `claim-issue.mjs --allocate` ran with a DEGRADED open-PR scan (`gh` is absent
# in the authoring container, exit 6), so the reservation was cross-checked by
# hand via MCP against all 24 open PRs' tracking files — no `5121-*.md` is in
# flight anywhere. Note that PR **number** 5121 also exists; that is fine and
# expected, because plan-file ids and PR numbers are separate sequences (the
# slug-link convention in CLAUDE.md exists precisely to disambiguate them).
---

# #5121 — `[10,20,30].indexOf()` answers `0`, spec says `-1`

Found while fixing
[#5095](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5095-array-prototype-at-no-argument)
(`Array.prototype.at()` with no argument answering the index instead of the
element). Not a guess by analogy — **found by hash**: on `origin/main`, the
broken `at()` compiled to the *byte-identical module* as `indexOf()` and
`lastIndexOf()`, which is what identified them as the same defect rather than
three similar-looking ones.

## Repro

```ts
const arr = [10, 20, 30];
arr.indexOf();      // → 0    spec: -1
arr.lastIndexOf();  // → 0    spec: -1
```

§23.1.3.13 `Array.prototype.indexOf(searchElement)` (and §23.1.3.20
`lastIndexOf`) take `searchElement` as an ordinary parameter, so the
zero-argument form is legal and searches for `undefined`.

## Root cause — same shape as #5095, one method over

`compileArrayIndexOf` and `compileArrayLastIndexOf`
(`src/codegen/array-methods.ts`) each open with a hard reject:

```ts
if (callExpr.arguments.length < 1) {
  reportError(ctx, callExpr, "indexOf requires 1 argument");
  return null;
}
```

The caller **swallows** that diagnostic — `compile()` reports `success: true`
with an **empty** `errors` array — and collapses the call into its degraded
fallback, which evaluates to `0`. This is exactly the mechanism #5095 fixed in
`compileArrayAt`; the two survivors are these.

`Array.prototype.includes` already models an absent `searchElement` correctly
(`emitIncludesSearchValue`, `src/codegen/array-includes-search-value.ts`, from
#2872) and is the template.

## Measured on `origin/main` @ `b1cc63d1b1`

Values, and sha256 of the emitted module (first 12 hex), gc/host lane:

| shape | observed | spec | hash |
| --- | --- | --- | --- |
| `[10,20,30].indexOf()` | **`0`** | `-1` | `0f1e06b6d00d` |
| `[10,20,30].lastIndexOf()` | **`0`** | `-1` | `0f1e06b6d00d` |
| `[10,20,30].at()` (fixed by #5095) | `0` | `10` | `0f1e06b6d00d` |
| `[10,undefined,30].indexOf()` | **`0`** | `1` | `c38059959819` |
| `[10,undefined,30].lastIndexOf()` | **`0`** | `1` | `c38059959819` |
| `["x","y"].indexOf()` | **`0`** | `-1` | `f576c114b1a3` |
| `[].indexOf()` | **`0`** | `-1` | `de7073206594` |
| `["x",undefined,"z"].indexOf()` | **`0`** | `1` | — |
| `(["1",undefined,3] as any[]).indexOf()` | **`0`** | `1` | — |

The three top rows sharing one hash is the collapse, seen directly. The rows
below it differ from each other only because the *array literal* differs — each
still collapses to the same fallback for its own receiver.

## Why this is NOT just "copy the #5095 one-liner"

#5095's fix was `i32.const 0` — a defaulted **index**. Here the absent argument
is a defaulted **search value**, compared with a different operator, and the
measurements split the work into two very different slices.

**S1 — the missing-argument default (small, the actual #5095 analog).** The
explicit spelling `indexOf(undefined)` is **already correct wherever the element
type can represent `undefined`**, which is the evidence that the gap is the
default and nothing else:

| shape | `indexOf(undefined)` | `indexOf()` | verdict |
| --- | --- | --- | --- |
| `["x",undefined,"z"]` (externref vec) | `1` ✅ | `0` ❌ | default only |
| `[1,undefined,3]` as `any[]` (externref vec) | `1` ✅ | `0` ❌ | default only |
| `[10,20,30]` (f64 vec) | `-1` ✅ | `0` ❌ | default only |
| `["x","y"]` | `-1` ✅ | `0` ❌ | default only |
| `[]` | `-1` ✅ | `0` ❌ | default only |

So S1 is: emit the absent `searchElement` as whatever an explicit `undefined`
would produce for this element type, exactly as `emitIncludesSearchValue` does,
and drop the reject. That fixes every row above.

**S2 — a value-representation limit, probably defer.** One row is wrong even
with the argument written out:

| shape | `indexOf(undefined)` | spec |
| --- | --- | --- |
| `[10,undefined,30]` (f64 vec) | `-1` | `1` |

In an f64 vec both a hole and `undefined` read as NaN, and `indexOf` uses
**strict equality** (§23.1.3.13 step 6b), under which `NaN !== NaN`. The
compiler answers `-1`, which is *correct* for `[NaN].indexOf(NaN)` (verified:
answers `-1`, as the spec requires) and *wrong* for `[undefined].indexOf(undefined)`
— the two are indistinguishable in that encoding. This is the same imprecision
already documented in the `NEVER_A_NUMBER` comment in
`src/codegen/array-includes-search-value.ts`, resolved the *other* way there
because `includes` uses SameValueZero, under which NaN does match. It needs a
tagged element representation, not an argument default, so it should not block
S1.

Note also that `indexOf` reads with **HasProperty** semantics for holes (a hole
is skipped, not compared as `undefined`), unlike `includes`, which reads with
Get. Whoever takes S2 should not copy `includes`'s hole handling wholesale.

## Acceptance

- `[10,20,30].indexOf()` and `.lastIndexOf()` return `-1`.
- `["x",undefined,"z"].indexOf()` returns `1`; the `any[]` spelling likewise.
- Every explicit-argument form stays byte-identical (`indexOf(20)`,
  `lastIndexOf(20)`, `indexOf(undefined)`, `includes()` — the last already
  correct via #2872 and must not regress).
- Zero pass→fail on `built-ins/Array/prototype/indexOf/` and
  `built-ins/Array/prototype/lastIndexOf/`.
- S2 (f64-vec `indexOf(undefined)` finding a real `undefined`) is explicitly out
  of scope; if it is left open, say so in the PR rather than pinning `-1` as a
  fixture.

## Notes for the implementer

- `shouldWrapDynViewTwoArm` (`src/codegen/array-methods.ts`) skips the #2872
  dyn-view two-arm for zero-argument calls precisely *because* these two impls
  hard-require their argument (`(callExpr.arguments.length >= 1 || methodName === "toLocaleString")`).
  Once the reject is gone, revisit that clause — #5095 deliberately left it
  alone to keep its blast radius at one method.
- `tests/equivalence/array-includes-no-arg.test.ts` and
  `tests/equivalence/array-at-no-arg.test.ts` are the two existing files this
  should be modelled on; both were written for this same defect shape.
