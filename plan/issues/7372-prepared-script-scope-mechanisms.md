---
id: 7372
title: "Prepared IR path: script-scope mechanisms (nested var, block functions, undeclared globals, delete)"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-26
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: [7354]
related: [7354, 7106]
# 2026-11-19 (review RV7321b, must-fix 1): src/ir/program-source.ts +1, the producer's filter by the shared
# module-init global rule (`isModuleInitGlobalDeclaration`): an ES module's nested `var` / `for` head is a
# module-init local, not a global. The rule itself lives in src/ir/module-init-vars.ts.
loc-budget-allow:
  - src/ir/program-source.ts
---

# #7372 — Prepared IR path: script-scope mechanisms

> Id: #7372, reserved for this lane by the C lead (2026-11-19 14:50Z). The local commits first used #7365, a
> dry-run preview that turned out to be lane S6's reservation; renumbered in the commit that adds this note.

## Problem

Lane S9's census (main `ee3fcdd610`, all 8,717 positive ES5 test262 files through the strict Prepared entry with a
stand-in harness) names four first gaps with no issue, all script-scope / global-object mechanisms that extend
#7354 slice H (the dynamic home of a script `var`):

| first gap | files |
| --- | ---: |
| a `var` nested in top-level code (inside `if`/`for`/`try`/`switch`/block) | 245 |
| a FunctionDeclaration in a block | 69 |
| a write to an undeclared global (sloppy `x = 1`) | 53 |
| `delete` | 37 |

Figures are S9's, not re-measured here (S9's per-label file lists and its Prepared census script are not on its
branch `claude/es5-census-1119` yet, which holds the ordinary-pipeline census only).

## Implementation Plan

Measured on main `ee3fcdd610` (2026-11-19), strict Prepared entry, standalone:

- `if (true) { var x = 1; } if (x !== 1) throw 1;` → `identifier "x" is not in scope in <module-init>`
- `{ function f() { return 1; } } f();` → `unsupported body statement FunctionDeclaration in <module-init>`
- `x = 1; if (x !== 1) throw 1;` → `assignment to undeclared identifier "x" in <module-init>`
- `var x = 1; delete x;` → `delete has no IR lowering in <module-init>`
- `for (var i = 0; i < 3; i++) {} if (i !== 3) throw 1;` already ran (the `for` head was a module-init local).

### Slice 1 — a `var` nested in top-level code

