---
id: 7282
title: "IR module-init: small sole-blocker families (operand coercion, RegExp constructor, call resolution)"
status: done
completed: 2026-11-06
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7266, 7278, 7240]
assignee: "ttraenkler/c-lane-opus"
loc-budget-allow:
  # 2026-11-06 (#7282): from-ast.ts +10 — `lowerBinaryOperands` converts the
  # boolean operand the shared `booleanReadAsNumber` predicate names (+8) and
  # imports it (+1); its doc names the new ToNumber case (+1). The conversion
  # belongs beside the existing `null` -> +0 numeric-reader arm it extends.
  - src/ir/from-ast.ts
  # 2026-11-07 (#7282 review RV7150): select.ts +11 — the generic binary tail
  # refuses a boolean beside the carrier in a prepared component
  # (`lowersAsPreparedComponent`, shared with the escape/unescape arm), the
  # one place both operand families are known before claim.
  - src/ir/select.ts
---

# #7282 — IR module-init: small sole-blocker families

## Problem

On the wrapped stride-40 standalone census, 23 test files have a single
legacy unit — `<module-init>` — refused by one of three small families:
`operand-coercion-unsupported` (6), `regexp-constructor-unsupported` (8) and
`call-resolution-unsupported` (9).

## Measurement (main `8b349439`, 2026-11-06)

Census command:
`JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1 npx tsx scripts/ir-claim-ledger.mts --wrapped --stride 40 --target standalone --jobs 3 --files-json …`

