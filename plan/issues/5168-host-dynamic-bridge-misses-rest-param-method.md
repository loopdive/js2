---
id: 5168
title: "Host dynamic method dispatch cannot resolve a rest-parameter class method — `TypeError: <m> is not a function`"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, calls, host-bridge
language_feature: rest parameters, dynamic dispatch
goal: correctness
related: [4644, 4628]
---

# #5168 — host dynamic dispatch misses a rest-parameter class method

## Problem

A class method declared with a rest parameter is not FOUND by the host dynamic
method-dispatch path. The module compiles and validates; the call throws at run
time:

```
TypeError: formatToParts is not a function
    at src/runtime.ts:…
    at __module_init (wasm://…)
```

Repro (JS-host lane, `allowJs` + `skipSemanticDiagnostics`):

```js
class DateTimeFormatImpl {
  constructor(id) { this.id = id; }
  formatToParts(...t) { return this.id + t.length; }
}
function dispatch(n, r) { return n.formatToParts(...r); }
console.log(dispatch(new DateTimeFormatImpl(7), [1, 2, 3]));   // expected 10
```

`dispatch` receives its receiver as an untyped value, so the call goes through
the host dynamic path rather than a direct call. The compiler emits the vararg
bridge `__class_call_formatToParts_vararg`, but the runtime's method lookup does
not find it and reports the method as absent.

## Why this is separate from #4644

#4644 fixed the bridge's OPERAND COUNT — it dropped the fixed arguments that sit
ahead of the rest parameter. This is a different failure at a different layer:

- it reproduces for `m(...rest)` too, whose operand count was never wrong, so it
  is not a residue of that bug; and
- it is a *resolution* failure (the runtime does not reach the bridge at all),
  not a *validation* failure.

It was invisible before #4644 only because the module did not validate, so the
program never ran.

## Acceptance criteria

1. The repro above logs `10`, matching Node.
2. The same holds with a fixed parameter ahead of the rest
   (`formatToParts(e, ...t)`), which #4644 made emit correctly but which still
   cannot be reached.
3. A regression test under `tests/` that RUNS the module (validation alone does
   not exercise this).

## Notes

Found while fixing #4644 against `@js-temporal/polyfill@0.5.1`; the polyfill's
`DateTimeFormatImpl.formatToParts(e, ...t)` is the real-world instance.
