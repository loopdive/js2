---
id: 4259
title: "ES2015 class accessor writeback: retain exact class-root writes and IR-own accessor bodies (72 files per lane)"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
model: gpt-5.6-sol
task_type: bugfix
area: ir, classes
language_feature: class-accessors
es_edition: 2015
goal: full-conformance
parent: 3522
related: [848, 3000, 3144, 3520, 3521, 3522, 3783, 4260]
assignee: "ttraenkler/codex-es6-accessor-ir"
test262_fail: 72
test262_category: language/expressions/class, language/statements/class
origin: "2026-08-09 frozen exact-ES2015 two-lane cohort: all 72 positive accessor-name files per lane drop the top-level class-root setter write or lack bounded top-level declaration IR ownership; 12 computed-error files are unchanged failing controls"
loc-budget-allow:
  - src/codegen/any-helpers.ts
  - src/codegen/class-bodies.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/codegen/program-abi-session.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/statements/variables.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/module-bindings.ts
  - src/ir/nodes.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/select.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/index.ts::buildIrClassShapes
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::planIrOverlay
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/prepared-component-dependencies.ts::collectFunctionEvidence
  - src/ir/select-identity.ts::planIrCompilationByIdentity
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::isPhase1Expr
  - src/ir/select.ts::scanExpr
  - src/ir/select.ts::whyNotIrClaimable
---

# #4259 — Retain exact class-root accessor writes and IR-own accessor bodies

## Impact and measurement provenance

The exact ES2015 edition contains **84 files in each lane** under these four
directories:

- `language/expressions/class/accessor-name-inst` — 21;
- `language/expressions/class/accessor-name-static` — 21;
- `language/statements/class/accessor-name-inst` — 21; and
- `language/statements/class/accessor-name-static` — 21.

The frozen cohort is the sorted 84-path list at
`.tmp/es6-audit/accessor-84-files.txt`, whose SHA-256 is
`395db89bd1ac04a43c17be2d66ad37cb9657f61e1e1af204c7f7d79a7ae317a8`.
On fresh `main` commit `fba37d2df54a742b853cff3b69fc66adc752903a`, all 84 fail in
both the GC/host and standalone lanes. The targeted root cause is exactly **72
files per lane** — 18 in each directory, or **144 scored lane outcomes**. In
every positive file, the setter assignment should update its enclosing binding,
but that update is not observable:

```js
var stringSet;
var C = class {
  get "default"() { return "get string"; }
  set "default"(param) { stringSet = param; }
};
C["default"] = "set string";
assert.sameValue(stringSet, "set string"); // receives undefined today
```

The exact baseline error is
`Expected SameValue(«undefined», «"set string"»)` in both lanes. The other 12
files are **unchanged failing controls**, not passing controls: four each cover
an expected Test262Error, TypeError, or ReferenceError from the getter. They
remain outside this writeback attribution and must not be credited as fixed or
change error family.

The source census uses
`website/public/benchmarks/results/test262-file-editions.json`'s exact
`ES2015` bucket (edition index 4), not an untagged or cumulative `<= ES2015`
population. The authentic runner assembles the Test262 harness prefix followed
by the **unchanged source file**; it does not wrap the test in a synthetic
`test()` function. The harness-flip probe's own must-pass and must-fail
instrument controls passed, so the 84 result rows are not a silent-empty or
harness-swap artifact.

Four representative files were also rerun alone through the authentic assembled
Test262 harness, in both lanes, and reproduced the same baseline failure:

- `language/expressions/class/accessor-name-inst/computed.js`;
- `language/expressions/class/accessor-name-static/literal-string-default.js`;
- `language/statements/class/accessor-name-inst/literal-numeric-hex.js`; and
- `language/statements/class/accessor-name-static/literal-string-unicode-escape.js`.

## Root cause

#848 implemented the original computed-name/static/instance accessor storage
surface through the transitional direct class machinery, then recorded this
remainder as a generic closure-capture limitation. The authentic trace narrows
the defect to two concrete breaks.

