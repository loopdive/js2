---
id: 3873
title: "for-in inside eval() crashes the checker — \"Internal error compiling statement: Cannot read properties of undefined (reading 'flags')\""
status: ready
created: 2026-07-31
priority: low
horizon: s
feasibility: easy
task_type: bugfix
area: codegen
es_edition: 5
language_feature: for-in, eval
goal: correctness
sprint: current
related: [3661]
origin: "2026-07-31 dev-es5-descriptors, while sizing standalone ES5 clusters for #3661"
---

# #3873 — `for-in` inside `eval()` throws in the TypeScript checker

## Defect

`compileForInStatement` (`src/codegen/statements/loops.ts`) calls
`ctx.checker.getTypeAtLocation(stmt.expression)` at **two** sites — the array
fast-path (~L3382) and the static-unroll fallback (~L3456). An `eval()` body is
compiled as **its own source file**, so its nodes carry no checker links;
TypeScript's `checkObjectLiteral` dereferences an undefined link and throws.
`compileStatement`'s catch (`statements.ts:100`) renders it as
"Internal error compiling statement", and the whole `for-in` fails to compile —
in **both** host and standalone.

## Minimal repro

```js
eval('for (var a in { x: 0 }) { }')   // crashes
eval('1;')                            // fine
for (var a in {x:0}) {}               // fine outside eval
```

The trigger is specifically **for-in inside eval**.

## Sizing (measured, not estimated)

**4 entries in 47,829** baseline entries — `language/statements/for-in/cptn-{decl,expr}-{abrupt-empty,itr}.js`, all four. For context, total `compile_error` entries corpus-wide are **661/47,829**.

## ⚠️ Do NOT land the guard alone — it flips ZERO rows

A try/catch at both sites, degrading to the generic enumeration path, was built and
measured: **passed 0 / attempted 4 / discovered 4**. The 4 files move
`compile_error` → `fail`, because behind the crash sits a **separate for-in
completion-value defect** (`eval('1; for (var a in {x:0}) {}')` yields the wrong
completion value). Net test262 delta **0**. It was reverted.

## ⚠️ Hot-path risk — the reason for the revert

The guard converts a crash into a **silent no-loop degradation**: any `for-in`
whose receiver type fails to resolve would emit **no loop at all**. That is a
behaviour-change risk across every `for-in` receiver in the compiler, bought for
zero rows.

**Only worth landing together with the completion-value fix**, where it would
actually flip these 4.

## Acceptance

- `eval('for (var a in { x: 0 }) { }')` compiles.
- The completion-value defect is fixed in the same change, so the 4 files actually
  pass rather than moving from `compile_error` to `fail`.
- No `for-in` receiver silently degrades to "no loop" — an unresolvable receiver
  type must still enumerate.
