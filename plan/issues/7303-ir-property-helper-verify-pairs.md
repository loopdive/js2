---
id: 7303
title: "IR: propertyHelper verify* units after #7140/#7151 — measurement (every remaining group owned or contract-gated)"
status: blocked
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
parent: 7250
related: [7272, 7283, 7277, 7127, 2949, 7142]
assignee: "ttraenkler/c-r11"
---

# IR: propertyHelper verify* units after #7140/#7151

## Result

Measurement only. No implementation: every legacy group left is either owned
by an open lane or needs a contract change.

The verify pairs this issue was meant to take (verifyWritable /
verifyNotWritable, verifyEnumerable / verifyNotEnumerable, verifyConfigurable
/ verifyNotConfigurable) are **already IR** after #7140.

## Setup

- Base: #7151 @ `3c063b5c` merged with origin/main (`de685bc2`, which
  contains #7140 and #7111).
- Wrapped standalone compile, `trackIrOutcomes`, 40 propertyHelper includers
  from the stride-40 ledger set.
- Census script: `.tmp/census.mts`, run in this worktree.

## Census (40 includers)

- Files with ≤1 legacy unit: **0**. Zero-legacy files: **0**.

| unit | state | first refusal | closure-only or own body | owner |
| --- | --- | --- | --- | --- |
| verifyWritable / verifyNotWritable / verifyEnumerable / verifyNotEnumerable / verifyConfigurable / verifyNotConfigurable, plus isWritable / isConfigurable / isEnumerable / isSameValue | IR in 37–40 / 40 | rare exceptions: `expr-new-ctor-unknown` (2 files), `param-dynamic-carrier-diverges-from-legacy` (1–2 files) | — | done (#7140) |
| verifyProperty | legacy 40 / 40 | `move-only[dyn]` on `assert.notSameValue(desc, null, …)` | own body | #7127 (dynamic null), then the #2949 value-used seam; `__push` / `__join` / `__defineProperty` aliases come after that (see #7283) |
| verifyEqualTo | legacy | `param-dynamic-carrier-diverges-from-legacy(value)` | own body (parameter ABI) | #7277 (PR #7143) |
| verifyPrimordialCallableProperty / verifyPrimordialAccessorProperty | legacy | `param-dynamic-carrier-diverges-from-legacy(options / desc)` | own body (parameter ABI) | #7277 (PR #7143) |
| verifyPrimordialProperty | not a unit | `var verifyPrimordialProperty = verifyProperty` is a module-init statement | — | follows `<module-init>` |
| verifyCallableProperty | legacy 40 / 40 | `expr-logical-value-family` on `options && options.verifyProperty \|\| verifyProperty` | own body | none; **contract** (below) |
| verifyAccessorProperty | legacy 40 / 40 | `param-type-unresolved(desc)` | own body | none; **contract** (below) |
| `<module-init>` | legacy 40 / 40 | `expr-ident-not-in-scope` on `Function` (`Function.prototype.call.bind(…)`) | own body | none; **contract** (below) |

PR #7142 (#7276, `Object.create` with literal descriptors) owns none of
these.

## Why the unowned groups are contract-gated

- **verifyCallableProperty / verifyAccessorProperty.** Both pick a verifier
  at runtime (`var propertyVerifier = options && options.verifyProperty ||
  verifyProperty`) and call it. The IR has no op that calls a dynamic
  function value: there is no `dyn.call`. Admitting the logical operand alone
  would only move the refusal to the call. Calling through the carrier, and
  making the function a value on each lane's carrier, is the #2949
  value-used seam question.
- **`<module-init>`.** Its initializers make function values:
  `Function.prototype.call.bind(Array.prototype.join)`, `Array.isArray`,
  `Object.defineProperty`, and `var verifyPrimordialProperty =
  verifyProperty`. Certified aliases (#7269) rewrite the call sites, but the
  binding is still stored. Taking module-init needs one of two contracts:
  - a function value of a builtin or a bound method on the carrier;
  - or eliding a certified alias binding that is only ever called. That is a
    semantic decision, because the binding is a script global.

None of the three would move a file to ≤1 legacy unit on its own:
verifyProperty stays legacy in every includer until #7127 and #2949 land.

## Suggested order

1. #7127, then the one-line selector arm recorded in #7283 (a `null`
   argument to a function-object member call).
2. A #2949 decision on function values as carrier values / dynamic calls.
   That unblocks verifyProperty's member-equality operands,
   verifyCallableProperty, verifyAccessorProperty and the module-init
   function-value bindings together.
3. #7277 for verifyEqualTo and the two verifyPrimordial* units.
