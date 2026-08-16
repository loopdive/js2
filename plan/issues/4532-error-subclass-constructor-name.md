---
id: 4532
title: "Error subclasses report name 'Error' — prettier ConfigError/UndefinedParserError/ArgExpansionBailout tests fail"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-16
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen, runtime
language_feature: classes, errors
goal: npm-library-support
related: [3959, 3995, 1378]
files:
  - tests/dogfood/prettier-upstream-suite.mjs
---

# `class X extends Error` instances answer `name === "Error"`

## Problem

Prettier's `tests/unit/errors.js` fails all three cases, 2026-08-16 on
`a9b20d4c`:

```text
ConfigError            → toBe: string:Error != string:ConfigError
UndefinedParserError   → toBe: string:Error != string:UndefinedParserError
ArgExpansionBailout    → toBe: string:Error != string:ArgExpansionBailout
```

Upstream defines `class ConfigError extends Error { name = "ConfigError" }`
(prettier's src/common/errors.js uses class-field `name` assignments; the
exact upstream shape uses either a field or `this.name = …` in the ctor).
The compiled instance's `.name` read yields the base `"Error"` — the
subclass's own `name` (class field or ctor assignment) does not shadow the
builtin Error brand's name through the property-read path used after the
value crosses the throw/bridge boundary.

Generic defect: any package that brands errors by subclass name and
dispatches on `err.name` misbehaves (axios `CanceledError`/`AxiosError`,
webpack `WebpackError` family — same pattern).

## Reproduction

```bash
node --import tsx tests/dogfood/prettier-upstream-suite.mjs --json
# tests/unit/errors.js rows
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Reduce along both axes** in `.tmp/`:
   (a) `class E extends Error { name = "E" }; new E("m").name`
   (b) `class E extends Error { constructor(m){ super(m); this.name = "E"; } }`
   (c) read `.name` after the instance crosses a throw/catch and after a
   host-bridge round-trip. Identify which axis loses the write: the class
   field initializer ordering vs `super()` (field must apply after super
   returns), or the `.name` read resolving to the builtin brand instead of
   the instance property.
2. **Likely site**: the builtin-Error heritage path (#3959 fixed
   Error-without-new null; the brand/prototype plumbing it touched is where
   `name` resolution lives). Check how a property read on an
   Error-branded struct resolves `name` — if the read short-circuits to the
   brand's static name before consulting instance fields, invert that order.
3. **Validation gates**: reduction test committed
   (`tests/issue-4532.test.ts`); prettier `errors.js` 0/3 → 3/3; test262
   Error-family (`built-ins/Error`, `NativeErrors`) no regressions;
   equivalence green.

## Acceptance criteria

- [ ] Subclass `name` (field and ctor-assignment forms) observable on
      instances, including through throw/catch and the host bridge.
- [ ] Prettier upstream errors.js 3/3.
