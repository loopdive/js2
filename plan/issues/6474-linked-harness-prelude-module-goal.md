---
id: 6474
title: "Linked test262 harness: the binding prelude's import makes the body a module, changing var scoping"
status: ready
sprint: current
created: 2026-09-14
updated: 2026-09-14
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: test262-runner
language_feature: modules
goal: test262-conformance
depends_on: [3451]
related: [3451, 2527]
# NOTE: id reserved 2026-09-14 with pr_scan="degraded" — the open-PR scan could
# not reach `gh` from this container, so the id is verified against upstream
# `main` and the assignment ref but NOT against in-flight PRs. The required
# `check:issue-ids:against-main` gate is the backstop.
---

# #6474 — the linked-harness prelude turns every test body into an ES module

## Problem

#3451 slice 3 binds harness names into a test body with a prelude:

```js
import { __h_assert } from "./__js2wasm_harness_stub";
var assert = __h_assert();
```

That `import` makes the body an **ES module**. Test262 scripts are **scripts**:
a top-level `var` is a property of the global object and is visible to code that
never saw the declaration. In a module it is module-scoped.

Measured 2026-09-14 (`language/statements/with`, 12 rows, linked vs honest at
the same commit): 2 verdict differences, both this. `12.10-0-1.js` is the clean
one —

```js
var o = {};
var f = function () { return foo; };   // captures `foo` before it exists
with (o) { var foo = "12.10-0-1"; }
assert.sameValue(f(), "12.10-0-1");
```

Honest: pass. Linked: `Expected SameValue(«null», «"12.10-0-1"»)`.

**It is not a provider or substrate defect.** Reproduced with NO provider at
all: the honest whole-assembly source plus a dummy `import { __g } from
"./__stub"; var __u = __g;` fails identically. The import alone does it.

The same root cause produces `arguments is not defined` and `x is not defined`
rows in the `for-of` sample.

## What a fix has to provide

A way to give a compiled **script** compilation unit bindings that resolve to a
linked provider's exports, without an `import` declaration in the source. The
existing `inferModuleStrictArguments: false` option is the precedent: it already
decouples one module-goal consequence (strictness) from the presence of an
import, so the shape of the answer is likely a sibling option that keeps the
**var-scoping and `arguments`** semantics of a script too, or a codegen-level
binding injection that never touches the source's goal symbol.

## Acceptance criteria

- [ ] A linked body's top-level `var` is script-global: visible to a closure
      created before the declaration, and to `with`-introduced declarations.
- [ ] `arguments` in a linked sloppy body behaves as it does in the honest lane.
- [ ] `language/statements/with` reaches 12/12 linked-vs-honest agreement on the
      first 12 rows.
- [ ] The honest lane is byte-identical (the option is opt-in).
