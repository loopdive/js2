---
id: 7267
title: "IR: ambient global object statics (`Object`, `String`, `Date`, `JSON`, `Reflect`, `Function`, `Array`) refused as `expr-ident-not-in-scope` — slice 1: `JSON.parse(<string>)`"
status: done
completed: 2026-11-06
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7253, 7264, 7106, 7118, 7123, 7127, 7189]
assignee: "ttraenkler/c-lead"
loc-budget-allow:
  # 2026-11-06 (#7267): the shape, admission and lowering live in
  # src/ir/ambient-global-function-call.ts (the #7253 module, extended by one
  # table row). What remains in the god-files is wiring that has no other home:
  # select.ts +15 — one shared selector adapter (replacing #7253's argument
  # list) and the three sibling arms beside `JSON.stringify`'s (Phase-1 call,
  # dynamic-shape, dynamic scan); integration.ts +11 — the resolver row, and the finalize pre-registration beside
  # `dyn.json_stringify`'s; from-ast.ts +12 — the resolver capability union,
  # the admission adapter, and the same arm on the statement-call entry
  # (`lowerMethodCallWithSourcePlan`, which statement calls enter directly).
  # json-codec-native.ts +3: the parse entry's name as one exported constant,
  # shared by legacy's three spellings and the IR provider row (review nit 8).
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/ir/from-ast.ts
  - src/codegen/json-codec-native.ts
  # 2026-11-06 (#7267 review, compile-time fold): codegen/index.ts +2 — the
  # production planning site's `jsonParseFoldsAtCompileTime` option and its
  # import; native-strings.ts +1 — the IR-bridge re-export of legacy's fold
  # predicate (no new ir -> codegen import edge).
  - src/codegen/index.ts
  - src/codegen/native-strings.ts
func-budget-allow:
  # 2026-11-06 (#7267): each is one sibling arm in an existing flat dispatch
  # (one entry per provider / per ambient special form); splitting the
  # dispatcher is its own refactor, not this slice.
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::scanExprInner
  - src/ir/select.ts::isPhase1Expr
  - src/ir/integration.ts::makeFromAstResolver
  # 2026-11-06 (#7267 review): +1 each — the fold option on both planning sites.
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
---

# #7267: ambient global object statics refused as `expr-ident-not-in-scope(<Name>)`

## Problem

`ir_only_pass` (standalone test262 passes with zero legacy units, harness
included) is the goal metric. The wrapped stride-40 census shows module-init
and test units refused as `expr-ident-not-in-scope(<Name>)` where `<Name>` is
an ambient global object (`Object`, `String`, `Date`, `JSON`, `Reflect`,
`Function`, `Array`) used as the receiver of a static call or read: the
selector's identifier arm (`src/ir/select.ts`, after `currentHostGlobalResolver`
… `isAmbientIntrinsicValue`) has no admission for the receiver.

## Measurement (2026-11-06, base `origin/main` 9129f7e1)

Wrapped ledger, stride 40, standalone, `JS2WASM_IR_SHAPE_DIAG=1`
(`node scripts/ir-claim-ledger.mts --wrapped --stride 40 --target standalone
--jobs 3 --files-json …`): 1296 files compiled. Units whose FIRST refusal is
`expr-ident-not-in-scope(<Name>)`, and files where that unit is the only
legacy unit ("sole"):

| name       | harness units | test `<module-init>` units | sole files |
| ---------- | ------------: | -------------------------: | ---------: |
| `Function` |             0 |                        121 |          1 |
| `Array`    |            52 |                          2 |          2 |
| `Object`   |             6 |                    38 (+1) |         23 |
| `Reflect`  |            15 |                          3 |          2 |
| `String`   |            14 |                         10 |          6 |
| `Date`     |             0 |                          4 |          4 |
| `JSON`     |             0 |                          2 |          2 |