Root cause: the ordinary pipeline already models these `var` lists (`isModuleInitVarList`, #7106 levers L/L2) and
the identity layer already numbers them (`moduleBindingDeclarationOrder` appends them after the top-level
statements' declarations), but the Prepared producer made globals for top-level `VariableStatement`s only, so a
nested `var` fell through to a block-scoped module-init local.

Target structure (no new module; each change sits beside the code it extends):

- `src/ir/program-source.ts` — the producer takes its globals from `moduleInitBindings`, the same per-statement
  list the ordinary pipeline's `buildModuleBindingsMap` (`src/ir/integration.ts`) uses. Removes the producer's own
  hand-rolled top-level `VariableStatement` walk (the duplicate). Patterns still refuse by the existing name.
- `src/ir/module-init-plan.ts` — the startup plan adds a `var` binding (`undefined-at-instantiation`, no TDZ) for
  each nested ordinal `moduleBindingDeclarationOrder` already assigns, so the program input's storage join finds
  the global's startup binding.
- `src/ir/source-dynamic-provenance.ts` — a nested script `var` is the global it is, so its read carries the
  dynamic value when its home is dynamic.
- `src/ir/module-binding-script-var.ts` — the typed home's reads proof accepts a top-level `for (;;)` head, which
  runs once before its own test, body and update and before every later top-level statement; so a top-level loop
  counter stays `f64` instead of becoming dynamic (the dynamic relational operators have no Prepared intrinsic).
- Reused unchanged: H's dynamic home (`irOwnedScriptVarHome`), the D1 carrier, the module-init prologue that
  stores `undefined`, from-ast's module-binding lowering (`bindUninitializedModuleVar`, the global write).

Rule: ES5 §10.5 — every `VariableDeclaration` in the script's code (outside functions) is instantiated on the
global environment with `undefined`, wherever its statement sits.

Still refused by name: a repeated `var` (no single global per name yet, `not-direct`), a `var` redeclaring its
catch parameter (Annex B.3.5), a pattern, a `for-in` head, a `var` in a `with` body.

Code-quality acceptance: no new module and no new predicate; the producer's duplicate top-level walk is replaced by
the shared `moduleInitBindings`; no growth grant.

### Slice 1b — one global per repeated `var` name

A repeated script `var` (`for (var i…) {} for (var i…) {}`) is one binding. The resolver already picks the first
declaration as the canonical identity (`uniqueTopLevelVariableDeclaration`, `allowRedeclaredVar`); the Prepared
home refuses because it requires one declaration. Plan: the home and the producer key by the canonical
declaration; each later declarator maps to the same global entry; the startup plan records no storage for a
redeclaration's ordinal.

### Slice 2 — FunctionDeclaration in a block at script level (planned)

Rule to state and build: ES5 has no block functions; the test262 ES5 files rely on the web-legacy behaviour that
Annex B.3.3 (ES2015) codified for sloppy scripts: the function is hoisted inside its block (callable before its
statement in the block), and when its statement is evaluated the function value is also assigned to a script
`var` of the same name (undefined before). Build the block-level binding only where the function is a direct
callable (no value use); refuse by name a block function used as a value, one in strict code, and one whose name
collides with a lexical binding.

### Slice 3 — undeclared names: the absent-global home (lane S10, plan 2026-11-26)

Replaces the earlier four-line plan. The home is shared:

- lane S19 reuses it: 2a for an unbound read, 2c for an eval-created global;
- slice 4 reuses it for `delete`.

The API is stated below so that S19 can agree to it first.

**Measured** (main `1a726b3e64`, 2026-11-26, `prepared-census.mts --harness real`, which skips negatives): on o411,
12 rows stop first at an undeclared name, with an expected **+7** (an estimate); on the wider ES5 set, 166 rows, an
estimated ≈ +116. The per-row lists and the method are in "Slice 3 measurements" below.

**Semantics** (ES5 §8.7.1–2, §10.2.1.2, §11.4.3; ES2024 §6.2.5.5–6, §9.1.1.4, §13.15.2). A reference no
environment binds is unresolvable.

- GetValue throws ReferenceError, in sloppy and strict code; `typeof` answers `"undefined"`.
- PutValue in sloppy code creates a writable, enumerable, **configurable** global property; in strict code it
  throws ReferenceError.
- The reference is resolved before the RHS runs. So a strict write whose name was absent then throws even if the
  RHS creates it. V8 deviates and stores; that program is pinned to the spec.
- Compound assignment and `++`/`--` run GetValue first, so they throw before the RHS when the name is absent.
- Once created, the name is an ordinary global property; it differs from a `var` only in being deletable (slice 4).

**Why a per-name home is exact.** Under the H2 invariant (`module-binding-script-var.ts` header), the global object
never becomes a value on this path. Every route that would expose it refuses at its own site under its existing name:
script or sloppy `this`, `globalThis`, `with`, direct `eval`, `Function(…)`. So identifier references are the only
observers of a property an undeclared write creates. The slice needs nothing from Session B.

**The home.** A name *N* gets one when some identifier write targets it as an unresolvable reference anywhere in the
script: `=`, a compound assignment, or `++`/`--`. A name that is only read is **unbound**.

**Block functions (Annex B.3.3; PRV finding 1).** TypeScript gives a block FunctionDeclaration no symbol outside its
block, even in sloppy JS, so `{ function f(){} } f = 1; f;` and `function g() { { function f(){} } f = 2; return f; }`
look unresolvable. They are not: B.3.3 makes `f` a var of the script or of `g`, or skips it.

- `collectAbsentGlobals` takes S19's B.3.3 decision as the input `blockFunctionVar(scope, name)`:
  - `"applied"`: the name is S19's var home; slice 3 makes no absent home and answers nothing for it;
  - `"skipped"` (script scope): the name is an ordinary unresolvable reference; its writes, collected like any
    other, give it an absent home, and a read is unbound otherwise.
- The decision is pure AST and shared (S19, 2026-11-26): `"applied"` ⇔
  `annexBBlockFunctions(scope).some((e) => e.writesVar && e.declaration.name.text === name)`
  (`src/shared/annexb-block-functions.ts`, from #7447); one applied declaration of a name makes it applied. The
  parameter defaults to that predicate, so neither slice passes it in; the parameter stays only so tests can vary it.
- If slice 3 lands before #7447, the default is "refuse": every such name refuses by name, `name 'f' is declared by
  a block function (Annex B.3.3), which this path does not decide yet`.
- Inside a function body both answers stay refused (or aborted) until S19's 2b.
- No by-name lookup: the decision is an input to the one collection, so a write and a read of `f` always reach the
  same answer.

- Storage: a dynamic value global *N* and an i32 flag *N*`$present`.
- Invariant: flag 0 ⇒ value `undefined`. The flag starts at 0. The value starts at `undefined` through the
  module-init prologue that `legalizeDynamicGlobals` already writes for every dynamic global.

| operation | home | unbound |
| --- | --- | --- |
| read | flag 0 → throw; else the value | throw |
| `typeof` operand | the value, unchecked | build-time `"undefined"` (today's fold) |
| sloppy `=` | RHS; store; flag := 1 | — (any write makes a home) |
| strict `=` | read the flag; RHS; flag was 0 → throw; store | — |
| compound, `++`/`--` | flag 0 → throw; then the existing compound/update code on the value global | — |

**The ReferenceError** is the realm's %ReferenceError% with the message `"N is not defined"`.

- It is built by the IR that source `new ReferenceError(m)` lowers to: `lowerRealmIntrinsicRead(errorConstructorId
  ("ReferenceError"))` and then `emitDynConstruct`, which the legalization turns into `js.object.create-error`
  (`dynamic-error-constructors.ts`).
- So `assert.throws` sees the right `constructor`, shadowing the global name changes nothing, and no second
  constructor or backend change is needed.
- `programObjects.namesErrors` (`source-plain-objects.ts:40`) also holds for a program with an unresolvable reference,
  so that the realm holds the Error family.
- A lane without function objects refuses by name: `ReferenceError for undeclared name 'N' needs the realm's Error
  family`.

**The shared module, `src/ir/absent-globals.ts`.** It is the only code that touches the two globals. API:

```ts
/** A global property no declaration creates (§9.1.1.4): made by a sloppy write; (2c) by an eval `var`. */
export interface AbsentGlobalHome {
  readonly name: string;
  readonly value: IrGlobalRef; // dynamic carrier; `undefined` while absent
  readonly present: IrGlobalRef; // i32; 0 = absent
}
/** How a reference no declaration binds resolves at run time. */
export type UnresolvableName =
  | { readonly kind: "home"; readonly home: AbsentGlobalHome }
  | { readonly kind: "unbound"; readonly name: string };

// Producer side: pure, backend-independent.
/** The one rule: a value reference no declaration binds (no checker symbol; not inside `with`; not `arguments`;
 *  not a name the script declares at top level, which guards the checker's lib-merge answer). A name a block
 *  FunctionDeclaration declares anywhere in the enclosing scope is never decided here: see `blockFunctionVar`. */
export function isUnresolvableReference(checker: ts.TypeChecker, node: ts.Identifier): boolean;
export interface AbsentGlobals {
  /** The program input's rows (value + flag), owned by the script's module-init. */
  readonly globals: readonly ProgramSourceGlobal[];
  /** The startup bindings (`initialization: "absent"`), numbered after the script's own. */
  readonly bindings: (firstOrdinal: number, bindingId: (ordinal: number) => IrBindingId) => IrModuleInitBindingIntent[];
  /** `node`'s resolution when `isUnresolvableReference`, else `undefined`. */
  readonly resolve: (node: ts.Identifier) => UnresolvableName | undefined;
}
/** (Annex B.3.3) S19's decision for a name a block function declares in `scope` (the script or a function body). */
export type BlockFunctionVar = (scope: ts.SourceFile | ts.FunctionLikeDeclaration, name: string) => "applied" | "skipped";
export function collectAbsentGlobals(input: {
  readonly checker: ts.TypeChecker;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly identity: IrPlanningIdentityContext;
  /** Absent until S19's slice 2 lands; then every such name is refused by name. */
  readonly blockFunctionVar?: BlockFunctionVar;
}): AbsentGlobals;

// Lowering side: one IrFunctionBuilder.
/** GetValue: ReferenceError while absent or unbound. */
export function lowerUnresolvableRead(b: IrFunctionBuilder, name: UnresolvableName): IrValueId;
/** The one `typeof` entry: a home's value unchecked; `undefined` for an unbound name. Replaces `absentGlobalTypeof`. */
export function lowerUnresolvableTypeofOperand(b: IrFunctionBuilder, name: UnresolvableName): IrValueId;
/** `=`. `strict` is the strictness of the code holding the reference. Returns the stored value. */
export function lowerAbsentGlobalWrite(b: IrFunctionBuilder, home: AbsentGlobalHome, strict: boolean, rhs: () => IrValueId): IrValueId;
/** GetValue's presence check, then the value global as the existing compound/update code's storage. */
export function absentGlobalStorage(b: IrFunctionBuilder, home: AbsentGlobalHome): { readonly globalRef: IrGlobalRef; readonly type: IrType };

// Added by their own slices, in this file. Nothing is exported before its first user.
// slice 4: lowerAbsentGlobalDelete(b, name): IrValueId
//   home: flag := 0, value := undefined, `true`; unbound: `true`.
//   A sloppy write re-creates; a strict write re-checks the flag after the RHS (stillExists, §9.1.1.4.5).
// S19 2c: lowerCreateGlobalVarBinding(b, home): void
//   CreateGlobalVarBinding (§9.1.1.4.17): if flag == 0 then { value := undefined; flag := 1 }; a present
//   property is left as it is. 2c adds eval-declared names to `collectAbsentGlobals`.
```

**Where it plugs in.**

- **Producer:** `prepareIrProgramSources` (`program-source.ts`, beside `functionDeclarationValues` at ~1643) calls
  `collectAbsentGlobals`, which collects writes with `identifierWritesOf`.
  - Its rows go into the input's `globals` and through `legalizeDynamicGlobals`, but **not** into module-init's
    `moduleBindings` scope map (`program-source-units.ts` ~184). A home must never look like a plain `moduleGlobal`,
    whose writes would not set the flag.
  - **R1 fork taken:** main's `prepareSourceGlobals` (`program-source.ts` ~1496). PR #7329's separate registry was
    closed as superseded, so the rows join the globals `prepareSourceGlobals` already builds.
- **Startup:** the intents are appended in `buildIrModuleInitPlan` (`module-init-plan.ts` ~436), as F1b's are.
  - `IrModuleInitBindingIntent` (`program/startup.ts`) gains `declarationKind: "global-property"` with
    `initialization: "absent"`: R1's anticipated `global-object-property` kind.
  - The flag rides in the `tdzBindingId` / `tdzGlobalRef` slot, which means "not usable while 0". So the input pair
    check (`program/input.ts:51–68`) and the ABI storage (`program-abi-contracts.ts:107`) are unchanged;
    `program/validation.ts:596` gains one row.
  - **It is a presence flag, not a TDZ flag (PRV finding 2b).** The intent names it so
    (`initialization: "absent"`, the flag documented as "present"), and unlike a TDZ flag it can go 1 → 0 under
    slice 4's `delete`. So no consumer may treat it as monotonic.
  - **No module-binding read path (PRV finding 2a).** A post-startup unit sets `omitTdzReadCheck`, which elides the
    TDZ check on `moduleGlobal` reads (`from-ast.ts` ~4899). A home is never a `moduleGlobal` binding, and every read
    of it goes through `lowerUnresolvableRead`, which always checks the flag. Test 11 pins it.
- **Resolver:** `unresolvableName?(node): UnresolvableName | undefined` replaces `unresolvedNameIsAbsent?(node)`
  (`from-ast.ts:976`).
  - It is answered from `AbsentGlobals.resolve` in `lowerUnitOnce`, beside `resolveModuleBinding`.
  - `absentGlobal` (`source-dynamic-contracts.ts:450`) is deleted. The ordinary pipeline never answers the hook.
- **from-ast:** one call replaces each refusal or arm.
  - `classifyIdentifierRead` returns `{ kind: "absent-global", name }` for every read the hook answers, not only a
    `typeof` operand, and `absentGlobalTypeof` answers only for `unbound`.
  - The read switch (`from-ast.ts:5253`) calls `lowerUnresolvableRead`.
  - `lowerIdentifierAssignment` (:13239) calls `lowerAbsentGlobalWrite`, with the RHS boxed by
    `boxForDynamicModuleStorage`.
    - `strict` is `cx.functionCodeStrict`, which the producer sets for every unit and closure; undefined there is an
      invariant error.
  - `lowerCompoundAssignment` (:13342) and `lowerIncrementDecrement` (:13517) start from
    `cx.scope.get(id.text) ?? <the home's absentGlobalStorage as a moduleGlobal binding>`.
  - `from-ast.ts` is at 17,337 of its 17,340 ceiling. Target: net ≤ +3 lines; failing that, a dated grant of at most
    +8 lines in this frontmatter.

**Refused by name.** At the producer, before any body is lowered:

- `undeclared global 'N' in a program of several scripts`;
- `write to undeclared global 'N' through a pattern` (a destructuring target, or a `for-in`/`for-of` head).

Unchanged, each at its own site:

- the H2 routes;
- `delete N` (until slice 4);
- `arguments` (Session B);
- names the lib declares (`Math = 1`);
- a value-position update.

**Reuse and the duplicate it removes.**

- Reused:
  - the dynamic carrier and its `undefined` prologue;
  - F1b's startup numbering;
  - `identifierWritesOf`;
  - `codeStrictness` and `closureCodeStrictness`;
  - the source path of `new ReferenceError(m)`;
  - the existing compound/update arithmetic;
  - the TDZ flag's storage path.
- Removed: `absentGlobal` and the typeof-only `unresolvedNameIsAbsent` become one predicate and one hook, and the
  file-wide `isUndeclaredInFile` test leaves that predicate. `isUndeclaredInFile` itself stays: it is still used by
  `ambient-intrinsics.ts` (the global constants), `function-mention.ts` and `prepare-number-conversion.ts`.
- `absentGlobalTypeof`'s build-time fold becomes the unbound arm of `lowerUnresolvableTypeofOperand`, the one
  `typeof` entry (PRV finding 3).
- Follow-up issue, which the dev files: the TDZ throw (`lowerResolvedModuleBindingTdzCheck`) is a second
  ReferenceError emitter. Moving it to this realm error on the Prepared lane only would fix Prepared TDZ; that needs
  its own byte checks, since the ordinary pipeline shares the code.

**Tests:** `tests/issue-7372-absent-globals.test.ts`. Each program runs through `runPreparedScript`, with node's
verdict asserted on the same source; the right check returns and a wrong one throws.

1. `x = 1;` and `function f() { x = 1; } f();`, each against `x !== 1`.
2. A read before the write: `try { x; } catch (e) { ok = e instanceof ReferenceError; } x = 2;`.
3. An unbound read in a closure: `try { (function () { zz; })(); } catch (e) { ok = e.constructor ===
   ReferenceError; }`.
4. `typeof x` is `"undefined"` before `x = "s"` and `"string"` after it.
5. `try { x += (n = 1); } catch (e) {} x = 0;`: a ReferenceError, and `n` stays `0`.
6. `x = 1; x += 2; x++;` gives `4`.
7. Strict writes:
   - `(function () { "use strict"; y = 1; })()` throws ReferenceError;
   - after a sloppy `y = 0`, the same write stores;
   - `y = (n = 1)` runs its RHS first.
8. **Spec, not node:** `function g() { z = 0; } (function () { "use strict"; z = (g(), 1); })();` throws.
9. `function F() { var obj; } typeof obj === "undefined"` (the S13.2.2_A15_T1 shape).
10. `function Error() {} typeof Error === "function"` (the top-level guard).
11. A function called after startup reads a home before any write: `function r() { return x; } try { r(); } catch
    (e) { ok = e instanceof ReferenceError; } x = 1;`, and `r()` answers `1` afterwards.
12. `typeof (x)` is `"undefined"` before `x = 1` and `"number"` after it.

Refusals pinned: two scripts, `[x] = [1]`, `this.x = 1`, `x = 1; (function () { return this; })().x`,
`with ({}) { x = 1; }`, `Math = 1`, `x = 1; delete x;`, `'' + (x++)`, and (until S19's slice 2)
`{ function f() {} } f = 1; f;` and `function g() { { function f() {} } f = 2; return f; } g();`.

**Checks.**

- Mutations, each to be killed by the test named:
  - the read skips the flag (2);
  - the sloppy write leaves the flag (1);
  - `typeof` checks the flag (4);
  - the strict write does not throw (7);
  - the strict check runs after the RHS (8);
  - the compound check runs after the RHS (5);
  - the predicate keeps the file-wide test (9);
  - the predicate drops the top-level guard (10);
  - the home is put in module-init's scope map as a `moduleGlobal` (1);
  - a home read goes through the module-binding read path, so `omitTdzReadCheck` elides it (11);
  - a block function's name is given an absent home (the two block-function refusals).
- Ordinary bytes, base vs head, on the JS environment, standalone and wasi: the `byte-diff-corpus.mts` sample corpus
  and the 506 filtered ES5 files.
- Prepared bytes by R1's corpus method: identical except programs with an unresolvable reference, each one named.
- Yield: o411 through S3's runner, base vs head, every changed row named. Expected **+7**; the ES5 166 are re-measured.
- Gates: typecheck, loc, func (also against `origin/main`), coercion-sites, oracle-ratchet, dead-exports,
  import-cycles; compiler-boundaries classifies the module with owner 7372.

**Code-quality acceptance.**

- One new module of at most ~200 lines, which alone touches the two globals; from-ast holds dispatch calls only.
- One predicate and one hook (`absentGlobal` and `unresolvedNameIsAbsent` are gone).
- No second ReferenceError constructor, and no backend change.
- No export without a user.
- from-ast grows by at most +3 lines, or by a granted +8 that the review accepts.
- An adversarial review with fresh context records its verdict in the PR.

**Agreed with S19 (2026-11-26).**

1. 2a's unbound read: S19 passes its B.3.3 decision as `blockFunctionVar`; a `"skipped"` name then resolves through
   the one collection (a home if written, else unbound), read by `lowerUnresolvableRead` / typed by
   `lowerUnresolvableTypeofOperand`. It replaces the refusal "is read where no binding of it exists" in
   `src/ir/annexb-block-function-values.ts`. (Revised after PRV: no by-name lookup.)
2. **No absent home for an Annex B var.** An `"applied"` name (`annexBWritesScriptBinding`,
   `src/shared/annexb-block-functions.ts`, from #7466/#7499) lives in S19's var home from instantiation; slice 3
   answers nothing for it, so a write and a read of it never land in two homes. Whichever of slice 3 and S19's
   slice 2 lands second wires the input.
3. 2c's `lowerCreateGlobalVarBinding` is §9.1.1.4.17: `if flag == 0 then { value := undefined; flag := 1 }`. It never
   keeps a stale value on the absent path; slice 4's delete also clears the value. An eval-created binding is
   configurable, like an undeclared-assignment property, so one home class serves both.
4. **Homes are keyed by program, not by source.** An A4-compiled eval makes the program two-source (#7363 Slice A).
   The Wasm module stays one, so the globals are shared; which module-init stores first is A4's owner's question,
   raised by S19 once A4's design is fixed. Until then slice 3 refuses a multi-source program by name, as F1b and H
   do.

#### Slice 3 measurements

Main `1a726b3e64`, 2026-11-26; strict Prepared entry, standalone. The tool is
`prepared-census.mts --harness real`, which skips negatives, so its counts are not the S3 runner's. Abort bodies are
attributed by matching the trap frame to `requiredPreparedAbortBodies`.

- **o411: base 63 pass**, which agrees with #7471's figure on this sha. 12 rows stop first at an undeclared name.
  Ten are `<module-init>` compile errors:
  - four reads that must throw: `conditional/S11.12_A2.1_T3`, `division/S11.5.2_A2.1_T3`,
    `strict-does-not-equals/S11.9.5_A2.1_T2`, `unsigned-right-shift/S11.7.3_A2.1_T3`;
  - two updates that must throw: `postfix-increment/S11.3.1_A2.1_T2`, `prefix-decrement/S11.4.5_A2.1_T2`;
  - three sloppy `=`: `equals/S11.9.1_A2.4_T4`, `function/S13.2.1_A6_T1`, `function/S13_A12_T1`;
  - `function/S13.2.2_A15_T1`: a top-level `typeof obj`, where only a function declares a local `obj`, is refused by
    today's file-wide `isUndeclaredInFile` test.

  Two are abort bodies, where a strict function expression writes `test262unresolvable`:
  `directive-prologue/{func-expr,set-accsr-inside-func-expr}-runtime`.
- **o411 ceiling: +7 (an estimate).** Method as in #7471: copies in a `--tree`, with each gap replaced by the
  mechanism's answer (a read that throws `ReferenceError`, a `var` for a sloppy write, `throw` for a strict write,
  `obj` renamed). 9 of the 12 copies pass.
  - Delivered: division, strict-does-not-equals, unsigned-right-shift, S13.2.1_A6_T1, S13.2.2_A15_T1, and both
    directive-prologue rows.
  - Not delivered:
    - postfix/prefix: they pass as copies, but their unreached message holds `(x++)` / `(--x)` in value position,
      which from-ast refuses for every binding (checked on `var y; 'a' + (y++)`);
    - conditional: `'…' + (true ? y : false)` refuses, as `var y; 'a' + (true ? y : false)` does;
    - equals: `dyn.eq (loose)`;
    - S13_A12_T1: `delete`; on #7471's `4e248505af` it then stops at a `+` of a string and a dynamic call result.
- **Wider ES5 (an estimate).** The filter: the 9,174-file `es5-files.mts` list, keeping positive non-module files
  whose body names an identifier declared by nothing in the file, its harness or node's `globalThis`. That leaves
  506 files.
  - On them the census finds **166** that stop first at an undeclared name: 95 reads, 33 `=`, 11 compound, 4 updates
    (compile errors), and 23 abort bodies.
  - The filter misses names some function declares (the S13.2.2_A15_T1 class).
  - Ceiling, with a stand-in home rewrite (`var __present_N, __val_N`; a read is `(__chk_N(), __val_N)`), checked in
    node first, 160 of the 166 valid: **120 pass, ≈ 116** after removing 4 rows with a value-position update.
  - The rest stop at `dyn.eq (loose)` 8, dynamic `<`/`<=`/`>`/`>=` 8, `+` of a string and a dynamic value 7,
    and a third undeclared name or a stand-in artefact ≈ 10.
- **History.** On 2026-11-20 (Suspended Work, `claude/7372-globals-registry`) this design measured 0 through the
  prelude, and the slice was parked for S5's global object (route B). The prelude was the wall; it no longer is.
- **Probes.**
  - Refused today: `x = 1` (`assignment to undeclared identifier`), `x += 1` (`compound assign to undeclared
    identifier`), and `try { zz; } catch (e) {}` (`identifier "zz" is not in scope`).
  - Already working: `typeof zz` gives `"undefined"` (the `absent-global` fold), and a source
    `throw new ReferenceError('m')` is caught with `instanceof ReferenceError`.
  - The TDZ throw (`__new_ReferenceError(null)`) is unusable on this path. Uncaught, it is not materialized
    (`runtime callable __new_ReferenceError needs runtime function materialization`); under a catch that reads `e`,
    it is `throw of a value outside the dynamic carrier's kinds`.

### Slice 4 — `delete` (planned)

`delete x` of a script `var` answers `false` and leaves it (non-configurable); of an undeclared global created by
slice 3 answers `true` and makes it absent again; `delete` of a literal or other non-reference answers `true`
after evaluating it. A member `delete` is a named refusal unless slice O's objects are on the base.

## Slice 1 result (2026-11-19, local, not pushed)

- Proving programs run: `if (true) { var x = 1; } if (x !== 1) throw 1;` returns and `x !== 2` throws;
  `if (false) { var y = 1; } if (y !== undefined) throw 1;` returns.
- `tests/issue-7372-nested-script-var.test.ts`: 18 programs, each run twice through the strict Prepared entry with
  node's verdict asserted on the same source (right answer returns, wrong throws); 4 named refusals.
- `tests/issue-7354-h2-hoisted-var-declaration.test.ts` pins updated: the script-loop repeated `var` now refuses as
  `not-direct`; the script-loop var read by a function now runs (`r === 5`, node agrees).
- Mutation check: 5 mutants (producer back to top-level only; plan drops one nested binding; provenance ignores
  nested vars; no typed `for` head; `for` head proof ends at the loop's end), all killed.
- Ordinary-pipeline bytes: 100 test262 files with nested `var`s × default and standalone, against an `origin/main`
  export: identical (176 binaries, 24 identical compile errors).
- Gates: typecheck, loc, func (also against `origin/main`), coercion-sites, oracle-ratchet, dead-exports.
- Census re-run on S9's 245 files (S9's `prepared-census.mts --harness stand-in`, this tree): **0 files move**;
  all 245 still stop at `module-init unit contains a nested var declaration`. That label is not what slice 1
  built: it is raised for a `var` list the module-init does NOT model. Classified by construct: 188 a top-level
  `for (var k in …)` head, 47 a `var` in a `with` body, 8 both, 1 a `for-of` head, 1 a catch-parameter
  redeclaration. Slice 1 fixed the modelled lists (block/branch/loop/`try`/`switch` bodies), which the census
  counted under no label of its own.
- Consequence for the label: `for-in` itself has no Prepared lowering (`function f(){ for (var k in [1,2]) {} }`
  → `dynamic for-in runtime is unavailable`), and 25 of the first 40 files iterate an object (`newObj`), so the
  188 need slice O's objects plus a for-in enumeration runtime, not a script-scope change. Modelling the head
  `var` as a script global is a few lines once that exists. `with` (55) stays deferred.
- The other three lists (S9 @ `54d5a075`) carry one first-gap detail each: block FunctionDeclaration 69
  (`unsupported body statement FunctionDeclaration`), undeclared global 53 (42 `assignment to undeclared
  identifier`, 11 compound assignment), `delete` 37 (`delete has no IR lowering`). Slices 2–4 not started.

## Slice 1b result (2026-11-19, local, not pushed)

Built (no new module; one shared predicate replaces the home's own declaration count):

- `scriptVarDeclarations` (`src/ir/module-init-vars.ts`): every declarator of a script `var` name in source
  order, when each is a module-init binding's own; `undefined` when any declaration is something else (a
  function, a lexical, an ambient, a JS property declaration such as `Object.defineProperty(o, …)`). The first is
  the canonical identity, as the resolver's `uniqueTopLevelVariableDeclaration` already picks it.
- The home (`irOwnedScriptVarHome`) asks it instead of counting declarations itself, and answers only for the
  first declarator.
- The startup plan (`module-init-plan.ts`, two extracted helpers `redeclaredScriptVarOrdinal` and
  `nestedVarBindings`, which also keep `buildIrModuleInitPlan` under its function budget) records no binding for a
  later declarator; its statement's evaluation names the first declarator's global.
- The producer maps every declarator to the first one's global entry.

Measured:

- `tests/issue-7372-nested-script-var.test.ts`: +9 programs for repeated `var`s (both run, node agrees), 30 tests.
  The test helper tolerates the checker's `Subsequent variable declarations must have the same type` on legal JS
  (`var x = 1; var x;`), which does not stop the compile.
- Pins moved into this file: H's "declared twice", VG's "declared twice", H2's two script repeats.
- S9's repeated-var list, stand-in census on this tree: all **195** real repeated-`var` files get past the gap
  (S9 reproduced it on `2c3a877c`). An earlier figure here, 243/255, was 255 files minus the 12 still at
  `not-direct`; S9's AST check found 60 of the 255 rows to be false hits. The 12 dropped are not repeated vars.
  Earlier wording for the record: 12 still stopped
  at `not-direct`. None of the 12 is a repeated `var`: 8 are `Object.defineProperty(props, …)` (a JS property
  declaration, kept as slice O's named gap) and 4 are `this.x = 1` (the global object as `this`, slice C).
  The other 243 move on to: `unknown class` (Test262Error, slice C) 107, an object/array literal initializer with
  no carrier (slice O) 58, closures (Fa) 15, a direct call with no AST-site plan 10, RegExp crash (#7364) 8,
  postfix/prefix update 14, and smaller ones.
- Mutation check: 5 mutants. Killed: home answering a single declaration only; the plan keeping a nested or a
  top-level redeclaration's binding; the predicate ignoring a non-var declaration (killed by H's
  `Object.defineProperty` refusal). Survivor, with its reason: the redeclarator's evaluation naming its own
  ordinal instead of the first one's. Evaluation binding ids are read only by the source-map validator, and the
  Prepared entry refuses source maps today.
- Ordinary-pipeline bytes: 160 files (the 100 above + 60 of S9's repeated-var list) × default and standalone,
  against an `origin/main` export: identical (296 binaries, 24 identical compile errors).
- Prepared tests (#7188, every #7354 file, prepared-entry/-runtime, this issue): 733/733. Vitest exits 1 on one
  worker RPC timeout under CPU load, not a test failure.
- Gates: typecheck, loc, func (also against `origin/main`), coercion-sites, oracle-ratchet, dead-exports.

## Review round 1 (RV7321b, head `2c3a877c`): BLOCKER, addressed

- **Must-fix 1, ES-module regression.** An ES module with a top-level `for (var …)` head refused (`not-direct`)
  where the base ran it: the producer walked `moduleInitBindings`, which lists a `for` head in every source,
  while the resolver makes it a global only in a script. Fix: ONE rule, `isModuleInitGlobalDeclaration`
  (`module-init-vars.ts`), which the resolver's `isModuleBindingDeclaration`, the startup plan's
  `nestedVarBindings` and the Prepared producer all ask; no per-caller `isExternalModule`. Measured base vs head
  through the strict entry (`test.mjs`): the reviewer's three programs return again, and a nested `if` var and a
  repeated `var` in a module refuse as on the base. An ES-module nested `var` pattern, which crashed the base with
  an invariant (`module-init var leaf 'a' has no slot its value fits`), now refuses by name. Pinned: 3 ES-module
  run programs and the pattern refusal.
- **Should-fix 2, duplicate redeclaration rule.** `scriptVarDeclarations` is gone. The resolver exports
  `moduleBindingDeclarations` (its own declarators in source order, which `uniqueTopLevelVariableDeclaration` now
  reads); the home and the plan ask it. The home keeps only its own stricter rule, that a JS property declaration
  (`Object.defineProperty(o, …)`) leaves the binding without a home.
- **Nits.** The producer keys entries by `globalBindingId` in a `Map` (no linear `find`); the plan computes the
  redeclared ordinals once per source (`redeclaredScriptVarOrdinals`, one map lookup per declarator); `const list`
  moved below the early return.
- Mutation check of the fix: the producer without the filter, and the plan without it, are both killed by the
  ES-module pins. A third mutant (the plan's "no lexical among the declarators" check) survived because
  `let x; var x;` is an early error the entry refuses first, so the check was removed as unreachable.
- Ordinary-pipeline bytes, base vs head: 220 files (the 160 above + 60 ES modules flagged `module` that contain
  `var`, compiled as `test.mjs`) × default and standalone: identical (440 compiles).
