---
id: 4597
title: "STANDALONE representation limit: a closure struct carries no source-text pointer, so STATIC `fn.toString()` resolves real text while every DYNAMIC path emits the [native code] placeholder — the two can disagree in one expression"
status: ready
sprint: current
created: 2026-08-21
updated: 2026-08-21
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function-tostring
goal: es5
related: [4564, 4437, 4163]
origin: "2026-08-21 wave-2 coercion lane, while closing the `+`-ToPrimitive truth table. Reported rather than built, per the stop-at-representation rule."
---

# #4597 — function source text is a static-map lookup, not a carrier field

## The disagreement

`built-ins/../S11.6.1_A2.2_T3` asserts `f1 + 1 === f1.toString() + 1`.

- `f1.toString()` — a STATIC call site — resolves the real declaration text via
  the `ctx.funcSourceText` name map
  (`src/codegen/expressions/call-receiver-method.ts:3216`).
- `f1 + 1` reduces through the (now-correct, `778fc227`) dynamic
  ToPrimitive→toString path, which can only emit the
  `function () { [native code] }` placeholder — **the closure struct carries no
  source-text pointer**, so no runtime path can reach the real text.

Both halves are internally consistent; the assertion compares them and fails.

## Why this is representation-level

Making the two agree requires a field (or table index) on the closure
representation pointing at the source text — every closure allocation site and
the rec-group shape are implicated. Alternatives that are NOT acceptable:

- Downgrading the static path to the placeholder would regress every currently
  passing `fn.toString()` row to implementation-defined-but-worse text.
- Special-casing `+` to consult the static map only works for statically
  resolvable operands — the dynamic case (a closure passed as a value) stays
  wrong, which is the case the test exists for.

## Options for whoever takes it

1. A per-declaration index field on the closure struct into a module-level
   source-text table (the `$__fn_instance_meta` family, #4437, already carries
   per-declaration meta — this may be a sibling field rather than a new
   carrier).
2. Accepting placeholder-everywhere is spec-legal (source text is
   implementation-defined) BUT the static map already ships real text, so the
   bar is agreement, not a particular text.

## Acceptance criteria

- `f1 + 1 === f1.toString() + 1` holds for a closure reached statically AND for
  the same closure passed as a value.
- Existing `fn.toString()` rows keep their current (real-text) answers.
- Guard 551 clean; GC-lane suites vs merge base.
