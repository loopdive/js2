---
id: 6967
title: "typeof fold: `typeof NS.member == \"undefined\"` is constant-folded to false for a JS expando (assignment-declared) member, so the guarded namespace init `if (typeof Flog.RT == \"undefined\") Flog.RT = {}` never runs (Octane raytrace)"
status: done
completed: 2026-10-11
sprint: current
created: 2026-10-11
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: typeof, object-literals
goal: standalone-gap
related: [874, 4529, 4204, 2623, 4250, 6951]
loc-budget-allow:
  # 2026-10-11 (#6967): the expando-member fold guard sits next to its sibling unsound-fold guards (typeofFoldUnsoundForJsParam); one predicate, +40 lines
  - src/codegen/typeof-delete.ts
func-budget-allow:
  # 2026-10-11 (#6967): one guard line each, mirroring the existing per-guard lines in both folds
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/codegen/typeof-delete.ts::compileTypeofComparison
---

# `typeof <expando member>` folds from the checker's EVENTUAL type

Found by the Octane standalone triage (Session D, 2026-10-11). raytrace throws an opaque wasm
exception from top-level code; the first cause is the Prototype-style namespace guard
`if (typeof Flog.RT == "undefined") Flog.RT = {};` (`Flog.RT.Color.prototype` then reads
`Cannot access property on null or undefined`).

## Minimized (`.tmp/rta4.js`, node `ok:5:0`, standalone `write: Cannot access property on null or undefined at 7:17`)

```js
var Flog = {};
if (typeof Flog.RT == "undefined") Flog.RT = {};
var err = "none";
try {
  Flog.RT.Color = 5;
  Flog.RT.other = { red: 0 };
  err = "ok:" + Flog.RT.Color + ":" + Flog.RT.other.red;
} catch (e) { err = "write: " + e.message; }
export function main() { return err; }
```

WAT (`.tmp/rta4.js.wat` `$__module_init`): after `call $__new_plain_object → global.set $Flog`
the guard is literally `i32.const 0 (if …)` — the comparison was folded to FALSE, so `Flog.RT = {}`
never executes; the later `Flog.RT.Color = 5` set is a silent no-op on null and the read throws.

Controls: `.tmp/rta7.js` (same guard, but NO later member writes to `Flog.RT`) works, because
`Flog.RT`'s checker type is the empty `{}` and `isEmptyAnonymousObjectType` already declines the
fold. `.tmp/rta6.js` (`Flog.RT = Flog.RT || {}`) works. `.tmp/rta12/13` (`typeof Flog.RT` read
BEFORE the write, no `if`) correctly answer "undefined" — the runtime path is right; only the fold
is wrong.

## Root cause

TS models `Flog.RT = {}` in a JS file as an **expando** property declaration: the symbol of `RT`
has `SymbolFlags.Assignment | Property` and its only declaration is the `PropertyAccessExpression`
of the first assignment (checker probe `.tmp/sym.mjs`: `Flog.RT | type: { Color: number; other:
{ red: number } } | sym flags 67108868 | decls: PropertyAccessExpression`). The declared type is the
EVENTUAL shape, which says nothing about whether the write has executed at the `typeof` site.

