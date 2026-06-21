---
id: 1536c
title: "standalone-native user Error subclass: instance creation via __new_<Parent> + native instanceof tag chain (no host imports)"
status: done
completed: 2026-06-17
assignee: sendev-closures
sprint: 63
created: 2026-06-16
updated: 2026-06-17
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

## Resolution (2026-06-17)

All acceptance criteria pass under `--target standalone` with **zero `env::`
imports**; JS-host mode unchanged. Three gated change-sites (all
`ctx.wasi || ctx.standalone`):

1. **Instance creation** — `src/codegen/class-bodies.ts`, both the implicit
   derived-ctor block (`!ctor && isExternrefBacked`) and `compileSuperCall`:
   when the externref-backed subclass's builtin parent is a WASI error name,
   emit the native `__new_<Parent>` internal function via
   `emitWasiErrorConstructor(ctx, parent, arity)` and call it from `ctx.funcMap`
   instead of `ensureLateImport` (the host import). Produces a real
   `$Error_struct` (parent `$tag`, `.message`, `.name`). JS-host keeps the
   import.
2. **`instanceof`** — `src/codegen/expressions/identifiers.ts`: the host
   `__tag_user_class` tagging block (`class-bodies.ts`) is skipped standalone;
   `instance instanceof MyError` / `instanceof Error` resolve natively. The
   `$Error_struct` `$tag`-discrimination path (#1473) now also fires for a
   user class whose builtin parent is an error (`userErrorParent`), using the
   parent's `collectErrorInstanceOfTags` set — guarded by `ref.test
   $Error_struct` so a non-Error value yields `false`.
3. **`.message`/`.name`/`.stack`** — `src/codegen/property-access.ts`: the
   native struct-field read fast-path (`isErrorLhs`) now also treats a
   user-Error-subclass receiver (`classBuiltinParentMap` → error) as an Error
   LHS, reading `$Error_struct` fields directly instead of the generic
   `__extern_get` host path (which returns null standalone).

Verified (`tests/issue-1536c.test.ts`, 7 cases): `new MyError("boom").message`
=== "boom"; `instanceof Error`/`instanceof MyError` true; non-Error not an
instance; explicit `super(m)` ctor; `class MyTE extends TypeError` chains to
both `TypeError` and `Error`. Host mode spot-checked unchanged. Typecheck +
IR-fallback gate clean.

**Precision note (follow-up #2188):** `instance instanceof MyError` resolves to
"is an Error-family struct compatible with MyError's *builtin parent*" — exact
for a single subclass, but two distinct `extends Error` siblings are not
mutually distinguished (both share the parent `$tag`). Full per-user-class
discrimination needs a brand on the instance (the `$ClassMeta`/`$parentTag`
work, #2101). Filed as #2188; out of scope for #1536c's single-subclass
acceptance.
