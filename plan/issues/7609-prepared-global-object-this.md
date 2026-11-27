---
id: 7609
title: "Prepared IR path: the global object as a value (`this` at script level and in a sloppy function called without a receiver)"
status: in-progress
sprint: current
created: 2026-11-27
updated: 2026-11-27
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: []
related: [7354, 7372, 7607, 7608, 7106]
---

# #7609 — the global object as a value

Order against #7607 and #7608: see the top of
[#7607](7607-prepared-script-var-forin-with-catch.md). This issue comes first.

## Problem

`ir/from-ast: 'this' reference outside an instance method body` is the first diagnostic of **198** ES5 rows
(merge-queue run of 2026-11-27 19:14).

Where it is refused: the `ThisKeyword` arm of `lowerExprUnchecked` (`src/ir/from-ast.ts`) finds no `this` in
scope. `bindEntryThis` binds one only for a function declaration with `ambientThisStrict` set; the module
initializer never has one. A function's own refusal becomes an abort body, so the compile error is the **script
level** `this`.

Two related stops sit behind it:

- `dynamicCurrentThis` (`src/ir/program/dynamic-function-operations.ts`): sloppy code whose receiver is
  `undefined` or `null` aborts at run time, because "the realm does not have" a global object (C2-D3).
- `src/ir/program-source-direct-calls.ts`: `a direct call of f installs no receiver for its 'this'` is a compile
  refusal.

Classification: static scan of the ES5 list for a `this` outside every function-like, in files the two earlier
reasons (#7607, #7608) do not take first. It predicts 253 positive rows; the run measured 198 (the rest stop
earlier, for example at a direct `Function(…)` call). Of 3 raw compiles one showed the diagnostic, one stopped at a direct
`Function(…)` call first, and one line of output was lost.

By shape of the script-level use (files; a file may have several):

| shape | rows | needs |
| --- | ---: | --- |
| `var g = this` | 70 | the value; later uses decide |
| `this.x = v` | 57 (+ 26 mixed) | a binding write (slice B) |
| `this.x` read | 39 | a binding read (slice B) |
| `f(this)`, `Object.f(this, …)` | 28 | the value; a keyed operation on it aborts (slice C) |
| `this === x`, `!==`, `in`, `instanceof` | 12 | identity |
| `{ k: this }`, `this()`, `this.f()`, `delete this.x`, other mixes | 22 | value / slice B / refused |

By what else the file needs (static, of 253): nothing else 66; a standard global (`Object`, …) 58; `with` 51;
`call` / `apply` / `bind` 38; dynamic code plus `call` / `apply` 32; dynamic code 8. The largest family is
`language/function-code/10.4.3-1-*` (67 rows): `var global = this;` and a function that compares its own `this`
with it.

Next stop, 21 rows compiled with script `this` replaced by a fresh object (an **upper bound**, not an equivalent:
it has identity but is not the global object):

| outcome | rows of 21 |
| --- | ---: |
| pass, needing identity only | 5 |
| pass, needing `this.x` to be the binding `x` (true result happens to match) | 2 |
| abort: sloppy function, unbound `this` (`__js_value_unsupported`) | 3 |
| refusal: direct call installs no receiver | 1 |
| direct `Function(…)` call | 3 |
| array literal vec / `Object` / `Function` class / constructor name | 5 |
| `bind`, closure to externref, undeclared assignment | 3 |

Scaled to the 198 rows less the `with` fifth: identity ≈ 40, plus unbound `this` ≈ 30, plus binding access ≈ 15.

## Implementation Plan

Binding: CLAUDE.md "IR path: code quality comes first". `src/ir/from-ast.ts` must not grow.

### The mechanism, and what it shares

One realm value, the global object (§15.1; `dyn.global_object` already exists in the IR and has no Prepared
legalization). It serves:

- `this` at script level (this issue), in strict and sloppy scripts alike;
- unbound `this` of sloppy code (this issue);
- `globalThis` (#7608: one identifier arm);
- "a script `var` is a property of the global object" (#7607): slice B for a static name, slice C for the rest.

**Rule that keeps typed homes sound (the H2 invariant, `src/ir/module-binding-script-var.ts`):** script bindings
stay in their homes. The global object value is *sealed* until slice C: every keyed operation on it as a dynamic
value (`[[Get]]`, `[[Set]]`, `[[Has]]`, `[[Delete]]`, `[[DefineOwnProperty]]`, key enumeration, a prototype read)
ends in the run-time abort. So no write reaches a binding through the object, and no read answers `undefined` for a
binding that exists. A stand-in ordinary object would do both wrongly.

### Semantics

| case | handling |
| --- | --- |
| `this` at script level | the global object value (A1) |
| `typeof this` at script level | `"object"` (A1) |
| `this.x = 1` at script level, `x` a script binding | writes its home (B) |
| `this.x = 1`, `x` undeclared | creates a global: #7372 slice 3's home; until that lands, a named refusal (B) |
| `this.x` read, `x` a script binding / a standard global / neither | the home / as the identifier read (provided or refused by name) / the undeclared-name home, `undefined` when absent (B) |
| `this[k]`, `for (k in this)`, `"x" in this`, `delete this.x`, `Object.defineProperty(this, …)`, any keyed use of a held reference `g.x` | run-time abort (sealed); slice C |
| plain function called without a receiver, sloppy | the global object (A2) |
| plain function called without a receiver, strict | `undefined` (A2; today: a compile refusal for a direct call) |
| called as a method `o.f()` | the receiver the dispatcher installs (unchanged) |
| via a held reference `var g = o.f; g()` | no receiver: as the two rows above (A2) |
| constructor called with `new` | the new object (unchanged) |
| nested closures | each function binds its own `this` at entry (unchanged). `ambientThisIsLowerable` still declines a function with a `this` in any nested function-like; narrowing that to arrows is a follow-up, not this issue. |
| `call` / `apply` | not built. When they are, a `null` / `undefined` thisArg in sloppy code takes the same A2 arm; a primitive thisArg keeps the abort (wrapper). |
| sloppy code, primitive receiver | keeps the abort (needs a wrapper object) |

### Slice A1 — the value (≈ 350 changed source lines)

- **Realm:** one row in `src/runtime/contracts/native-realm-catalog.ts`, reached through the existing
  `js.object.intrinsic(selector)`. No new intrinsic, no new IR→runtime import edge (they stay at 10).
- **Legalization:** the `dyn.global_object` arm in `src/ir/program/dynamic-value-legalization.ts`, built with the
  existing `selectorCall` helper (`dynamic-value-chains.ts`). The value has a kind of its own in
  `dynamic-value-kinds.ts`: not in `objects`, so every keyed arm already takes its abort branch; `typeof` answers
  `"object"`, truthiness `true`, strict equality compares identity.
- **Frontend:** new `src/ir/this-binding.ts` takes `bindEntryThis` and the `ThisKeyword` arm out of `from-ast.ts`
  and adds the module-initializer case (`emitDynGlobalObject`). From-ast shrinks.
- **Selection:** `src/ir/select.ts` admits script-level `this` as a value where `ambientThisIsLowerable` admits a
  function's.
- **Duplicate removed:** the ordinary pipeline's `lowerAmbientIntrinsicValue` and the new arm share one
  "global object value" emitter.

### Slice A2 — unbound `this` (≈ 300)

- `dynamicCurrentThis`: sloppy code with an `undefined` or `null` receiver takes the global object value instead of
  the abort; a primitive receiver keeps the abort.
- A direct call of a function that reads `this` publishes an `undefined` receiver, through the same publication
  helper that publishes the argument count for `arguments.length` (#7562), parameterised rather than copied. The
  refusal in `program-source-direct-calls.ts` goes.

### Slice B — static names on the syntactic global object (≈ 500)

- **Scope:** `this.N` / `this["N"]` at script level, and `globalThis.N` (#7608), with a literal name.
- **Module:** new `src/ir/global-object-member.ts`, called from the member-access selection and lowering sites; it
  resolves `N` with the resolver the identifier read uses (`src/ir/identifier-read.ts`), so "which binding is `N`"
  has one answer.
- **H2:** `preparedBindingRewritten` counts a `this.N = v` write of a script binding, so a typed home sees it.
- **Refused by name:** a write of a standard global, a compound write of an undeclared name, `delete this.N`.

### Slice C — planned, not sized: bindings as properties

The global object as the object environment record, for a program that keys it dynamically. Needed by
`for (k in this)`, `"x" in this`, descriptor reads and `Object.defineProperty(this, …)`, `delete`, and
`fnGlobalObject()`. It decides per program (the global object escapes, or not), so programs that never observe it
keep their typed homes. Owner decision before a plan is written (see #7608, open questions).

### Acceptance

Correctness:

- each slice's programs agree with node, in sloppy and in strict mode; a sealed use ends in the abort, never in a
  value; each compile refusal is by name; valid Wasm; nothing thrown out of `compile()`;
- no trap where JS throws catchably: `this()` and `new this` at script level throw TypeError catchably;
- ordinary-pipeline output byte-identical;
- tests are source programs run against node, including the H2 route programs
  (`tests/issue-7354-h2-script-binding-routes.test.ts`) extended with the new routes. No census rows, receipts,
  hash / count / text pins, forged-plan tests (#7380).

Code quality:

- one emitter of the global object value and one resolver of a global name;
- `from-ast.ts` shrinks in A1 and does not grow in A2 or B; no size grant;
- the receiver publication and the count publication are one helper;
- no branch for `call` / `apply` before they exist.

## Out of scope

- `call`, `apply`, `bind`; wrapper objects for a primitive receiver.
- `with (this)` and any other `with` over a non-literal target (51 of the rows).
- Dynamic code (`Function("return this")()`, `eval`).
- Slice C.
