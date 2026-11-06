---
id: 7264
title: "IR: a script's own `escape` / `unescape` (and shadowed parse/isNaN) bound to the native provider (#7253 regression)"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7253, 7118]
assignee: "ttraenkler/c-lead"
---

# #7264: ambient global-function calls ignore a script's own declaration

## Problem

[#7253](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7253-ir-module-init-external-call-parse-escape)
(PR #7103, merged as `4a1a0dc883`) lowers direct calls of the ambient
`parseInt` / `parseFloat` / `escape` / `unescape` / `isNaN` to the native
providers. A fresh-context review after the merge (PR #7103 comment
6676414160) found that in a **script** a source declaration of the same name is
replaced by the built-in:

```js
// p.js (script, no import/export)
function unescape(s) { return "U"; }
function f() { return unescape("%41"); }
if (f() !== "U") throw new Error("x");
```

| lane | base `b4306ca851` | main `4a1a0dc883` |
| --- | --- | --- |
| gc | completes | throws (`f` is IR, calls `$__unescape`) |
| standalone | completes | throws |
| wasi | completes | throws |

`escape` behaves the same. Cause: both sides decide "is this the built-in?" with
`makeIrAmbientBindingPredicate`'s default `"some"` quantifier, and a script's
`function unescape` merges with the lib's `declare function`, so the merged
symbol still has a lib declaration (the case #7118 added `"every"` for). A
second hole, found while testing: a script's `var` / `let unescape = …` does
not merge at all — the checker resolves the call to the lib symbol alone — so
no binding predicate can see it.

## Implementation Plan

- `src/ir/ambient-global-function-call.ts` (the one admission both sides read):
  - the binding proof is `isLibOnlyBinding` (`"every"`) on both the selector and
    from-ast, replacing `isAmbientBinding` / `selectorSeesAmbientBinding`;
  - the shared shape refuses when a script declares the callee's name anywhere
    (`var` / `let` / `const`, function, class, parameter; a per-file cached
    scan). ES modules scope their bindings, so the checker answers there.
- Nits from the same review: the `escape` / `unescape` carve-out is "outside a
  top-level function declaration of an ES module" (every other unit there
  lowers as a prepared component, whose Program ABI has no identity for the
  helpers), not just `<module-init>`; the unreachable null-result throw goes.
- Code quality: no new module, no second admission; the binding change reuses
  the existing `isLibOnlyBinding` resolver member (the sibling
  `isAmbientIntrinsicValue` uses it the same way).

## Acceptance

- The script shadows (function declaration, also declared after the use;
  inner-scope function; parameter; `var`; `let`) for all five names compile
  byte-identical to the pre-#7103 base on gc / standalone / wasi.
- `tests/equivalence/issue-7253-module-init-external-calls.test.ts` covers
  them (route + node value).
- Typed corpus byte-identical vs main; wrapped ledger A/B vs main:
  zero-legacy does not drop, 0 invariants; standalone test262 A/B over the
  five directories + a 200-file random sample: no pass→fail.

## Pre-existing (legacy, base `b4306ca851`) — not made worse

- Script shadows of `parseInt` / `parseFloat` / `isNaN` through a function
  declaration (also after the use) or an inner-scope function: legacy calls
  the built-in. The same holds for `isNaN` as a parameter.
- `var` / `let` shadows of all five names: legacy calls the native provider.
  The script throws on base, main and head alike.

## Follow-ups (not done here)

- **Third IR route to the parse providers.** This arm, the acorn
  `stringToNumber` `directCallTargets` route and the #3521 fnctor native-string
  boundary should become one.
- **Helper placement.** `ambientGlobalFunctionProviderSymbol` lives in
  `annexb-escape-call.ts` but also serves the parse scanners. It is re-exported
  through `native-strings.ts` only to keep `check:ir-layering` flat. Give it a
  neutral home.
- **Native `parseInt` radix.** The scanner skips ToInt32 for ±Infinity /
  ±2³²+n: `parseInt("11", 2**32+2)` and `parseInt("0x1f", Infinity)` give NaN,
  where node gives 3 / 31. Base and head agree, since legacy shares the
  scanner.
- **Legacy script-shadow misbinding** (above), and the same `var`-shadow hole
  for #7118's ambient intrinsic value reads (`isLibOnlyBinding` cannot see a
  `var Number = …` in a script either).
