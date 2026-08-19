---
id: 4272
title: "codegen: bind class method overloads to the body-bearing implementation"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
priority: high
horizon: s
feasibility: low
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: method-overloads
goal: dogfood
related: [3520, 4267, 4268, 4270]
assignee: "ttraenkler/typescript-upstream-source-build"
---

# codegen: bind class method overloads to the body-bearing implementation

## Problem

The class-body pipeline registers and marks the first method declaration for a
class/name pair before checking whether that declaration has a body. TypeScript
method overload signatures precede their one body-bearing implementation, so a
type-only signature can reserve the Wasm function slot and suppress the actual
implementation. Program ABI inventory correctly owns only executable methods,
and compilation aborts:

```text
class callable ScriptInfo_lineOffsetToPosition has no consistent exact
class-instance-method inventory owner
```

Method overload signatures describe calls; they are not separate runtime
methods. ABI registration and body emission must select the same exact
body-bearing declaration.

## TypeScript package impact

With #4267, #4268, and #4270 applied, the exact 280-file TypeScript v5.9.3
source graph passes the `Version` constructor overloads and reaches
`src/server/scriptInfo.ts::ScriptInfo.lineOffsetToPosition`. Two overload
signatures precede its implementation, then compilation fails during class
callable registration after 11.62 seconds (10.38 seconds in codegen, 1.33
seconds collecting declarations, 1040.6 MB peak heap).

## Acceptance criteria

- [x] An instance method with overload signatures compiles, validates, and an
      exported caller returns `42` from the body-bearing method in Wasm.
- [x] Exactly one executable class-method IR outcome is inventoried.
- [x] ABI registration and method body emission select the same exact
      implementation without erasing abstract-method inheritance metadata.
- [x] Existing class-callable Program ABI regressions remain green.
- [x] The exact TypeScript v5.9.3 source probe advances beyond
      `ScriptInfo_lineOffsetToPosition` and records the next honest frontier
      without claiming a binary prematurely.

## Scope

Fix direct class-method selection generically. Do not special-case
`ScriptInfo`, TypeScript, or the method's parameter types, and do not weaken the
Program ABI ownership invariant.

## Result

Class method registration and body emission now skip declarations without a
body. Type-only overload signatures can no longer reserve a Wasm slot or mark
the name compiled before the implementation. `ownMethodNames` is still updated
before that filter, so abstract declarations and overload names preserve the
existing inherited-alias suppression semantics.

The focused regression reproduces the former `Calculator_compute` ownership
failure, then instantiates the overloaded class in Wasm, returns `42`, and
observes one method IR outcome. The adjacent constructor and class callable ABI
suites and the repository typecheck pass.

The unchanged 280-file TypeScript v5.9.3 source probe passes
`ScriptInfo_lineOffsetToPosition` and continues into body emission instead of
aborting during declaration collection. It reaches the 900-second cap while
actively compiling `src/compiler/checker.ts`; source-file order was verified
directly (`ts.moduleSpecifiers.ts` is followed by `checker.ts`). The last
completed unit was `src/compiler/_namespaces/ts.moduleSpecifiers.ts`.

At a near-terminal 13:46 snapshot, the Node process was using 82.2% CPU,
11:22.67 accumulated CPU time, and 717472 KiB RSS. The streaming profile's
largest observed heap sample was 1994.0 MB after
`src/compiler/factory/utilitiesPublic.ts`; later garbage collection reduced the
working set. The probe exits 124 from the explicit timeout, emits no binary,
and reports no new semantic diagnostic. This is a throughput frontier, not a
hang or a correctness claim.