(The 121 `Function` rows are `propertyHelper.js`'s prelude folded into the
test's `<module-init>`: `Function.prototype.call.bind(<R>.prototype.<m>)`.)

### Shapes, by name (top-level occurrences in the refused unit)

| shape | sole files | host-free provider legacy uses on standalone | operand typing |
| --- | ---: | --- | --- |
| `Object.getOwnPropertyDescriptor(<intrinsic>.prototype \| Number, "k")` then `desc.<field>` | 8 | `__getOwnPropertyDescriptor` over a builtin-prototype VALUE | the receiver is a builtin object value (`Date.prototype`, `RegExp.prototype`, `Number`): no typed operand; #7118/#7127 refuse `Date`/`RegExp`/`Number.*` member values |
| `Object.create({}, {…})` | 4 | type-directed arm (`call-builtin-static.ts`) | object literals; #7189 measured `Object.create` wrong in legacy |
| `<R>.prototype.<m>` read further (`.length`, `.hasOwnProperty("length")`, `typeof String.prototype.at`, `=== `) | 9 (`String` 6, `Array` 1, `Date` 2) | the realm read (#7118 / #7127) | #7127's measured method table + plain-value positions; not a static call |
| `Object.isSealed(JSON)`, `Object.isExtensible(Promise.allKeyed)`, `Object.getPrototypeOf(new URIError)` | 3 | `__object_isSealed` … over builtin values | builtin object values |
| `Object.freeze("abc")` | 1 | identity (ES2015 step 1) | typed string — but 4 files corpus-wide |
| `Date.UTC(<numbers>)` | 1 | inline MakeDay/MakeTime in `call-namespace-static.ts` (no callable provider) | typed numbers; sharing needs a legacy refactor |
| `JSON.parse(<string>)` | 2 (1 has a reviver) | `__json_parse_text` (`(externref) -> anyref`, json-codec-native.ts) | typed string |
| `Function.prototype.call.bind(…)`, `Reflect.construct(fn, [], f)`, `String.fromCodePoint.apply(…)`, `Array.from(…, fn)` | harness | none fixed: first-class builtin function values | fnctor ABI — follow-up |

Corpus-wide (`test262/test`, all files): 91 files call `JSON.parse`; in 34
every call is `JSON.parse(<string literal>)`, and 18 more pass a
string-typed identifier / concatenation.

Only `JSON.parse(<string>)` has all three: a fixed host-free provider legacy
already calls, operands that are typed (no ToString of the IR's own), and a
consumer path (dynamic member reads) the IR already owns. Everything else
needs a builtin object or function as a first-class value (the #7118 /
#7127 / #7189 realm-read tables, measured per name) or a provider legacy does
not have as a callable. Those stay out of this slice (see Left).

## Implementation Plan

- **Module.** `src/ir/ambient-global-function-call.ts` (#7253's), extended:
  - the callee is `parseInt` (identifier) or `JSON.parse` (`<global>.<name>`);
    the table row names the global it resolves through;
  - each row carries its lane capabilities, its unit scope (where the call may
    be lowered — see Reconciliation below) and its result family;
    `JSON.parse` is `["string"]` → `dynamic`, on `native-json-codec` ∧
    `native-dynamic-member-read`, scope `plain-unit`;
  - ONE admission (shape, operand families, capabilities, binding) read by the
    selector and by from-ast — the capability and binding checks that #7253
    repeated on each side move into it;
  - the binding test is the lib-only quantifier plus the same-file declaration
    check, shared with #7118 as `isUnshadowedLibGlobal`
    (`src/shared/ambient-intrinsics.ts`, extracted from
    `isAmbientIntrinsicValueUse`); it replaces #7264's module-local
    `scriptDeclaresName` (one declared-names walk instead of two; it now also
    collects named function / class expressions, as #7264's did).
- **Lowering.** `JSON.parse(s)` → the string operand to externref → `call
  __json_parse_text` (anyref) → `coerce.to_externref` → box onto the dynamic
  carrier (identity on the externref carrier) — legacy's exact
  `call; extern.convert_any`.
- **Wiring.** Selector: the Phase-1 call arm, the dynamic-shape arm and the
  dynamic-scan arm sit beside `JSON.stringify`'s, all through one selector
  adapter (`selectorAmbientGlobalFunctionCall`). Integration: the resolver
  names `__json_parse_text`; finalize pre-registers it (`emitJsonParseText`)
  beside `dyn.json_stringify`'s root, so no Phase-3 body drives a late shift.
- **Closure bodies (lead's R10 note).** A planned closure body reaches the
  same seam: `assert.throws(SyntaxError, function () { JSON.parse("{"); })`
  takes the IR body, zero legacy units (wrapped compile, SHAPE_DIAG). The
  first cut missed it: a statement-position member call enters from-ast at
  `lowerMethodCallWithSourcePlan`, not `lowerCall`, so the selector claimed
  and from-ast withdrew (`identifier "JSON" is not in scope in
  <module-init>__closure_8`); the arm now sits on both entries, like the
  function-object certificate beside it. Array-method callbacks
  (`[…].map((x) => JSON.parse(x))`) are refused earlier
  (`array-method-unsupported`, base and head alike), so they are not
  measurable through this seam; `Date.UTC` / `Object.keys` inside callbacks
  stay `expr-ident-not-in-scope` — not admitted here (see the shape table).
- **Out.** A reviver (second argument), an untyped / non-string text, WASI
  (its IR member read answers NaN for the codec's graph — measured
  `JSON.parse('{"a":3}').a`), the units its scope refuses, any source
  binding named `JSON`.
- **Acceptance.**
  - Correctness: `tests/issue-7267-ambient-json-parse.test.ts` (standalone /
    WASI / gc vs node; shadows vs the IR-off compile); #7253's suite green.
  - Typed corpus byte-identical base vs head (gc / standalone / WASI), host
    imports identical.
  - Wrapped ledger A/B: compileOk not lower, 0 invariants, `JSON` refusals
    fall, zero-legacy files reported.
  - Standalone test262 A/B: the route-changed files, `built-ins/JSON`, samples
    of `built-ins/Object` and `built-ins/Reflect`, 300 random files: head
    never traps or differs where base does not.
  - Code quality: no second admission; the new row is one table entry in the
    #7253 module; the binding test is shared with #7118, not copied.

## Reconciliation with #7114 / #7264 (2026-11-06, base `origin/main` 8b349439)

Review (composition, at `8984da4c`): keep #7114's ES-module guard for the
escape family exactly, and do not blanket-refuse `JSON.parse` in closures
without measurement. #7264 (merged as #7114) had made the module lib-only, added
`scriptDeclaresName`, and replaced the `<module-init>` rule with "in an ES
module, only a top-level function declaration". The merged module keeps that
rule as the escape rows' scope and measures `JSON.parse`'s own:

| unit (standalone, typed operand) | before (branch `8984da4c`) | measured | scope now |
| --- | --- | --- | --- |
| script top level / `assert.throws` callback | IR | IR, correct | admitted |
| script top-level function | IR | IR, correct | admitted |
| script class method | claimed | claimed, then the prepared component fails: "has no resolvable Program ABI binding" (legacy body, correct value) | refused |
| script closure nested in a function, reading the result | claimed | **hard compile error**: "… closure-support:captured-subtype … no longer has its allocator object in the published module" | refused |
| ES module `<module-init>` | refused | — | refused |
| ES module class method | claimed | as the script class method | refused |
| ES module top-level function | IR | IR, correct | admitted |
| ES module closure nested in a top-level function | claimed | hard compile error, as above | refused |

The nested-closure error is not `JSON.parse`-specific: a capturing closure
whose body does any dynamic op loses its captured-struct type from the published
module once the dynamic runtime is registered (non-capturing closures and
capturing ones without a dynamic read compile). `JSON.parse` was the first
admission that lets a dynamic value originate inside a capturing closure.
Follow-up: the Program ABI captured-subtype locator (`program-abi-session.ts`
`resolveLocator`) under late dynamic-runtime registration.

So the row scope is `plain-unit`: the escape rule in ES modules, and in a script
neither a class member nor a closure nested in a function. Regression tests for
each row of the table are in the vitest file.

## Review fix: legacy's compile-time fold (2026-11-06, review 6697778597)

**Blocker.** Legacy folds `JSON.parse(<static text>)` at compile time with the
host's parser (`tryEmitJsonParseLiteral` / `parsedJsonLiteral`,
`src/codegen/json-standalone.ts`). A static text is a string literal, a
no-substitution template, or a `const` chain to one. The admission sent those
texts to the runtime `__json_parse_text`, whose number scan rounds wrongly:
`JSON.parse("4.35") !== 4.35` on head; base completes. The same holds for
`"5e-324"`, `"1.7976931348623157e308"` and `"12345678901234567890"`.

**Fix.** The `JSON.parse` row is `staticTextFolded`. The admission asks
legacy's own predicate, `jsonParseTextFoldsAtCompileTime` (exported from
`json-standalone.ts`, re-exported for the IR bridge through
`native-strings.ts`), and refuses exactly the calls legacy folds. That is a
static text the host parser accepts. An *invalid* static text (the
`SyntaxError` tests) is not folded by legacy either, so it keeps the runtime
codec on both paths. Both planning sites pass the predicate as
`jsonParseFoldsAtCompileTime`:

- `codegen/index.ts`, the production site;
- the integration compatibility path;
- the from-ast resolver.

An absent seam reads as "folds", so the call is refused.

**Verified.**

- The four texts: head = IR-off on standalone; vitest rows on all three
  lanes. A `const t = "4.35"` chain stays legacy too.
- `built-ins/JSON/parse/15.12.1.1-g4-2.js` (the stride's +1 zero-legacy file)
  passes `'"\u0008…"'`, which the host parser rejects, so legacy does not fold
  it. It is still zero-legacy.

**Follow-ups** (ids not allocated: `claim-issue.mjs --allocate` refused
because the open-PR scan was degraded):

- (a) The runtime codec's number scan (`__json_parse_text`) rounds wrongly for
  11 of 20 number texts given as runtime strings. This is pre-existing and
  hit by both paths for non-static texts.
- (b) Legacy's fold gets `JSON.parse("true")` / `("false")` wrong on
  standalone and gc. The runtime path answers them right; the fold is where
  it goes wrong.

## Left (follow-ups)

- Builtin object / function values as receivers and operands
  (`Object.getOwnPropertyDescriptor(Date.prototype, "k")`, `Object.isSealed(JSON)`,
  `<R>.prototype.<m>.length`): extend the #7118 / #7127 measured tables per
  name; each needs its own measurement.
- `Function.prototype.call.bind(…)` (the propertyHelper prelude, 121 rows at
  stride 40) and `Reflect.construct` / `.apply` in the harness: first-class
  builtin function values — fnctor ABI.
- `Date.UTC(<numbers>)`: legacy computes it inline; sharing it needs the
  computation moved into a callable helper first.
- `preregisterDynamicSupport` is a flat flag-per-provider list (this slice
  adds one more); a table-driven pre-registration is its own cleanup.

## Result (2026-11-06, base `origin/main` 9129f7e1)

- **Wrapped ledger** (stride 40, standalone, SHAPE_DIAG): compileOk 1118 =
  1118, invariants 0 = 0, legacy units 4750 → 4749, `expr-ident-not-in-scope
  «JSON»` 2 → 1 (the remaining one has a reviver), **zero-legacy files 32 →
  33** (`built-ins/JSON/parse/15.12.1.1-g4-2.js`). The one route-changed file
  in the stride.
- **Typed corpus** (playground examples × gc / standalone / WASI, 39
  compiles): binaries and host imports byte-identical base vs head.
- **test262 A/B**, row by row, base vs head, every non-pass row identical,
  no trap on either side:
  - standalone, 781 paths (`built-ins/JSON` 165, every 15th `built-ins/Object`,
    every 3rd `built-ins/Reflect`, all 91 `JSON.parse` files, 300 seeded-random,
    the route-changed file): 607 pass / 126 fail / 22 CE / 26 skip on both;
  - gc, `built-ins/JSON` + the route-changed file: 118 / 45 / 2 on both;
  - WASI: no row can change route (the admission requires
    `native-dynamic-member-read`, which WASI lacks); its corpus compiles are
    byte-identical.
- **Equivalence gate** (`12aec39b`): 0 new regressions, 4760 passing.
- **Tests**: `tests/issue-7267-ambient-json-parse.test.ts` (14 cases × 3 lanes,
  incl. 7 source-binding shadows of `JSON` / `parseInt` / `escape` against the
  IR-off compile) and #7253's suite: 87 / 87.

## Adversarial review (fresh context, 2026-11-06)

Verdict: **no must-fix**; the reviewer could not construct a claim-then-refuse
mismatch, a shadow hole or a lane-gating error. Should-fix / nits:

1. **Fixed.** The lowering branched on names three times; it now dispatches
   on the row's `result`.
2. **Fixed.** The capability literals had a third hand-written copy; the row
   capability is `Extract<IrBackendTargetCapability, …>`, exported, and
   from-ast's resolver signature uses it.
3. **Fixed.** `legality.ts`: `native-json-codec` and
   `native-dynamic-member-read` now say they gate `JSON.parse` (and why WASI
   is out).
4. **Fixed.** `runtimeCallable` renamed `refusedInEsModuleInit` with the real
   reason (a `funcMap` helper vs an `ambientBuiltinFuncMap` builtin); every
   row is one literal shape.
5. **Rebutted.** "from-ast does not apply the ES-module `<module-init>`
   refusal": from-ast only lowers claimed units, and nothing else in the
   selector can claim a `JSON.parse(s)` call — without this arm the `JSON`
   receiver is `expr-ident-not-in-scope` (#7118 lists no `JSON` value), so the
   refusal in the shared selector half is the only route. Inherited unchanged
   from #7253's `escape`.
6. **Fixed.** Tests for the #7253 rows under the lib-only binding test
   (`function parseInt`, an inner-scope `escape`).
7. **Rebutted (kept).** The arm sits on both call entries on purpose, like the
   function-object certificate beside it; statement calls skip `lowerCall`.
8. **Fixed.** `__json_parse_text` is one exported constant in
   `json-codec-native.ts`.
9. **Rebutted.** `ambientGlobalFunctionProviderSymbol` looks up helpers
   legacy has already registered; `JSON.parse`'s is registered by the IR's own
   finalize pre-registration, so it is not that helper's row.
10. **Fixed.** `target` is a required, non-optional function.
11. **Fixed.** `IrAmbientGlobalFunctionAdmission`.
12. **Rebutted.** The pre-registration guard mirrors `dyn.json_stringify`'s
    sibling; the capability makes the other branch unreachable.

Not verified by the reviewer, checked here: a monkeypatched lib global
(`JSON.parse = function () { return 7; }; JSON.parse("1")`) keeps the unit
legacy (`body-shape-rejected` on the member store), and legacy itself calls
`__json_parse_text` directly (answers 1) — a pre-existing legacy divergence
from node, unchanged here.