First, class-expression accessor bodies in a representative failing file were
already exact prepared outcomes (`legacyBodyEmitted=false`,
`irBodyEmitted=true`). The setter still never ran because top-level
`C.prototype[key] = value` and `C[key] = value` statements disappeared from
`__module_init`. Module-init collection retained property writes only when the
root was a module global, `globalThis`, or a known sloppy global. Class bindings
are intentionally not module globals, so the allow-list silently dropped the
class-root write before dispatch could invoke the prepared setter.

Second, the statement-class half of the cohort did not yet have the same
bounded prepared ownership. Its top-level class declaration accessors were
rejected by the narrower IR shape and selection gates. Merely retaining their
write statements would therefore leave those 36 positive files Unsupported.

This is not caused by a synthetic Test262 wrapper and does not require a new
direct-backend capture mechanism. The existing IR symbolic global write and
Program-ABI binding resolution already represent `stringSet = param`. The fix
must retain only the exact safe class-root statement and give the corresponding
accessor body exact, compile-once IR ownership.

## Implemented shape

1. **Prove the accessor class atomically.** The shared
   `src/ir/class-accessor-safety.ts` helper accepts only accessor-only classes
   with bodies, no heritage/decorators/private names, one plain implicit-`any`
   setter parameter, no nested function/class, and no `this`/`super`. Its
   literal-only evaluator resolves identifier/string/numeric names and bounded
   pure computed literals without following mutable bindings. Duplicate
   physical getter/setter slots or instance/static key collisions demote the
   whole class before selection.
2. **Extend exact IR ownership, not direct accessor bodies.** The identity,
   selection, class-shape, preparation, and module-binding paths admit the
   proven accessor family for nested classes and bounded top-level class
   declarations. Static/instance placement is explicit; an untyped setter
   parameter uses the dynamic IR carrier. Top-level shapes are provisional only
   during selection and rebuilt from selected UnitIds for lowering. The exact
   selected setter ABI is staged atomically before Program-ABI sealing; rejected
   classes never perturb their legacy callable, while a typed preparation
   withdrawal preserves one allocator/type contract for the direct body. The
   terminal body contract remains `legacyBodyEmitted=false,
   irBodyEmitted=true` for every claimed accessor.
3. **Retain only the exact top-level setter write.** The module-init collector
   in `src/codegen/declarations.ts` recognizes only a plain `=` whose target is
   exactly `C[literalKey]` or `C.prototype[literalKey]`. It resolves `C` to its
   source declaration through the oracle, requires a direct top-level class
   declaration or direct variable-initialized class expression, verifies the
   exact setter key and static/instance placement against the AST and registered
   callable, and rejects collisions. A whole-source binding-use guard permits
   only the target plus exact read-only observations through a literal-only,
   side-effect-free getter. Reassignment, aliasing, descriptor mutation, closure
   references, and other escapes decline the hardwired dispatch. This
   deliberately does not turn arbitrary class-root property writes into
   module-init statements.
4. **Preserve computed-name effects.** Bounded top-level declarations with a
   computed accessor name are collected for module initialization, and an
   already-collected non-deferred class still emits its prepared computed-name
   effects. Thus `_ = "str" + "ing"` remains a runtime source-order effect even
   though the exact descriptor key is proven independently.
5. **Keep the transitional boundary explicit.** Class allocation, descriptor
   installation, property dispatch, and the retained module-init assignment may
   still use transitional codegen. The getter/setter **source bodies** and outer
   binding write are prepared IR/Program-ABI work; there is no direct-only
   capture patch or Test262 filename special case.

Primary source seams are:

- `src/ir/class-accessor-safety.ts`, `src/ir/identity.ts`,
  `src/ir/select-identity.ts`, and `src/ir/nodes.ts`;
- `src/codegen/ir-class-shapes.ts`, `src/codegen/index.ts`, and
  `src/codegen/ir-prepared-free-functions.ts`;
- `src/ir/integration.ts` and `src/ir/module-bindings.ts`;
- `src/codegen/class-bodies.ts` and `src/codegen/declarations.ts`; and
- `src/codegen/statements/nested-declarations.ts` and
  `src/codegen/statements/variables.ts`.

This remains a focused child of #3522's compile-once class/closure ownership
programme, not a new direct-codegen accessor implementation.

## Final evidence

