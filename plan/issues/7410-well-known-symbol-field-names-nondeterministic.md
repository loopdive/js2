---
id: 7410
title: "TypeScript's escaped well-known-symbol names (`__@replace@<id>`) leak into Wasm names and runtime strings; output depends on compile order"
status: done
completed: 2026-11-19
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
goal: ir-full-coverage
related: [7350, 7427]
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

## Fix (first proposal, superseded by the Implementation Plan below)

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

## Implementation Plan (2026-11-19)

**Where the fix lives.** The escaped name is a valid compiler-internal key: struct fields, method helpers and
`funcMap` rows are created and looked up by `prop.name` in hundreds of places, consistently within one compile.
It must not reach output. So the fix goes at the two places where it leaves the compiler, not at the places
that create keys:

- **Runtime `.name`** (`property-access-dispatch.ts`): `foldableTypeSymbolName` replaces
  `nameFoldTypeSymbolIsDeclarationArtefact` and gathers every type-symbol name that cannot be published, in one
  predicate: `__computed`, the descriptor accessor slot, and now a symbol key. A well-known key folds to the
  spec's `[Symbol.replace]` (`functionNameForKey`, new `src/checker/well-known-symbol-keys.ts`, which checks that
  `Symbol` in `[Symbol.replace]` is the compiler library's binding). Any other symbol key declines, so the
  closure's own `$fnmeta` answers at run time.
- **Emitted names** (`src/emit/binary.ts`): the name section is the only place a compiler name enters the
  binary, and it holds only function names. `withoutSymbolIds` (new `src/emit/debug-names.ts`) drops the id
  there: `__@dispose@157` → `__@dispose`. Type and field names appear only in WAT text.

**Reuses / removes.** One predicate for unpublishable fold names, instead of a second check beside the old one.
No per-site renaming.

**Quality acceptance.** One helper per exit point; no change to how keys are created or looked up.

## Resolution (2026-11-19)

**Open check (a), sorting by name.** Fields are sorted by the escaped name (`objectIrTypeFromTsType` and the
sorts in `index.ts` near 1617 and 1978). Well-known keys never reorder: two of them differ in their key part
(`__@iterator` vs `__@toPrimitive`) before the id is reached. Against an ordinary name, the `__@` prefix decides.
**Residual:** two different user symbols with the same name in one shape (`[a.k]` and `[b.k]`, both
`unique symbol` named `k`) order by id, so their layout can still depend on compile order. That is not fixed
here; it needs the key's declaration identity, not its name.

**Open check (b), every site.** A sweep compiled 666 test262 files that use a `[Symbol.x]` key (every fifth
file plus the 20 above) on default and standalone. It scanned each binary for `__@<letters>@<digit>` in names
and for `__@` as a native string constant.

| site | what leaked | disposition |
| --- | --- | --- |
| `tryLengthAndNameReads` | `fn.name` string | fixed here |
| name section | function names | fixed here (`withoutSymbolIds`) |
| `expressions/calls.ts` near 1242, reflective member call | `member = sym.getName()`, so the refusal message reads `String.prototype.__@iterator@84 …` and the glue's `@@1` member is missed | #7427 |
| `literals.ts` near 810, `materializeStructAsDynamicObject` | a `[Symbol.match]` field becomes the string-keyed property `"__@match@158"` | #7427 |
| `ensureStructForType`, `objectIrTypeFromTsType`, `generators-native.ts` | internal keys only | unchanged: they never reach output except through the name section |

After this change: 0 names. The only strings left are the two #7427 sites (String/prototype `Symbol.iterator`
and `replaceAll` files).

**Measured.** Here "this branch" is the fix on top of main 89e4748241:
- The 19 files above plus `staging/sm/RegExp/replace.js` were hashed in two processes, one in list order and one
  in reverse order, so each file follows a different set of earlier compiles. On this branch, 39 rows, 0 differ.
  On main the same files differed (the 38 rows above, and S12's `replace.js`).
- `tests/issue-7410-symbol-key-names.test.ts`: 13 tests pass. On main, 6 fail.
  - The `.name` rows are pinned against node on default and standalone; node also answers the user-symbol row.
    The `Symbol.dispose` row is not pinned, because node 22's `Symbol.dispose` is a polyfill named
    `nodejs.dispose`.
  - Another test asserts that no emitted name matches `__@x@<digit>`.

**Acceptance as met.** An in-process recompile test cannot tell the two apart, because the id is fixed once
assigned in a process, so `compile X; compile Y; compile X` matches on main too. The test therefore asserts the
cause (no id in any emitted name, the right `.name`). The order dependence itself is checked by the two-order
hash run above.

**Found on the way, not fixed:** reading `.name` of an object-literal method keyed by `Symbol.iterator`,
`Symbol.toStringTag` or `Symbol.split` throws on default and standalone, on main as well.

## Review round RV7343 (2026-11-20)

- A symbol-keyed member of the compiler library declines the fold (`functionNameForKey`): a built-in's name is
  its own, so `Array.prototype[Symbol.iterator].name` is `"values"` and `Map.prototype[Symbol.iterator].name`
  is `"entries"`; the runtime read answers them. Rows for Array, Map, Set, `Uint8Array` and String are pinned
  against node on default and standalone.
- The `Symbol` binding check uses `ctx.oracle.declarationsOf`, so the oracle-ratchet grant is gone.
- The fold is computed only when the read has a function signature; the dead `?? ""` is gone.

## Suspended Work (2026-11-20, budget window closed)

- Branch `claude/7410-well-known-symbol-names`, PR #7343 (`hold`). Head: the RV7343 round above.
- Next step: RV7343 (session `session_016FRcLxKwW4sLrG6pxxHZSj`) re-reviews the delta from `805df5008c`. Then
  the lead releases the hold.
- Follow-ups: #7427 (stacked on this branch, pushed, no PR yet; see its own Suspended Work), #7432 and #7429
  (filed on docs PR #7328).
