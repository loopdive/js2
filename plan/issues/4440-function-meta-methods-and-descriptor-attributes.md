---
id: 4440
title: "Function meta R1/R-attr slice — method name/length + own-property descriptor attributes (writable/enumerable/configurable)"
status: in-progress
sprint: current
assignee: ttraenkler/claude-es5-standalone
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function-properties
goal: standalone-gap
related: [4437, 4436, 2896]
origin: "2026-08-15 ES5-standalone campaign wave 8 — #4437's R1 residual (class/object METHODS decline the meta) plus the descriptor-attribute family ('Expected obj[length] NOT to be writable' x4, Function/length 6 ES<=5 non-pass)."
loc-budget-allow:
  # All new LOGIC is in the new module `function-instance-meta-methods.ts`
  # (157 lines). What lands in these four is wiring and its rationale:
  #  - eval-inline.ts       +50: ONE 6-line predicate plus the measurement table
  #                              that justifies why a `null` body argument is a
  #                              constant, not a dynamic body (the whole reason
  #                              the six Function/length files were unreachable).
  #  - context/types.ts     +11: one optional Map field + its field doc. A
  #                              per-compile side table has to live on the
  #                              context; there is no other home.
  #  - literals.ts           +9: one extra argument threaded to
  #                              `emitObjectMethodAsClosure`, reformatted by
  #                              prettier onto its own lines.
  #  - class-bodies.ts       +6: three `recordFnMetaMemberDeclaration` calls at
  #                              the three registration sites (method / getter /
  #                              setter) plus the import. The declaration is only
  #                              in scope here.
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/context/types.ts
  - src/codegen/literals.ts
  - src/codegen/class-bodies.ts
func-budget-allow:
  # The same three wiring edits, seen per-function. Each is a call/argument at
  # the ONE site where the needed value is in scope; none adds a branch.
  #  - compileObjectLiteralForStruct +9: the extra `emitObjectMethodAsClosure`
  #    argument, wrapped by prettier.
  #  - fillMemberGetDispatch        +7: the `$fnmeta` operand + derived type in
  #    the dynamic-read lazy init, so it cannot disagree with the typed read.
  #  - collectClassDeclaration      +5: three one-line registry writes next to
  #    the three existing `ctx.funcMap.set` calls.
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/member-get-dispatch.ts::fillMemberGetDispatch
  - src/codegen/class-bodies.ts::collectClassDeclaration
---

# #4440 — function meta for METHODS + own-property descriptor attributes

## Problem

Two adjacent residuals #4437 left with owners-unassigned:

1. **R1 — methods decline the meta.** `ensureMethodClosureSingleton` receives
   a name + funcIdx, not a declaration node, so class/object-literal methods
   have no `$fnmeta` and `name`/`length` reflection declines. All 8 remaining
   `*length-dflt.js` files sit here. Method `name` needs the `get `/`set `
   prefix rule and symbol-key handling (§10.2.9 SetFunctionName).
2. **Descriptor attributes.** `length`/`name` are now own DATA properties on
   plain functions (#4437), but their gOPD attributes must be
   `{ writable:false, enumerable:false, configurable:true }` per ES2015+/
   §15.1.5 ES5 (non-configurable in ES5 — test262 tests the MODERN attributes;
   follow what the failing files assert). Fresh-baseline signatures:
   `Expected obj[length] NOT to be writable, but was.` ×4;
   `built-ins/Function/length` 6 non-pass (S15.3.5.1_A2_T*/A3_T* —
   DontDelete/ReadOnly probes via assignment and delete).

## Implementation Plan

1. Base on #4437's modules: `function-instance-meta.ts` (write side),
   `function-instance-meta-arms.ts` (read side), `function-instance-props.ts`.
   Read #4437's issue file first — the nominal-struct discriminator rationale
   and the `$arity` no-repoint constraint both bind here.
2. R1: thread the declaration (or at minimum `{name, prefix-length}`) into
   `ensureMethodClosureSingleton`'s callers so methods intern a meta too.
   Where the declaration is genuinely unavailable, keep the decline.
3. Attributes: the reflection arms (`hasOwnProperty`/gOPD/`__extern_get`)
   answer for `length`/`name`; extend the gOPD synthesis to report the spec
   attribute triple, and make WRITES respect writable:false (sloppy silent
   no-op, strict TypeError — check what `__extern_set_strict` needs) and
   `delete` respect configurable per the asserted edition semantics.
4. Verify: the 8 `*length-dflt.js` files; `built-ins/Function/length/*`
   (6 non-pass; S15.3.5.1_A2_T1-3, A3_T1-3); the `Expected obj[length] NOT
   to be writable` ×4; #4437's 19-test pin + #4436's 23-test pin stay green;
   140-file closure-heavy control from #4437's methodology.

## Acceptance criteria

- ≥6 of the named files flip; zero regressions in the control set; gc/host
  byte-identical; non-flips root-caused here with owners.
