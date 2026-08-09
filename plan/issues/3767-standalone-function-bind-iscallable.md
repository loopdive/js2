---
id: 3767
title: "Standalone Function.prototype.bind.call: eager IsCallable TypeError for literal targets"
status: done
completed: 2026-07-28
assignee: ttraenkler/codex-es5-bind-iscallable
created: 2026-07-28
updated: 2026-07-30
priority: high
feasibility: easy
task_type: bug
area: codegen
es_edition: ES5
language_feature: function-bind
goal: test262-conformance
sprint: 77
loc-budget-allow:
  - src/codegen/expressions/calls.ts
---

# #3767 — Standalone `Function.prototype.bind.call` IsCallable guard

## Problem

ES5 §15.3.4.5 step 2 requires `Function.prototype.bind` to throw a
`TypeError` when its target is not callable. Current ECMAScript
§20.2.3.2 step 2 retains the same rule.

The gc/host lane delegates the indirect
`Function.prototype.bind.call(target, ...)` shape to the native host and gets
that guard for free. Standalone has no host implementation for the fallback:
literal non-callable targets silently return, so ten authoritative ES5 tests
fail even though their host counterparts pass.

## Exact slice

- `15.3.4.5-2-{10,11,12,13,14,15}.js`
- `S15.3.4.5_A{13,14,15,16}.js`

Fresh `origin/main@f5268a605631aa` authoritative `es5id` cohort:

- host: 66 pass / 80
- standalone: 27 pass / 80

## Scope and acceptance

- Intercept only the syntactic
  `Function.prototype.bind.call(<statically non-callable literal>, ...)`
  shape under `target: "standalone"`.
- Evaluate all outer call arguments once, left-to-right, before the throw.
- Emit a native catchable `TypeError`.
- Leave callable carriers, dynamic identifiers, direct/user-defined `.bind`,
  gc/host, wasi, property-helper Array aliases, constructors, and bound
  function property semantics unchanged.
- All ten scoped ES5 tests pass in standalone with zero host or standalone
  regressions in the 80-file paired A/B cohort.

## Results

Paired local-vs-local A/B from the same
`origin/main@f5268a605631aabc5abdf20695e9be2931d0e562`:

- host: 66/80 → 66/80; zero status changes and zero Wasm-SHA changes
- standalone: 27/80 → 37/80; +10 / −0
- standalone Wasm changed for exactly the ten scoped files; the other 70 were
  byte-identical

Focused `tests/issue-3767.test.ts` covers all literal target classes, the
identifier-held RegExp shape, left-to-right argument evaluation before the
throw, native `TypeError` identity, zero imports, and the callable indirect
bind path.
