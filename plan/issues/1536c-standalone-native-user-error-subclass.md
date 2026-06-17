---
id: 1536c
title: "standalone-native user Error subclass: instance creation via __new_<Parent> + native instanceof tag chain (no host imports)"
status: ready
sprint: 63
created: 2026-06-16
updated: 2026-06-16
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: errors, classes
goal: standalone-wasm
related: [1536, 1455, 1366, 2077]
origin: "2026-06-16 split from #1536 gap #2 (architect escape hatch) — externref-backed Error subclass leaks host imports in standalone"
---

# #1536c — user `class extends Error {}` must run standalone (no host imports)

## Problem

#1536 shipped the native Error machinery for the built-in error classes
(`$Error_struct`, native `__new_<Name>`, `.message`/`.name`/`.stack` reads,
`instanceof` via `$tag`). But a **user subclass** of a built-in error —
`class MyError extends Error {}` — is marked **externref-backed**
(`class-bodies.ts:434`, because `Error` is host-constructible), so in
`--target standalone` / `--target wasi` it still depends on two JS-host imports
and fails to instantiate:

```ts
class MyError extends Error {}
new MyError("boom") instanceof Error   // standalone: env::__new_Error + env::__tag_user_class leak → won't instantiate
```

Verified 2026-06-16: standalone leaks `env::__new_Error`, `env::__tag_user_class`
(module "Import #0 env: module is not an object or function"). Host mode works.

This violates the dual-mode architecture principle (no new host imports without
a standalone fallback) for the whole user-Error-subclass surface.

## Fix direction (two halves)

1. **Instance creation** — when `ctx.wasi || ctx.standalone` and the externref
   subclass's builtin parent is a WASI error name, route the
   `super(...)` / implicit-derived-ctor instance creation through the native
   `__new_<Parent>` internal function (`emitWasiErrorConstructor` in
   `registry/error-types.ts`) instead of `ensureLateImport("__new_<Parent>")`.
   See the `!ctor && isExternrefBacked` block at `class-bodies.ts:1471-1497`
   and `compileSuperCall` (`class-bodies.ts:2216`+, `importName = __new_<Parent>`
   at ~2237).
2. **`instanceof` tag chain** — replace the host `__tag_user_class` +
   `__instanceof` machinery (`class-bodies.ts:1624-1662`, #1455) with a
   standalone-native discriminant. Since the native parent instance is an
   `$Error_struct` (or a user struct carrying `$tag`), reuse
   `collectErrorInstanceOfTags` / the `$tag` discrimination already used for the
   built-in classes (`identifiers.ts`) so `instance instanceof MyError` and
   `instance instanceof Error` both resolve without a host import.

## Why split from #1536

The externref-backed-subclass path is the most fragile class-construction code
(host-alloc instance, prototype tagging, `instanceof` host chain). #1536's
shippable scope (gap #1 `.stack`, landed in the #1536 PR on top of the
#1104/#1473/#2077 machinery already on main, plus decisions #3/#4) leaves host
mode unaffected; doing this subclass rework inside #1536 risked a class-ctor
regression. The architect's plan explicitly sanctioned splitting it here.

## Acceptance criteria

- `class MyError extends Error {}` compiles + instantiates under
  `--target standalone` with **zero `env::` imports**:
  - `new MyError("boom").message === "boom"`
  - `new MyError("x") instanceof Error === true`
  - `new MyError("x") instanceof MyError === true`
- Host mode behavior unchanged (`instanceof`/`.message` still correct).
- No test262 regression; standalone `built-ins/Error` subclass tests improve.

## Notes

Route to **senior-developer**. Gated `ctx.wasi || ctx.standalone`; JS-host path
untouched. Local checks: `tsc --noEmit` + a `tests/issue-1536c.test.ts` that
asserts the three standalone behaviors above with an env-import assertion.
