---
id: 7608
title: "Prepared IR path: `globalThis` (the test262 runtime shim's `$262.global`)"
status: ready
sprint: current
created: 2026-11-27
updated: 2026-11-27
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: [7609]
related: [7354, 7607, 7609]
---

# #7608 — `globalThis` on the Prepared path

Order against #7607 and #7609: see the top of
[#7607](7607-prepared-script-var-forin-with-catch.md). This issue comes last: it passes no row by itself.

## Problem

`ir/from-ast: identifier "globalThis" is not in scope` is the first diagnostic of **289** ES5 rows (merge-queue run
of 2026-11-27 19:14).

Where it comes from: not from the tests (ES5 has no `globalThis`; only 5 files of the list spell it at script
level) and not from `test262/harness/*.js` (only `asyncHelpers.js` spells it). It is the runner's own shim,
`scripts/test262-fyi-runtime.js`, prepended to every test:

```js
var $262 = { global: globalThis, …, createRealm: function () { … globalThis.Array … }, evalScript: … };
```

The Prepared front door drops the `$262` statement when the test never names it (`elideDeadBindings`,
`src/test262/prepared-dead-bindings.ts`, over `elideDeadTopLevelBindings`, `src/deadcode-elide.ts`). The statement
survives, and its top-level initializer refuses in `<module-init>`, when:

| why `$262` survives | rows (static, positive) | next stop with `global: globalThis` rewritten to `global: void 0` |
| --- | ---: | --- |
| dynamic code with unknown source: `eval(x)`, a bare `eval` | 190 | 4 sampled: 2 `eval statement has no eval provider`, 1 `identifier "eval" is not in scope`, 1 runs into the abort body of a closure with `eval`. **0 pass.** |
| `Function` in a position that is not inert (`Function(x)`, `new Function(a, b)` with a non-literal, `instanceof Function`, a bare value) | 120 | 6 sampled: `unknown class "Object"`, `unknown class "Function"`, `identifier "Array"`, direct call to `"Function"`, `identifier "Object"`, `identifier "Intl"`. **0 pass.** |
| both | 20 | as above |
| the test names `$262` | 21 | 3 sampled: direct call to `"Function"` (from `fnGlobalObject.js`). **0 pass.** |
| an include names it (`wellKnownIntrinsicObjects.js`) | 1 | not compiled |

Static total 352 positive rows against 289 measured: the difference stops earlier (an include before the shim, or
the #7607 guard). Raw compiles confirmed the diagnostic on 2 of 3; the third stopped in `fnGlobalObject.js`, which
precedes the shim.

With the rewrite the `$262` object literal itself lowers and the script runs up to the next gap, so `globalThis` is
the shim's only compile-time stop. Every sampled row then stops at a gap another issue owns (`eval` / `Function`
providers, the standard globals).

## Implementation Plan

Binding: CLAUDE.md "IR path: code quality comes first". `src/ir/from-ast.ts` must not grow.

### Which fix

| option | verdict |
| --- | --- |
| a realm value for the global object | **yes.** It is the mechanism #7609 builds for script-level `this`; `globalThis` is the same value (§19.1.1). |
| a harness-specific rewrite (drop or blank `$262.global` on this path) | **no.** Not exact: the unknown dynamic code that kept `$262` alive may read `$262.global`. |
| keep `$262` elided whenever the path cannot run dynamic code anyway | **no.** A bare `Function` value can be called later with computed source; the elision rule is shared with the ordinary pipeline and stays one rule. |

So #7608 and #7609 are one mechanism, and this issue has no mechanism of its own.

### Slice G — the identifier (≈ 80 changed source lines, after #7609 A1)

- **Module:** `src/ir/identifier-read.ts`, beside the standard-global reads it already resolves.
- **Rule:** an identifier `globalThis` that the checker binds to no program symbol reads the global object value
  through #7609 A1's single emitter. Selection admits it where it admits a standard-global value read.
- **Sealed, as in #7609:** storing it (`global: globalThis`), comparing it and `typeof globalThis` (`"object"`) are
  exact. Any keyed operation on the held value (`$262.global.x`) ends in the run-time abort.
- **`globalThis.N` with a literal name** is #7609 slice B's resolver, not a second one. The shim's
  `globalThis.Array` reads sit in the `createRealm` closure and keep that closure's abort body until the name is
  provided.
- **Refused by name:** a write to `globalThis`, `delete globalThis`, a program binding named `globalThis` that the
  path cannot resolve.
- **No new intrinsic, no new IR→runtime import edge** (they stay at 10).

### Acceptance

Correctness:

- programs that store, compare and `typeof` the value agree with node; `globalThis === this` at script level is
  `true`; a keyed use of the held value aborts and never answers a value;
- the real prelude plus a body that keeps `$262` alive compiles and runs to the body's own first gap;
- ordinary-pipeline output byte-identical; valid Wasm; nothing thrown out of `compile()`;
- tests are source programs run against node. No census rows, receipts, hash / count / text pins, forged-plan
  tests (#7380).

Code quality:

- no emitter or resolver beside #7609's; the slice adds one arm and its tests;
- `from-ast.ts` unchanged; no size grant.

## Out of scope

- `eval` and `Function` providers, and the standard globals: the 289 rows' real next stops.
- `$262.createRealm`, `$262.evalScript`.
- Keyed access to the global object (#7609 slice C).

## Open questions for the owner

1. **Slice C of #7609** (script bindings as properties of the global object): build it per program (only when the
   global object escapes), or keep the sealed value until a measured row count asks for it? `for (k in this)`,
   `fnGlobalObject()` and the `verifyProperty(this, …)` rows wait on it.
2. **`with` over a non-literal target** takes 59 of #7607's rows and 51 of #7609's. It is the same object
   environment record as slice C. One issue for both?
3. **The Prepared for-in runtime** (#7607 S3) is sized at ≈ 600 lines and passes ≤ 10 rows before `Object`'s
   statics land. Schedule it with that lane rather than first?
