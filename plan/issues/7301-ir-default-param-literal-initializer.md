---
id: 7301
title: "IR: default parameter with a literal initializer (harness formatPropertyName) — measured, 0 units: the body needs Symbol + RegExp"
status: blocked
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [7302, 1372, 2713]
assignee: "ttraenkler/c-lane-opus"
---

# #7301 — default parameter with a literal initializer (`formatPropertyName`)

## Problem

The call-graph-closure census (`plan/log/ir-call-graph-closure-census.md`)
ranked the harness `formatPropertyName(propertyKey, objectName = "")`
(`test262/harness/temporalHelpers.js:12`) first by files: 66 Temporal files /
69 units at stride 40 would be left with at most one legacy unit if it went
IR. Its refusal is `param-shape-rejected`, from the identifier-parameter
`if (p.initializer)` check in `whyNotIrClaimable` (`src/ir/select.ts`).

## Measurement (2026-11-07, main b83a8ee0, wrapped stride-40 standalone)

**(1) The default-parameter refusal.** A throwaway admission of
identifier parameters with a primitive-literal initializer (`""`, numbers,
`true`/`false`, `null`), selector only:

- `formatPropertyName` is the **only** stride unit refused for a
  literal-initializer default. The 79 files with a `param-shape-rejected`
  legacy unit also hold `f` ×5, `__js2wasm_Iterator_zip` / `zipKeyed` /
  `concat` ×4 each, `createOptionsObserver` ×2 and `af` ×1. All of these are
  refused for other parameter shapes (non-literal defaults, rest, patterns),
  so the admission does not change them.
- from-ast has no top-level default-parameter lowering. `lowerFunctionAstToIr`
  demotes `p.initializer` (`src/ir/from-ast.ts` ~L1763, #2713). Only nested
  closures have a default path (`pendingDefaults` / `defaultParamStart`,
  numeric initializers). So (1) needs a new from-ast arm and legacy's
  omitted-argument ABI for top-level functions. In legacy, a missing argument
  and an explicit `undefined` both take the default and `null` does not.

**(2) `formatPropertyName`'s body after (1).** The function was compiled in
isolation, stripping one construct at a time:

| order | refusal | construct |
| --- | --- | --- |
| 1 | `expr-ident-not-in-scope` `Symbol` | `Symbol.keyFor(propertyKey)`, `propertyKey.description` (symbol case) |
| 2 | `expr-regexp-method-target` | `ASCII_IDENTIFIER.test(propertyKey)` (module-level regex) |
| 3 | `expr-string-method-argument` `RegularExpressionLiteral` | `propertyKey.replace(/'/g, "\\'")` |
| 4 | `expr-template-substitution-family` | `` `${objectName}[${propertyKey}]` `` (dynamic parameter in a template) |

Items 1–3 need Symbol and RegExp values on the standalone IR. Those are new
value kinds here, so this brief's stop condition applies. Item 4 needs
ToString of the dynamic carrier inside a template.

**Units (1) would move on the stride: 0.** `formatPropertyName` stays legacy
on its body, and no other unit has the shape.

## Conclusion — stopped after measuring (1), per the brief

- No code. Implementing (1) now would add a from-ast default-parameter arm
  with no unit that claims through it. That is a speculative arm with one
  (blocked) user, which the IR quality rule forbids.
- The path to the 66 Temporal files reaching zero legacy units, in order:
  1. Symbol values on standalone IR (`Symbol.keyFor`, `.description`);
  2. RegExp values: a regex literal as an argument, and `.test` on a
     module-level regex;
  3. dynamic-carrier template substitution;
  4. this default-parameter admission, with its from-ast arm;
  5. **#7302**: the files' remaining `<module-init>` legacy unit,
     `ASCII_IDENTIFIER = /…/u` regex-literal module storage
     (`vardecl-module-storage-unrepresentable` / `expr-regexp-literal`). It
     shares item 2's RegExp value kind.
