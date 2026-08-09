---
id: 4255
title: "standalone: a field read through a chained ctor→method→field expression returns a wrong value (−1) — pre-existing on main, flag-independent"
status: ready
created: 2026-08-09
updated: 2026-08-09
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, objects
goal: core-semantics
related: [743, 4246]
origin: "Surfaced 2026-08-09 while building PR #4246's E2E for the #743 Parser.pos program; reproduced flag-OFF on unmodified main's emission — pre-existing, not #4246's. Recorded only in the lane's report until this filing."
---

# #4255 — chained `new P(7).tok().s` answers −1 in standalone

## Problem

A chained expression that constructs a fnctor instance, calls a method on it
returning a second object, and reads a field off that result —

```js
function P(n){ this.pos = n }
P.prototype.tok = function(){ return new Token(this) }
function Token(p){ this.s = p.start }   // shape per the acorn-derived fixture
new P(7).tok().s
```

— returns **−1** in the standalone lane where native JS returns the real
field value. Reproduced on **unmodified main with every #743-family flag
off**: this is a pre-existing emission defect, independent of the value-flow
work that surfaced it.

The exact pinned fixture lives in `tests/issue-743-pos-value-flow.test.ts`
(PR #4246), whose E2E deliberately pins only flag-on ≡ flag-off (family
precedent) — i.e. the pin currently ENSHRINES the wrong value equally on both
sides rather than asserting the spec answer. Start there: promote that pin to
the native answer as part of the fix.

## Why −1 is suspicious in itself

−1 is a known sentinel in the string/search helpers and in uninitialized
i32 slots. A chained receiver (the method's fresh return value, never bound
to a local) plausibly takes a different dispatch/marshal path than a
named-binding receiver — compare against the same expression split into
temporaries (`var p = new P(7); var t = p.tok(); t.s`), which the #4246 lane
implied works (the census movers were measured through named bindings).
Whether the wrong value comes from a missed field init, a sentinel leaking
from a helper, or a receiver-representation mismatch on the unnamed
temporary is the first thing to establish.

## Acceptance

- [ ] Minimal repro pinned with the NATIVE answer (not lane-equality) in a
      test that fails on today's main.
- [ ] The chained and temporary-split spellings of the same expression agree
      with native for f64, i32, string, and ref-typed fields.
- [ ] The #4246 E2E's lane-equality pin upgraded to the spec answer once
      fixed.
