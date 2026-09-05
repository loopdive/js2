---
id: 4748
title: "ES2015 standalone GeneratorPrototype Symbol.toStringTag"
status: done
sprint: current
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: es2015
language_feature: generator-prototype
goal: standalone-mode
related: [1516, 820j, 3236]
files:
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/call-builtin-static.ts
  - tests/issue-4748.test.ts
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/call-builtin-static.ts
func-budget-allow:
  - src/codegen/array-object-proto.ts::emitGeneratorPrototypeSingleton
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
---

# #4748 — standalone `%GeneratorPrototype%[@@toStringTag]`

## Baseline and duplicate audit

On fresh `upstream/main` `ed7ecba7c962aff39bdf6228b7d0190a0923cf49` (2026-08-25),
the exact Test262 row has this lane split:

```
test/built-ins/GeneratorPrototype/Symbol.toStringTag.js
  host:       pass
  standalone: fail — Cannot access property on null or undefined at
              GeneratorPrototype[Symbol.toStringTag]
```

The prior GeneratorPrototype fidelity work in #1516 (merged as PR #369) and
the chain-level residual in #820j (merged as PR #647) are complete on upstream.
The current open ES2015 `Symbol.toStringTag` PRs #4743 (Math/Reflect namespace)
and #4744 (ArrayIteratorPrototype) do not touch GeneratorPrototype; the open
generator-close PRs #4937/#4942 do not seed prototype tags. No open PR owns this
exact residual.

## Diagnosis

The standalone path materializes `%GeneratorPrototype%` as a real `$Object`
singleton in `emitGeneratorPrototypeSingleton`. It seeds only the string-keyed
`next`, `return`, and `throw` data properties. The host runtime's
`iterator-polyfills.ts` correctly defines an own `Symbol.toStringTag` property,
but standalone has no corresponding symbol-keyed own property. In addition,
the standalone `Object.getPrototypeOf(generator-instance)` lowering returns
that GP singleton directly; the exact Test262 row performs one more
`Object.getPrototypeOf` and therefore falls through the singleton's unmodeled
`$proto` field to null before the computed read. Both omissions surface as the
same null/undefined access failure.

## Implementation plan

1. Extend the existing standalone GeneratorPrototype singleton initialization to
   define `Symbol.toStringTag` with value `"Generator"` and exact ES2015 data
   descriptor flags `{ writable: false, enumerable: false, configurable: true }`.
   Reuse the established `__box_symbol(4)` and `__defineProperty_value` path used
   by native iterator and namespace carriers.
2. Recognize the narrow nested `Object.getPrototypeOf(Object.getPrototypeOf(
   generator-instance))` shape in standalone and evaluate the inner call for
   side effects before returning the same identity-stable GP singleton. This
   preserves the expected intrinsic chain without claiming a general runtime
   prototype model.
3. Re-resolve function indices after any late symbol import and keep the new
   seed inside the existing lazy-init body, preserving singleton identity and
   the host lane's byte-identical behavior.
4. Add the exact Test262 row in both host and standalone lanes plus a direct
   standalone zero-host-import/value/descriptor control.

## Acceptance criteria

- The exact row passes in host and standalone; host remains a passing control.
- The standalone property value is `"Generator"` and its descriptor is
  non-writable, non-enumerable, configurable.
- The singleton remains identity-stable and no host imports are emitted.
- Focused tests, typecheck, lint, format, issue checks, budgets, and hooks pass.

## Implementation summary

- Seeded the standalone `%GeneratorPrototype%` singleton with the own
  `Symbol.toStringTag` data property using the existing boxed-symbol and
  descriptor helpers.
- Added a standalone-only, shape-guarded nested `Object.getPrototypeOf`
  lowering for the exact intrinsic walk used by this Test262 row. The inner
  expression is still evaluated for source-order side effects, while the
  identity-stable GeneratorPrototype singleton is returned for the outer walk.
- Added the exact host and standalone Test262 pins and a standalone control for
  value, descriptor flags, and zero host imports.

## Test Results

- Exact Test262 row `built-ins/GeneratorPrototype/Symbol.toStringTag.js`:
  host pass; standalone pass (baseline standalone failure reproduced before
  the patch).
- `tests/issue-4748.test.ts`: 3/3 passed.
- Generator controls `tests/issue-1639.test.ts` and
  `tests/issue-3236-slice1b-genproto-call.test.ts`: 11/11 passed.
- Additional Test262 controls: generator prototype relation, prototype value,
  and GeneratorPrototype `next` descriptor rows passed in both host and
  standalone lanes (6/6 lane checks).
- TypeScript 5 and TypeScript 7 no-emit checks passed; Biome lint, Prettier
  check, and `git diff --check` passed.
- LOC/function budgets passed with the two listed issue allowances;
  stack-balance, dead-export, issue-ID/integrity, issue metadata, and
  retirement-ledger checks passed.
- The repository `pnpm` shim attempted to fetch its pinned pnpm version in
  this offline environment, so the changed-root shell wrapper could not start;
  its selected root test was run directly with the equivalent single-fork
  Vitest command above.
