---
id: 4367
title: "Jest parenthesized accessor descriptors miss the getter-callback import"
status: in-progress
sprint: current
created: 2026-08-11
updated: 2026-08-11
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: object-reflection, accessors, transparent-expressions
goal: npm-library-support
related: [1027, 3048, 3995, 4302]
loc-budget-allow:
  - src/codegen/declarations/import-collector.ts
---

# Preserve accessor-descriptor shape through transparent wrappers

## Problem

The pinned Jest 30.4.2 entry graph reports fourteen
`Missing __make_getter_callback import` diagnostics. They are duplicate-pass
copies of seven unique Webpack export getters:

- `@jest/core/build/index.js:4191`, `:4197`, `:4203`, and `:4209`
- `jest-cli/build/index.js:781`, `:787`, and `:793`

Each site has the same real-source shape:

```js
Object.defineProperty(exports, "run", ({
  enumerable: true,
  get: function () {
    return _run.run;
  },
}));
```

The emitter unwraps the parenthesized descriptor and lowers the getter through
`__make_getter_callback`. The import collector calls `isAccessorDescriptor`
on the outer `ParenthesizedExpression`, rejects it as non-object, and therefore
does not register the import. This is a transparent-wrapper residual after the
completed accessor-import work in #3048, not a Jest-specific semantic rule.

## Acceptance criteria

- [x] The import collector recognizes accessor descriptors behind parentheses
      and TypeScript-transparent expression wrappers.
- [x] A focused Webpack-shaped `Object.defineProperty` fixture compiles to a
      valid host-lane module and declares `env::__make_getter_callback`.
- [x] Existing direct descriptor cases and standalone host-import exclusions
      remain green.
- [x] The pinned Jest entry graph no longer reports the fourteen missing-import
      diagnostics; any independent async blocker remains explicit.

## Implementation result (2026-08-11)

`isAccessorDescriptor` now delegates transparent-wrapper removal to the shared
descriptor analysis before testing the object-literal fields. The real pinned
Jest entry graph moves from fifteen compile diagnostics to one: all fourteen
missing `__make_getter_callback` reports are gone, and only the independently
tracked async-in-`try` refusal remains. The graph still emits no binary until
that async slice lands, so this result is compile-frontier evidence rather than
runtime correctness evidence.
