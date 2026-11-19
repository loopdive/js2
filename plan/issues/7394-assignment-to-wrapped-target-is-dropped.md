---
id: 7394
title: "An assignment to a wrapped target (`(x) += 1`, `(x!) = 5`, `(x!)++`) compiles to nothing"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7360]
---

# #7394 — an assignment whose target sits in parentheses or a type-erased wrapper is dropped

## Problem

Found while fixing #7360 (RV7307). A target wrapped in parentheses or a TypeScript wrapper that emits
nothing (`!`, `as`, `satisfies`, `<T>`) is a valid simple assignment target (§13.15.1: the parenthesised
form is a simple target, and TypeScript erases the type wrappers). Several assignment forms on such a
target compile without an error, but the target keeps its old value:

```ts
let x: number = 2;
(x) += 5;   // node: x === 7; we leave x === 2
(x!) = 5;   // node: x === 5; we leave x === 2
```

Measured on `origin/main` 89e4748241 (2026-11-19), default and `--target standalone` alike. Targets: a local,
a class field, an array element, a module global. All four targets behave the same in every row.

| form | `(t)` / `((t))` | `(t!)` | `(t as number)` / `(t satisfies number)` |
| --- | --- | --- | --- |
| `=` | correct | **dropped** (keeps old value) | compile error "Invalid left-hand side in assignment" |
| `+=` `-=` `*=` `\|=` (every compound operator) | **dropped** | **dropped** | compile error |
| `??=` `\|\|=` `&&=` | **dropped** (`&&=` shows it; `??=`/`\|\|=` on a set value are no-ops anyway) | **dropped** | compile error |
| `t++` / `++t` | correct | **dropped** | not measured |
| value of `((x) += 1)` | the old value, and `x` unchanged | | |

The logical row is fixed on #7307's branch (`compileLogicalAssignment` now dispatches on the peeled target,
RV7307 round 2). Every other bold cell still fails there.

### Separate row — `(x as number) ??= 7` (and every `as` / `satisfies` target)

These are refused by the early-error pass (`src/compiler/early-errors/predicates.ts`,
`isInvalidAssignmentTarget`), which does not look through `as` / `satisfies` / `<T>`. TypeScript accepts
them and erases the wrapper, so the refusal is wrong but loud: a compile error, never a wrong answer.

`(o.a as number) ??= 7` (RV7307) is in the same compile-error row; with this fix it assigns. On a field that is
left uninitialised it still reads `0` first, which is #7366 (the field's default), not this issue.

### Two analyses that also missed the write (found while fixing)

Once codegen assigned the wrapped target, two analyses still read it as unwritten:

- **The legacy i32-local analysis** (`collectI32CoercedLocals`, `src/ir/analysis/i32-coerced-locals.ts`) gives an
  integer-initialised local an i32 slot unless a write proves otherwise. It looked only at a bare identifier target and
  recorded only `=`, `+=`, `-=`, `*=` and the bitwise compounds, so `/=`, `%=`, `**=` and the logical operators were
  never seen. This is a wrong answer on main without any wrapper: `let x: number = 10; x /= 4; return x;` returns `2`
  whenever the IR leaves the function to legacy codegen (`experimentalIR: false` shows it).
- **The single-assignment write scan** (`writingOccurrences`, `src/codegen/single-assignment-binding.ts`) looked
  through parentheses only, so after `(s!) += "cd"` the `s.length` fold (`tryStaticToNumber`) still took the
  initializer's length.

### Why it is silent

`compileCompoundAssignment` reaches `reportError(... "Compound assignment only supported for simple
identifiers")` for a parenthesised target (traced), yet `compile()` returns `success: true` with no
diagnostic, and the statement emits `f64.const 0; drop`. Some caller discards the diagnostic (see Left open
below).

## Implementation Plan

Legacy codegen only (no `src/ir/` change). Stacked on #7307 (same file, same peel).

- **One peel, at each assignment entry.** `skipTransparentExpressions` (`src/shared/transparent-expressions.ts`)
  is the existing helper, already used by `compileLogicalAssignment` on #7307. Apply it once at the top of
  `compileCompoundAssignment` and of `compileAssignment` (which today peels only parentheses with its own
  loop), and in the `++`/`--` target dispatch; dispatch on the peeled target. No second peel helper.
- **Early errors.** `isInvalidAssignmentTarget` looks through the type-erased wrappers
  (`unwrapTypeErasedExpression`) as it already does through parentheses, so `(x as number) += 1` and
  `(x as number) ??= 7` compile.
- **The dropped diagnostic.** Find where the `reportError` from an unsupported target is discarded and say
  in the PR whether it is fixed here or filed separately. A target codegen cannot lower must fail the compile,
  not ship `f64.const 0`.
- **The two analyses** (found while fixing). They peel the target with the same helper. The i32-local walk records
  every assignment operator (`FirstAssignment..LastAssignment`) and leaves the verdict to `isCompoundI32Safe`, which
  already returned `false` for every non-bitwise compound.
- **Quality criterion.** One peel per entry point through the shared helper; the parenthesis-only loops in
  `compileAssignment`, `unary-updates.ts` (its private `unwrapParens`) and `isInvalidAssignmentTarget` go away; no new
  predicate.

## Result (2026-11-19)

- `tests/issue-7394-wrapped-assignment-target.test.ts`: every assignment form (`=`, the 12 compound operators, the
  three logical ones, prefix/postfix `++`/`--`, the value of the expression) through `(t)`, `((t))`, `(t!)`,
  `(t as number)`, `(t satisfies number)`, `(<number>t)` on a local, a captured local, a field, an element and a module
  global, plus a string `+=`, an `any` target, `(o.a as number) ??= 7` and five legacy-path `x /= 4`-style rows; gc + standalone, answers from
  node. Base (#7307 head 68604aadf8): 846 of 966 fail; after: 966/966.
- Byte identity: 100 test262 files × gc/standalone, binaries identical (200/200).
- Net −31 lines in `src/`: the change removes `unwrapParens` and two parenthesis-only loops, and collapses a
  9-operator allowlist.

### Left open

**The dropped diagnostic.** `compileCompoundAssignment`'s `reportError` for a target it cannot lower is discarded:
the statement ships `f64.const 0; drop` with `success: true`. With every wrapper peeled this arm is no longer reached
by any target the early-error pass admits, so it is not chased here. It is worth a follow-up, because any future
unsupported target would be silent the same way.

## Review round 1 (RV7335, 2026-11-19, on 3557b051b7): BLOCKER

| finding | answer |
| --- | --- |
| MUST-FIX: unwrapping the target in `isInvalidAssignmentTarget` let an optional chain under `as`/`satisfies` compile and assign (`(o?.a as number) = 5`, `+=`, `++`), where the base correctly rejected it (TS2779) | **Fixed.** `hasOptionalChain` and `isCallExpressionTarget` now use the same helper (they unwrapped parentheses only), so the optional chain is seen through every wrapper. This also fixes `(o?.a!) = 5`, which has compiled since #4417. Pinned: those five targets are compile errors again, on gc and standalone. |
| nit: `compilePrefixUpdate` unwraps the operand three times | It unwraps once (`updateOperand`), and the `++`/`--` arms use that value. |
| nit: stale comment at `assignment.ts:337` | Rewritten. |
| neighbours: on the legacy path, `x >>>= 0` on −1 and `x++` at INT32_MAX give wrong results (pre-existing) | Filed as #7411. |

