---
id: 7267
title: "IR: ambient global object statics (`Object`, `String`, `Date`, `JSON`, `Reflect`, `Function`, `Array`) refused as `expr-ident-not-in-scope` — slice 1: `JSON.parse(<string>)`"
status: in-progress
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
  # dynamic-shape, dynamic scan); integration.ts +13 — the provider constant,
  # the resolver row, and the finalize pre-registration beside
  # `dyn.json_stringify`'s; from-ast.ts +8 — the resolver capability union and
  # the admission adapter.
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/ir/from-ast.ts
func-budget-allow:
  # 2026-11-06 (#7267): each is one sibling arm in an existing flat dispatch
  # (one entry per provider / per ambient special form); splitting the
  # dispatcher is its own refactor, not this slice.
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::scanExprInner
  - src/ir/select.ts::isPhase1Expr
  - src/ir/integration.ts::makeFromAstResolver
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
  - each row carries its lane capabilities, whether its provider is a runtime
    callable (an ES module's `<module-init>` refuses those), and its result
    family; `JSON.parse` is `["string"]` → `dynamic`, on
    `native-json-codec` ∧ `native-dynamic-member-read`;
  - ONE admission (shape, operand families, capabilities, binding) read by the
    selector and by from-ast — the capability and binding checks that #7253
    repeated on each side move into it;
  - the binding test is the lib-only quantifier plus the same-file declaration
    check, shared with #7118 as `isUnshadowedLibGlobal`
    (`src/shared/ambient-intrinsics.ts`, extracted from
    `isAmbientIntrinsicValueUse`). This also moves #7253's rows from the
    "some" quantifier to lib-only (#7264).
- **Lowering.** `JSON.parse(s)` → the string operand to externref → `call
  __json_parse_text` (anyref) → `coerce.to_externref` → box onto the dynamic
  carrier (identity on the externref carrier) — legacy's exact
  `call; extern.convert_any`.
- **Wiring.** Selector: the Phase-1 call arm, the dynamic-shape arm and the
  dynamic-scan arm sit beside `JSON.stringify`'s, all through one selector
  adapter (`selectorAmbientGlobalFunctionCall`). Integration: the resolver
  names `__json_parse_text`; finalize pre-registers it (`emitJsonParseText`)
  beside `dyn.json_stringify`'s root, so no Phase-3 body drives a late shift.
- **Out.** A reviver (second argument), an untyped / non-string text, WASI
  (its IR member read answers NaN for the codec's graph — measured
  `JSON.parse('{"a":3}').a`), an ES module's `<module-init>`, any source
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