The final code candidate measured below is
`5bbfbb66c829d96195f2bc8fc5ff4c94bb7bc87e`, rebased directly on fresh `main`
`fba37d2df54a742b853cff3b69fc66adc752903a`. The subsequent issue-status
amend changes Markdown only.

| Lane | Fresh `main` `fba37d2d` | Candidate `5bbfbb66` | Delta |
| --- | ---: | ---: | ---: |
| GC/host | 0 pass / 84 fail | 72 pass / 12 fail | +72 / -0 |
| standalone | 0 pass / 84 fail | 72 pass / 12 fail | +72 / -0 |

Both before/after runs used the unchanged frozen 84-file list and passed the
harness instrument's must-pass/must-fail direction controls. All 72 positive
files flipped fail-to-pass in each lane; none regressed. The 12 computed-error
controls remained byte-for-byte identical in status and failure detail: four
each still report the missing expected Test262Error, TypeError, or
ReferenceError behavior.

The exact ownership audit compiled every positive file through both the
authentic primary and strict harness variants. Per lane it observed **72 files,
144 variants, and 288 accessor terminals**. Every targeted terminal was
`kind=emitted`, `legacyBodyEmitted=false`, `irBodyEmitted=true`, and carried an
exact `prepared-component:` identity; targeted post-claim errors were zero. The
authentic harness independently records one existing `$DONOTEVALUATE` helper
parity demotion per variant (144 per lane), outside the test-body accessor
UnitIds and unchanged by this issue.

Final verification also passed:

- the three focused #4259 files, **29/29** across GC and standalone;
- #3522 constructor/method/accessor compile-once regression coverage together
  with #4259, **58/58**;
- TypeScript typecheck, Prettier, `git diff --check`, issue integrity, LOC and
  function budgets, the oracle ratchet, and `check:ir-fallbacks`; and
- the latest-main overlap regressions for late funcref declaration, declared
  global caching, and standalone wrapper prototypes.

## Acceptance criteria

- [x] The complete unchanged 84-file accessor-name set is measured before and
      after in **both lanes** through the authentic per-file Test262 harness,
      with both commit SHAs, list hash, and the harness instrument's passing
      must-pass/must-fail controls recorded.
- [x] All **72/72 targeted files pass in GC/host** and all **72/72 pass in
      standalone**. The 12 getter-throw controls do not regress; any remaining
      failure is reported per file rather than credited from a signature.
- [x] Focused class declaration/expression × static/instance ×
      literal/numeric/computed coverage records exact terminal ownership for
      every targeted accessor body: `legacy=0, IR=1`, zero post-claim errors,
      and no flat-name aliasing.
- [x] Computed-key evaluation order and side effects match JavaScript, including
      the `_ = "str" + "ing"` source shape; mutable-key, placement-mismatch,
      collision, and partially claimable classes demote atomically before IR
      ownership or module-init retention.
- [x] The setter writes the enclosing binding through Program-ABI-resolved IR
      storage, preserves TDZ `ReferenceError` identity, and cannot pair one
      declaration's value global with another declaration's TDZ flag; no
      direct-backend-only capture patch or per-Test262 special case is added.
- [x] Injected dependency/seal failure records typed Unsupported and executes
      only the direct body (`legacy=1, IR=0`), with no post-direct IR retry.
- [x] Targeted IR/class suites, typecheck, issue integrity, formatting, and
      `pnpm run check:ir-fallbacks` pass.

## Scope boundaries

- Getter bodies whose purpose is to throw Test262Error/TypeError/ReferenceError
  are the 12 non-regression controls, not part of the 72-file score claim.
- Dynamic computed keys that cannot be resolved exactly, and static accessors
  that use `this` or `super`, remain typed Unsupported in this slice.
- Provider/import plans that leak when a TDZ-bearing prepared component aborts
  before sealing are recorded separately in #4260. The injected failure here
  uses a `var` writeback to isolate exact body demotion; the successful TDZ
  control still proves the real `ReferenceError` provider path.
- Class allocation, descriptor installation, property dispatch, and exact
  module-init statement retention may remain transitional support. This issue
  owns accessor source **body** preparation/emission, Program-ABI binding
  writeback, and exact compile-once routing; broader class-path deletion remains
  #3522.
