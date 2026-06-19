---
id: 2200
title: "Annex B B.3.3 block-level function declaration hoisting — outer binding created/initialized incorrectly (~186 test262 fails)"
status: ready
sprint: 64
created: 2026-06-19
updated: 2026-06-19
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, scoping
language_feature: block-scoped-functions
goal: spec-completeness
related: [1642]
test262_bucket: annexb-block-fn-hoisting
test262_count: 186
es_edition: annexb
origin: "2026-06-19 sprint-64 standalone failure mining: annexB/language/function-code (91) + annexB/language/global-code (95) fail the B.3.3 outer-binding hoisting contract. Also fails identically in JS-host (203 fail / 107 pass), so it is a host-agnostic scoping bug."
---

# #2200 — Annex B B.3.3 block-level function declaration hoisting

## Problem

ECMA-262 **Annex B.3.3** ("Changes to FunctionDeclarationInstantiation /
GlobalDeclarationInstantiation / EvalDeclarationInstantiation") governs the
web-compat semantics of a `FunctionDeclaration` nested inside a *block* (not a
function body). The spec creates an *additional, var-scoped* outer binding for
the block-local function name, but **only when** doing so "would not produce any
Early Errors" — e.g. a colliding `let`/`const`/parameter binding in the
enclosing scope cancels the Annex B hoist.

The compiler currently hoists block-level function declarations to the
enclosing function/global scope **unconditionally**, ignoring the Annex B
guard conditions. Two observable failures result:

1. **Outer binding created when it must not be** — when a `let`/`const`/param
   shadow (or the B.3.3 "would produce an early error" condition) should block
   the hoist, the compiler still exposes `f` in the outer scope, so a
   `ReferenceError` that the spec mandates does not throw.
2. **Outer binding initialized too eagerly** — even when the outer binding *is*
   created, B.3.3 requires it to start **uninitialized** (`typeof f ===
   "undefined"`, reading `f` before the block executes throws `ReferenceError`),
   then become initialized to the function value **only after** the block's
   inner `function` declaration is evaluated. The compiler initializes it at
   function entry.

This is a pure scoping/hoisting bug — **independent of standalone mode** (it
fails identically in JS-host: 203 fail / 107 pass) and independent of the
standalone builtin-prototype / value-rep epics.

## Spec

- §B.3.3.1 Changes to FunctionDeclarationInstantiation:
  https://tc39.es/ecma262/#sec-web-compat-functiondeclarationinstantiation
- §B.3.3.2 Changes to GlobalDeclarationInstantiation:
  https://tc39.es/ecma262/#sec-web-compat-globaldeclarationinstantiation
- §B.3.3.3 Changes to EvalDeclarationInstantiation (eval cases are out of scope —
  eval is a deferred/skipped feature).

The guard (FunctionDeclarationInstantiation step, paraphrased): for each block-
nested function name `F`, create a var-scoped outer binding **iff** replacing
the `FunctionDeclaration` with a `var F` would not produce an early error
(i.e. no lexical `let`/`const`/class binding for `F` in an intervening scope)
**and** `F` is not a parameter name.

## Minimal repro

```js
// (A) let-shadow cancels the Annex B outer binding (B.3.3 guard).
(function() {
  // Outer `f` must NOT be created — a `let f` shadow lives between.
  let threw = false;
  try { f; } catch (e) { threw = e instanceof ReferenceError; }
  // assert threw === true   (compiler: f is wrongly visible → no throw)
  {
    let f = 123;
    {
      function f() {}   // block-level fn decl, but `let f` blocks the hoist
    }
  }
  return threw ? 1 : 0;
})();
```

```js
// (B) outer binding starts uninitialized, becomes the fn value after the block.
(function() {
  // `f` exists (var-scoped) but is uninitialized here.
  const before = typeof f;          // must be "undefined" (binding uninitialized)
  { function f() { return 42; } }   // after this block, outer f === the function
  const after = typeof f;           // must be "function"
  return (before === "undefined" && after === "function") ? 1 : 0;
})();
```

## Failing test262 cluster

- `test/annexB/language/function-code/*` — **91** fail/CE. Dominant assertion:
  `assert.throws(ReferenceError, function() { f; }, 'An initialized binding is not created prior to evaluation')`.
  Representative files:
  - `annexB/language/function-code/if-stmt-else-decl-func-skip-early-err-for-of.js`
  - `annexB/language/function-code/if-decl-no-else-func-skip-dft-param.js`
  - `annexB/language/function-code/if-decl-else-stmt-func-skip-early-err-for-in.js`
- `test/annexB/language/global-code/*` — **95** fail/CE. Same B.3.3 contract at
  global scope. Representative files:
  - `annexB/language/global-code/if-decl-no-else-global-skip-early-err-try.js`
  - `annexB/language/global-code/switch-case-global-no-skip-try.js`
  - `annexB/language/global-code/switch-case-global-update.js`

Total addressable: **~186** (eval-code B.3.3 variants excluded — eval is deferred).

## Approach (sketch — dev to confirm against codegen)

In FunctionDeclarationInstantiation / GlobalDeclarationInstantiation hoisting
(the pass that collects block-nested `FunctionDeclaration`s and lifts them to
the enclosing scope):

1. Apply the **B.3.3 guard**: skip the outer var-binding when a lexical
   (`let`/`const`/class) binding for the name exists in an intervening scope, or
   the name is a parameter. This makes case (A) throw the spec `ReferenceError`.
2. Make the hoisted outer binding **uninitialized at entry** (TDZ-like for the
   var-scoped Annex B binding), and emit the *initialization-to-function-value*
   at the point the inner block-level declaration is evaluated, not at function
   entry. This fixes case (B).

`for-of` IteratorClose-on-throw (#1642) is a sibling iteration-semantics lane —
do **not** scope-creep into it.

## Acceptance criteria

- [ ] Repro (A): outer `f` read throws `ReferenceError` when a `let`/`const`/param
      shadow cancels the Annex B hoist.
- [ ] Repro (B): outer binding reads `typeof === "undefined"` before the block,
      `"function"` after.
- [ ] `>= 120` of the ~186 `annexB/language/{function-code,global-code}` tests
      flip to pass (standalone shard). Stretch: `>= 160`.
- [ ] No regression in non-Annex-B function/block scoping
      (`language/statements/function`, `language/statements/block`) on the
      standalone shard or in JS-host.
- [ ] A focused `tests/issue-2200-*.test.ts` covering repros (A) and (B) in both
      sloppy and strict mode (strict mode disables the Annex B hoist entirely —
      no outer binding — which is its own assertion).
