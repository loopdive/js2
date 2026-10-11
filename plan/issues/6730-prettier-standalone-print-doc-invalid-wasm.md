---
id: 6730
title: "prettier standalone-dynamic lane: `Ce` (printDocToString) emits invalid Wasm — `struct.get[0] expected type (ref null N), found if of type f64`"
status: done
sprint: current
created: 2026-09-28
updated: 2026-09-29
completed: 2026-09-29
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone-mode
---

## Problem

With the #680 prettier generator shapes lowered natively (2026-09-28), the
prettier `standalone-dynamic` lane gets past codegen and fails on validation:

```
wasm-opt -O4 did not produce the measured artifact: wasm-opt -O4 failed: [parse exception: invalid type on stack (at 0:805877)]
```

V8 names the function:

```
CompileError: WebAssembly.compile(): Compiling function #379:"Ce" failed: struct.get[0] expected type (ref null 314), found if of type f64 @+805849
```

`Ce` is prettier 3.8.1 `standalone.mjs`'s `printDocToString`
(`function Ce(e,t){let u=Object.create(null),r=t.printWidth,…`). Somewhere in
it a value-producing `if` typed `f64` feeds a `struct.get` on a struct ref — a
conditional/branch result whose arms were unified to f64 while the consumer
still expects the struct carrier.

**Not caused by #680.** Measured on main `2e23e49fb1` with the three prettier
generators (`be`, `Cr`, `Ko`) replaced by plain `return []` stubs: the same
function fails the same way (`… found if of type f64 @+802640`). It was
hidden behind the #680 generator refusal, which aborted compilation first.

## Reproduce

```bash
npx tsx scripts/generate-npm-compat-report.mjs --only prettier --no-write --perf-only \
  --lane standalone-dynamic --inspect-binary .tmp/prettier.wasm --preserve-debug-names
node -e 'WebAssembly.compile(require("fs").readFileSync(".tmp/prettier.wasm")).catch(e=>console.log(String(e)))'
```

## Acceptance

- The lane's unoptimized binary validates; the lane reports the next blocker
  (or a measured perf row).
- A reduced regression test for the offending expression shape, failing on
  the parent and passing with the fix.

## Implementation Plan

Measured on `c8b4f0ef36` (upstream main), executed as written.

1. **Reduce.** `Ce` alone (with prettier's real indentation helpers `fr`,
   `lr`, `dr`, `Ht`) reproduces; with identity stubs for them it validates.
   The failing read is `a.length` in Ce's loop header: Ce's ARRAY `a` sits in a
   `__boxed_a` cell of the **f64** ref-cell type. An `allocLocal` trace shows
   the cell is minted by `promoteAccessorCapturesToGlobals` in
   transitive-only mode, called from `compileNestedFunctionDeclarationInScope`
   while lifting Ce's nested `y()`.
2. **Mechanism.** `ctx.funcMap` / `ctx.nestedFuncCaptures` are keyed by bare
   name across frames. `fr` declares nested helpers `i`, `D`, `f`, `l`, `d`,
   `c` that capture fr's mutable NUMBER `a` and STRING `o`; Ce has plain `let`
   variables `f`, `l`, `d`, `c`, `D`, `i`, which `y()` reads. The #5148 sibling
   classifier treated the registry entries as siblings because its only
   foreign signal ("a recorded capture is not sourceable from this frame") was
   satisfied by Ce's same-named locals `a`, `o`, `s`, `n`. Promotion then
   boxed Ce's `a`/`o` with fr's value types.
3. **Fix (the arm).** Move the classifier into
   `src/codegen/statements/nested-sibling-visibility.ts`
   (`classifyReferencedSiblingFns`) and add a lexical-scope signal:
   `ctx.funcMapOwnerDecl` names the declaration that owns a registry entry;
   when its enclosing container is not an ancestor of the declaration being
   lifted, the entry is not what the name resolves to. Then an own capture of
   the lifted function (arrives as a param) or an unknown name is skipped, and a
   frame local keeps the #5148 value-promotion. A detached/synthesized node
   chain keeps the old behavior.
4. **Regression test** `tests/issue-6730-foreign-sibling-capture-box.test.ts`
   (host + standalone): the reduced foreign-same-name shape plus a
   genuine-in-scope-sibling control.

## Resolution

- Regression test: parent 2/4 (both foreign rows fail "binary should
  validate"; controls pass) → fix 4/4.
- prettier `standalone-dynamic` lane: before `optimization-error` —
  `Compiling function #379:"Ce" failed: struct.get[0] expected type (ref null 314), found if of type f64`;
  after, Ce validates and the NEXT blocker is
  `Compiling function #1621:"__closure_336" failed: extern.convert_any[0] expected type anyref, found local.get of type f64 @+2359308`
  (filed as [#6743](./6743-prettier-standalone-closure-f64-param-extern-convert.md)).
- Scoped standalone test262 (1224 rows: `statements/generators`,
  `expressions/generators`, `statements/function`, `function-code`;
  `scripts/run-test262-paths.mts --standalone`): parent 1139 pass / 74 fail /
  11 CE → fix 1139 / 74 / 11, identical non-pass sets (no losses, no gains).
- JS-host dogfood controls (shared codegen): prettier 108/151, hono 271/324 —
  unchanged.
- Found while writing the test, pre-existing and unrelated to this path:
  [#6744](./6744-string-length-arith-fold-ignores-closure-write.md)
  (`s.length * 10` folds to the initializer's length when `s` is written only
  by a closure).
