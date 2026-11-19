---
id: 7410
title: "TypeScript's escaped well-known-symbol names (`__@replace@<id>`) leak into Wasm names and runtime strings; output depends on compile order"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
goal: ir-full-coverage
related: [7350]
---

# #7410 — TypeScript's escaped well-known-symbol names leak into Wasm names and runtime strings

## Problem

A compiled binary depends on how many compiles the same process ran before it. Byte-identity checks that
compile many files in one process (the B2c hashing scripts, any corpus diff) are then position-sensitive:
base and head agree only when both use the same file list and the same shard split.

Cause: struct fields for an object type are named from the TypeScript checker's property symbol
(`prop.name`). For a well-known-symbol key (`[Symbol.dispose]() {}`) that is TypeScript's internal escaped
name `__@dispose@<symbolId>`. The id is drawn from TypeScript's process-global symbol counter. The
`Symbol.dispose` symbol lives in the compiler library file, which is cached across programs, and is given
its id the first time any compile in the process asks for it; the id then stays fixed for the process. The
name reaches the module as a field name, a type name and a function name:

```wat
(type $__anon_0 (struct (field $disposed (mut i32)) (field $__@dispose@157 (mut externref))))
(type $__anon_0___@dispose@157_type (func (param (ref null 367))))
(func $__anon_0___@dispose@157 (param (ref null 367))
```

Found by #7350 B2c-2 (PR #7330): re-hashing 2,728 rows gave 38 differing rows on an unchanged tree.

## Second case: a runtime string (found by S12, traced 2026-11-19)

The same escaped name also reaches a value the program reads. `tryLengthAndNameReads`
(`src/codegen/property-access-dispatch.ts`, near line 3000) folds `fn.name` to
`objType.getSymbol()?.name` as a string constant. For a method keyed by a well-known symbol, that is the
escaped name. `staging/sm/RegExp/replace.js` reads `RegExp.prototype[Symbol.replace].name`, and the module
answers `"__@replace@22"`. ECMA-262 SetFunctionName (§10.2.9) gives `"[Symbol.replace]"`. So the answer is
wrong, and its digits change with compile order: `@22` in a fresh process, `@21` after compiling
`/x{3}x/`, `@23` after compiling `var a = 1 + 2;`.

In the binary, this shows as the code section staying identical while one string-literal global
(`$__strlit_818`) changes in section 6: its last code unit (`i32.const 50` vs `49`) and its hash constant.

Repro: compile the raw file (no harness) with
`{ allowJs: true, fileName: "t.js", skipSemanticDiagnostics: true }` on default or standalone, once in a fresh
process and once after any other compile in the same process. S12 measured default `744ce371…` fresh vs
`8b93c908…` warm, and standalone `d43c308a…` vs `5b301745…`, on main `89e4748241`.

## Repro (2026-11-19, PR #7330 head `113000e82a`)

File X = `test/language/statements/using/initializer-disposed-if-subsequent-initializer-throws.js`, compiled
the way the test262 runner assembles it (`assembleOriginalHarness` plus `originalHarnessCompileOptions`):

| compiles before X in the same process | default | standalone |
| --- | --- | --- |
| none | `0513ea4898ca` | `9da7f55998c0` |
| `Array/prototype/map/length.js` once | `39ff10c0fb18` | `36216ccabe96` |
| the same file twice | `b6be91492d73` | `f0c2a89a5816` |

- Each sequence reproduces its own hashes, and CPU load does not change them.
- Compiling X twice in one process gives the same bytes both times, because the id is fixed once assigned.
- Split into sections, only the `custom:name` section differs for X.
- The id moves from `@157` to `@731` after one earlier compile.

The 38 rows were these 19 files × default / standalone:

- `built-ins/AggregateError/`: `errors-iterabletolist-failures.js`, `errors-iterabletolist.js`,
  `order-of-args-evaluation.js`
- `built-ins/AsyncFromSyncIteratorPrototype/`:
  - `next/`: `iterator-result-poisoned-done.js`, `iterator-result-poisoned-value.js`,
    `next-result-poisoned-wrapper.js`
  - `return/`: `iterator-result-poisoned-done.js`, `poisoned-get-return.js`, `poisoned-return.js`
  - `throw/`: `iterator-result-poisoned-value.js`, `poisoned-get-throw.js`, `poisoned-throw.js`
- `built-ins/Iterator/concat/next-method-returns-throwing-done.js`
- `language/statements/await-using/`:
  - `initializer-Symbol.asyncDispose-called-if-subsequent-initializer-throws.js`
  - `initializer-Symbol.asyncDispose-called-if-subsequent-initializer-throws-in-forstatement-head.js`
  - `initializer-Symbol.dispose-called-if-subsequent-initializer-throws.js`
  - `initializer-Symbol.dispose-called-if-subsequent-initializer-throws-in-forstatement-head.js`
- `language/statements/using/`:
  - `initializer-disposed-if-subsequent-initializer-throws.js`
  - `initializer-disposed-if-subsequent-initializer-throws-in-forstatement-head.js`

## Open checks (answer before the fix)

(a) **Does any path sort fields by name?** If it does, this is a layout difference, not only a naming one,
and no one may rely on "code identical" until it is fixed. First look, not yet reproduced: yes.
`objectIrTypeFromTsType` (`src/codegen/index.ts`, near line 1664) builds IR object fields from
`tsType.getProperties()` with `name: prop.name` and then sorts them by name. Two other sorts sit nearby,
in `objectIrTypeFromLattice` (near 1617) and near 1978. With two well-known-symbol keys in one shape (for
example `[Symbol.iterator]` and `[Symbol.asyncIterator]`), their relative order would follow the symbol
ids. With one such key, its order against ordinary names does not depend on the id. Write a repro with two
symbol keys, and check whether the IR object shape reaches a Wasm struct layout.

(b) **Every site where a checker property name becomes a Wasm name or a runtime value.** Known so far:
- `ensureStructForType` (`src/codegen/index.ts`, near 12862), the struct fields and the `${structName}_${prop.name}`
  method names;
- `objectIrTypeFromTsType` (above);
- `generators-native.ts` near line 1710 (it matches the `__@iterator` prefix, so it reads the name but does not emit
  it);
- `tryLengthAndNameReads` (`property-access-dispatch.ts`, near 3000): `fn.name` folded from the type symbol's name.
  This one is runtime-observable.

Sweep the `getProperties` / `getPropertiesOfType` / oracle property queries whose names reach a field,
type, function or global name.

## Fix

One helper that turns a property symbol into its Wasm-facing key, deriving it from the source key rather
than the checker's escaped name. For example, `__@dispose@<id>` becomes `@@dispose` for the well-known
symbol `Symbol.dispose`, and ordinary names are unchanged. Every site from (b) calls it. Sorting by that
key is then stable. The `fn.name` fold uses the same helper to produce the spec's `"[Symbol.replace]"`
(SetFunctionName with a symbol's description), or declines the fold.

Do it after PR #7330 lands. Keep JS-environment output byte-identical except for the renamed names, and say
so in the PR.

## Acceptance

- The repros above: X and `replace.js` each hash the same in a fresh process and after any number of
  earlier compiles, on default and standalone.
- `RegExp.prototype[Symbol.replace].name === "[Symbol.replace]"` on standalone (or the read is no longer
  folded, and the realm answers it).
- Open checks (a) and (b) answered in the PR with the site list. If (a) is a layout difference, there is a
  test with two well-known-symbol keys whose struct layout is the same whatever the compile order.
- A test compiles one file, then compiles it again after an unrelated compile in the same process, and
  asserts identical bytes.
- Quality: one helper, no per-site string surgery.