`src/codegen/typeof-delete.ts`:
- `compileTypeofComparison` (~2318-2430): `staticTypeofForType(ctx, tsType)` answers `"object"`
  for the non-empty expando type; none of the existing unsound-fold guards fire — they are
  identifier-only (#4204 `moduleGlobalIsDynamicButStaticallyPrimitive`, #2623
  `sourceHasIdentifierAssignment`), or receiver-specific (#2992 `chainRootIsGrowable`,
  `sidecarDefinedPropertyKeys`, #4250 `typeofFoldContradictedByFieldVerdict` on the plain arm).
- `compileTypeofExpression` (~2064-2080) has the same hole for the plain `typeof Flog.RT`.

## Implementation Plan

**File: `src/codegen/typeof-delete.ts`**

1. Add a predicate `typeofOperandIsAssignmentDeclaredMember(ctx, operand): boolean` next to
   `typeofFoldUnsoundForJsParam` (~1666): unwrap parens/casts; require
   `ts.isPropertyAccessExpression(op)` (or `ElementAccessExpression` with a string-literal key);
   take `ctx.oracle.declarationsOf(op.name)` (oracle, NOT `checker.getSymbolAtLocation` — the
   oracle ratchet); answer true when the list is non-empty and NO declaration is a REAL member
   declaration (`PropertyAssignment`, `ShorthandPropertyAssignment`, `PropertyDeclaration`,
   `PropertySignature`, `MethodDeclaration`/`MethodSignature`, accessor, `Parameter`,
   `VariableDeclaration`, `FunctionDeclaration`, `ClassDeclaration`, `EnumMember`). Do NOT
   require "every declaration is a PropertyAccessExpression": TS also records one container
   `Identifier` per nested `NS.m.<x> = …` write as a declaration of `m` (measured on
   `.tmp/rta22.js`: `Flog.RT decls=PropertyAccessExpression,Identifier,Identifier`), and the
   stricter form left `.tmp/rta2/rta3/rta5/rta16/rta17/rta22` folded. If the oracle has no
   declarations for the member, fall back to `false` (keep folding).
   The simulated predicate (`typeofOperandIsAssignmentDeclaredMember`) is in
   `/home/user/js2/.claude/worktrees/agent-af047ca9deb401f6e/src/codegen/typeof-delete.ts`
   (uncommitted, diff vs `.tmp/base/typeof-delete.ts`; drop the `JS2WASM_TRIAGE_LOG` print).
2. In `compileTypeofComparison`, right after `staticTypeof` is computed (~2334) add
   `if (staticTypeof !== null && typeofOperandIsAssignmentDeclaredMember(ctx, guardOperand))
   staticTypeof = null;` — mirrors the (#2992 S6) guard shape at ~2405. Not standalone-gated: the
   same fold is wrong in every lane (a host `Flog` object has no `RT` until the write runs).
3. In `compileTypeofExpression` (~2065), add the same predicate to the `forceRuntimeTypeof`
   computation before the `staticTypeofForType` fold at 2069.
4. The runtime path already answers correctly (`.tmp/rta12.js`), so no runtime changes.

### Edge cases
- `typeof F.staticProp` where `F` is a function declaration with `F.staticProp = 1` (assignment-
  declared too) → now dynamic; correct, slightly slower.
- Object-literal members (`var o = { RT: {} }; typeof o.RT`) have a `PropertyAssignment`
  declaration → still fold. Class fields / interface members → still fold.
- A member with BOTH an expando declaration and a literal declaration (`var o = {a:1}; o.a = 2`)
  → `declarationsOf` contains a `PropertyAssignment` → still folds (write-before-read is
  guaranteed by the literal).
- gc/host lane: byte change only on files containing `typeof <expando member>`; expect zero
  test262 movement (test262 rarely uses the idiom, but `language/expressions/typeof` should be
  spot-checked).

### Acceptance
- `tests/issue-<id>.test.ts` standalone (+gc) vs node: `.tmp/rta4.js` → `ok:5:0`; `.tmp/rta2.js`
  / `.tmp/rta3.js` / `.tmp/rta5.js` (guarded `Flog.RT` + later `.prototype`/`.prototype.foo`
  writes) → node-identical; control `.tmp/rta7.js` unchanged.
- raytrace: `node --import tsx .tmp/octane-sa.mjs raytrace --script --no-eval` passes the guard;
  the NEXT failure is the companion issue `.tmp/#6968`
  (`this.initialize.apply` undefined — `.tmp/rta1.js`). MEASURED with both simulated fixes:
  raytrace runs to completion (`standalone run -> 1`, teardown ok). Then
  `pnpm run -s benchmark:octane -- --only raytrace --lanes node,standalone --timeout 600`
  (`.tmp/harness-raytrace.log`).
- Regression guard: `tests/issue-4529*`, `issue-4204*`, `issue-2623*` typeof-fold pins and
  `language/expressions/typeof` in the standalone test262 lane.
- Size: **S**.

## Implementation Notes (2026-10-11)

- `typeofOperandIsAssignmentDeclaredMember` (`src/codegen/typeof-delete.ts`) answers true when
  the member (property access, or element access with a string-literal key) has oracle
  declarations and EVERY one is an expando kind — `PropertyAccessExpression`,
  `ElementAccessExpression`, `BinaryExpression`, `CallExpression` (`Object.defineProperty`
  in JS) or the container `Identifier` TS records per nested `NS.m.<x> = …` write.
  This is the plan's predicate phrased as an allow-list of expando kinds instead of a deny-list
  of real member kinds: identical on every measured shape (rta2/3/4/5/16/17/22), but an
  unanticipated declaration kind keeps the existing fold instead of silently going dynamic.
- Wired into `compileTypeofComparison` (after the `runtimeEvalMayRebindIdentifier` guard) and
  `compileTypeofExpression` (`forceRuntimeTypeof`). Lane-agnostic, as planned.
- Tests: `tests/issue-6967-typeof-expando-member-fold.test.ts` (standalone vs node values,
  4 failing on base / 6 passing on head, 2 negative controls).
- Not fixed here (pre-existing, base and head): inside a FUNCTION, `typeof NS.m` for a member
  that is absent at call time answers `"object"` on standalone (runtime path; the
  `__extern_get` result is treated as JS null). `NS.m === undefined` is correct there, and
  top-level reads are correct. Not on raytrace's path.