Every file has `<module-init>` as its only legacy unit. "Parts" counts this
family's statement-level parts; "other" counts the remaining statement-level
refusals, unmasked by `MODULE_INIT_ALL_REJECTS` (#7124). A file can go zero
legacy only when "other" is 0.

### `operand-coercion-unsupported` (6)

| File | Refused shape | Parts / other | Next refusal | Host-free provider? |
| --- | --- | --- | --- | --- |
| `language/expressions/bitwise-and/S11.10.1_A3_T2.8.js` | `true & undefined`, `undefined & true` | 2 / 0 | none | **yes**: ToNumber(boolean) = 0/1 → admitted here |
| `built-ins/Array/isArray/15.4.3.2-1-4.js` | `Array.isArray(new Number(-3))` (static predicate on a wrapper object) | 1 / 0 | none | no: the static-predicate lowering (`src/ir/static-predicates/`) answers only primitive families; a wrapper object needs a carrier IsArray |
| `language/expressions/bitwise-or/S11.10.3_A3_T2.2.js` | `"1" \| 1`, `"x" \| 1`, `"1" \| new Number(1)` | 6 / 6 | `new String`/`new Number` wrapper operands | no: string ToNumber in a numeric reader has no IR arm, and wrapper pairs are refused |
| `language/expressions/greater-than/S11.8.2_A2.2_T1.js` | `{valueOf(){…}} > 1` (object ToPrimitive) | 6 / 2 | expression-statement form | no: user `valueOf` / `toString` ToPrimitive |
| `language/expressions/void/S11.4.2_A2_T1.js` | `'…' + (void 0)` | 1 / 3 | `throw-module-scalar-unboxed`, `new Object` | — (other blockers) |
| `built-ins/Set/valid-values.js` | `2 ** 53` | 1 / 53 | module storage and `new Set` | — |

### `regexp-constructor-unsupported` (8)

All of these need a RegExp **object value** in the IR (a literal, `new RegExp`,
or a method on an inline literal). On the host-free lanes the IR has only
#3791's `.test` plan, which requires a stable top-level `var re = /…/` binding
whose legacy carrier is loaded. No bounded admission exists, so all 8 stay
refused (`expr-regexp-literal`, `expr-new-regexp-target`,
`expr-regexp-method-target`).

| File | Refused shape | Parts / other |
| --- | --- | --- |
| `annexB/built-ins/RegExp/RegExp-trailing-escape.js` | `/a\1/`, `/a\a/` literals | 2 / 0 |
| `built-ins/RegExp/dotall/without-dotall.js` | `/^.$/` in `for (let re of [/^.$/, /^.$/m])` | 1 / 0 |
| `built-ins/RegExp/S15.10.2.15_A1_T40.js` | `new RegExp("…").exec("a")` | 1 / 0 |
| `language/literals/regexp/u-unicode-esc.js` | `/\u{…}/u.test(…)` on inline literals ×7 | 7 / 0 |
| `built-ins/RegExp/prototype/Symbol.match/builtin-success-y-set-lastindex.js` | `/a/y` | 1 / 1 (`r[Symbol.match]` callee) |
| `built-ins/String/prototype/replace/S15.5.4.11_A2_T6.js` | `/sh/` | 1 / 1 (string `replace` consumer) |
| `built-ins/RegExp/S15.10.4.1_A6_T1.js` | `new RegExp` | 2 / 1 (`Object`) |
| `built-ins/RegExp/prototype/Symbol.replace/result-get-matched-err.js` | `/./` | 1 / 3 (getter literal, closures) |

### `call-resolution-unsupported` (9)

| File | Refused shape | Parts / other |
| --- | --- | --- |
| `language/function-code/10.4.3-1-104.js` | `Object.defineProperty(Object.prototype, "x", { get: function () { return this } })` | 1 / 0 |
| `built-ins/Function/prototype/bind/instance-length-exceeds-int32.js` | `.bind` on a function value | 2 / 2 (`f` not in scope) |
| `built-ins/Object/defineProperty/15.2.3.6-4-585.js` | `Object.defineProperty` | 1 / 3 (`new RegExp()`) |
| `built-ins/Symbol/prototype/Symbol.toPrimitive/redefined-symbol-wrapper-ordinary-toprimitive.js` | | 2 / 4 |
| `language/statements/for/dstr/let-obj-ptrn-prop-id-get-value-err.js` | | 1 / 1 (`Test262Error`) |
| `language/expressions/class/dstr/{async-gen,gen}-meth-obj-ptrn-prop-id-get-value-err.js` | | 1 / 2–3 (class expression) |
| `language/expressions/{async-generator,object}/dstr/…-dflt-ary-ptrn-elem-id-iter-val-err.js` | | 1 / 4 (`{}`) |

The single file with no other blocker, `10.4.3-1-104.js`, defines an
**accessor on `Object.prototype`** whose getter returns `this`. That needs
the descriptor/accessor MOP on a realm intrinsic, which is not bounded, so it
stays refused.

Expected zero-legacy delta stated before coding: **+1**
(`bitwise-and/S11.10.1_A3_T2.8.js`).

## Implementation Plan (what landed)

- **Module.** `src/ir/analysis/operand-admissibility.ts`, the shared
  binary-operand admissibility module that both the selector
  (`provenBinaryOperandsAdmissible`) and from-ast (`lowerBinary`) consult.
  `booleanReadAsNumber(op, left, right)` sits beside `numberIfNullOrUndefined`
  and is the one predicate: a numeric reader (`- * / % & | ^ << >> >>> < > <=
  >=`) reads a boolean as ToNumber when its partner is a number, `null` /
  `undefined` (read as a number), or the dynamic carrier (`undefined` is one
  on the native lanes). For `- * / %` a boolean pair is read as two f64s;
  bitwise and relational operators keep the i32 pair they already lower.
  `binaryOperandsAdmissible` asks it first.
- **Lowering.** `lowerBinaryOperands` (from-ast) already turns a `null`
  numeric-reader operand into +0. It now also converts each operand the
  predicate names from i32 0/1 to f64 (`f64.convert_i32_s`), so the existing
  number arm (`emitNumberBinary`, ToInt32 for bitwise) and carrier arms
  (`tryLowerDynamicRelational` / arithmetic) lower the result unchanged.
- **Leave it better.** It closes part of a pre-existing claim-then-demote:
  main's selector already claimed function bodies whose boolean locals it sees
  as `unknown` (`f * -1`, `t / f`), and from-ast then demoted them
  ("Phase 1 requires matching operand types" / "no lowering for i32
  operands"). Those bodies now lower; the call-result and compound residuals
  are under Follow-ups.
- **Quality criterion.** One predicate in the shared module, one conversion
  next to the sibling `null` arm, no new arm shape, no new import.

## Results

| | base (main) | head |
| --- | ---: | ---: |
| zero-legacy files (stride 40) | 32 | **33** |
| units ir / both / legacy | 1137 / 8561 / 4750 | 1137 / 8562 / 4749 |
| invariants | 0 | 0 |
| route-changed files | — | 1 (`bitwise-and/S11.10.1_A3_T2.8.js`) |
| zero-legacy files lost | — | 0 |

- Playground corpus (13 files × gc / standalone / wasi): byte-identical.
- `tests/issue-7282-boolean-numeric-operands.test.ts` (standalone / wasi / gc
  vs JS): 36/36 on head; 8 of them fail on main (IR-route assertions).
  Covers bitwise, shifts, `-0` (`false * -1`), NaN, Infinity, `2^32 + 1`
  ToInt32 wrap, `null` / `undefined` / dynamic partners, and the refused
  string partner.
- test262 A/B: see the PR body.

## Follow-ups found (pre-existing on main, not filed)

- An `as`-wrapped `null` operand (`(null as any) | 1`) is claimed and then
  demoted at build ("bare 'null' in non-reference context"): neither the
  selector's `binaryOperandFamily` nor from-ast's `null` arm looks through
  `as`.
- In an ES module (not a script), a module-init `x & undefined` / `x -
  undefined` hits `late-preparation-unsupported`
  (`implicit-support-reference-unavailable`) for the `dyn.undefined` support
  reference; `1 & undefined` does so on main too.
- (RV7150) A boolean beside a fresh wrapper (`new Boolean(true) < true`) is
  now converted beside the wrapper's carrier too (`booleansReadAsNumbers`,
  the one conversion site both branches of `lowerBinaryOperands` share), and a
  boolean beside `undefined` / the carrier in a prepared component (an ES
  module's module-init) refuses at selection instead of failing late
  preparation. Still pre-existing and unchanged in kind: `true < d` with `d` an
  `any` module binding is claimed and then withdrawn (on main at build, here at
  late preparation), because the selector types that binding `unknown`, as it
  does for main's `1 < d`.
- (review) Two boolean-operand residuals still demote at build, as on main:
  a boolean-returning CALL (`g() - 1`) lowers to an i32 the IR does not brand
  boolean, so `irOperandFamily` names it `int32` and no conversion runs; and
  the compound `x -= t` goes through `compoundWriteAdmissible`, which has no
  boolean rule. Both are the same ToNumber(boolean) gap on other producers.
- RegExp object values on the host-free lanes (8 files above) and the
  `Object.prototype` accessor (`10.4.3-1-104.js`) remain the next levers in
  these families.

## Acceptance criteria

- [x] Each of the 23 files: refused shape, provider answer and next refusal recorded.
- [x] Only the shape with an existing host-free lowering is admitted, through one shared predicate.
- [x] Zero-legacy delta matches the stated expectation (+1); invariants 0; no file lost.
- [x] Typed corpus byte-identical; ToNumber edge values match JS on all three lanes.
