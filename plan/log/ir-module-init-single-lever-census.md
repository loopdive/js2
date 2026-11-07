# IR `<module-init>` single-lever census (2026-11-07)

Earlier sole-blocker rankings used the module-init unit's **first** refusal.
That unit usually has several refusal parts, so those rankings named levers
that moved zero files. This census uses the **complete** refusal set of each
`<module-init>` unit.

## Method

- Main `cc27f70dfd`, `scripts/ir-claim-ledger.mts --wrapped --stride 40
  --target standalone --files-json`.
- Run with `JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`.
  The module-init walk then records every rejected top-level statement
  (`<reason>@<arm>`, joined by ` | `). The claim outcome is unchanged.
- Population: compiled files whose **only** legacy unit is `<module-init>`.
  There are **508** (the lead's earlier figure was ≈526, on an older main).
  The ledger's histogram is otherwise `{0: 32, 1: 510, …}`.
- **Caveat:** one part per top-level statement. A statement with two
  refusals inside it shows only its first, so a "single part" is an upper
  bound on how close a file is.
- **Grouping:** parts are grouped into families by arm plus a coarse class
  of the construct, e.g. `vardecl-module-storage-unrepresentable` split by
  initializer kind. Scratch scripts (not committed):
  - `.tmp/mi-group.py` (exact parts);
  - `.tmp/mi-fam.py` (families).

## Distribution

| refusal parts per unit | 1 | 2 | 3 | 4 | 5+ |
| --- | --- | --- | --- | --- | --- |
| exact parts | 114 | 136 | 110 | 60 | 88 |
| families (parts of one family merged) | 148 | 159 | 130 | 40 | 31 |

## (1) True single-lever files: exactly one family

| files | family (examples) | owner |
| --- | --- | --- |
| 32 | **ambient builtin read**, a long tail of about 25 APIs, at most 5 files each. Split below. | split |
| ↳ 14+2 | static call `X.m(…)`: `Object.getOwnPropertyDescriptor` ×5; `JSON.parse` ×2; `Object.freeze`, `isSealed`, `isExtensible`, `getPrototypeOf`, `create`; `Date.UTC`; `Reflect.defineProperty`, `setPrototypeOf`; `RegExp.escape` ×1 each | gOPD: #7294 (R8). `JSON.parse`: #7267 (PR #7118). The rest: **unowned** (#7267's shared ambient-call admission is the seam) |
| ↳ 9 | `X.prototype.m` value reads plus `.length` / `.name` / `.hasOwnProperty(…)` on them (`String.prototype.slice.length`, `Date.prototype.toISOString.length`, `Error.prototype.name`, …) | #7294 (R8, builtin values). Issue #7127 (proto method reads) is done; these are the residual member-of-method shapes |
| ↳ 2 | `Object.isFrozen.length`, `typeof Int16Array` | #7294 (R8) |
| ↳ 5 | builtin method borrow through `.call` (`String.prototype.trim.call(false)`, `Map.prototype.delete.call`, `Function.prototype.bind.call`, `Promise.all.call`, `Array.from.call`) | **unowned**. The #7106 borrow wrapper covers `Array.prototype.*` only |
| 18 | **closure-shaped** (split below) | split |
| ↳ 6 | statement IIFE `(function(){ … })()`, `body-exprstmt-other(expr-call-callee-nonident)` | #7308 (R14), if IIFEs are in its scope, else **unowned** |
| ↳ 7 | callback whose body refuses (`closure-return-type` / `closure-body`): `assert.throws(TypeError, () => { Object.defineProperty({}, 'a', 0n); })` | the inner construct (builtin calls, BigInt); **unowned** as a family |
| ↳ 2 | async generator expressions with patterned parameters | deferred (`async-generator`) |
| ↳ 3 | `obj['try']()` callee, `new Temporal.Duration` callee, a `vardecl-let-closure` | various |
| 8 | **class expression or local class**: `var C = class { static [*]method(<destructuring param>) {…} }` ×6 (class/dstr); `class extends A {}`; `new Err()` (local subclass of a builtin) | **unowned** |
| 8 | module storage: **object literal** (generator / patterned methods, `__proto__` shorthand, escaped keys, `{0: 0, length: NaN}`) | #7280 (R13) |
| 6 | **RegExp**: literal in an expression ×5; literal stored in a var ×1 | #7106 lever R (PR #7154 / #7162) |
| 4 | **BigInt literal** (`1n` in comparisons) | **unowned**; no BigInt value kind on the standalone IR |
| 4 | **`new Temporal.X(…)` stored in a module var** (`vardecl-module-value-flow`) | **unowned** (see the Temporal cluster below) |
| 4 | `var` kind / for-head `var` / `export var` | #7288 (PR #7157) |
| 3 | `throw new Test262Error('…' + x)` with a module scalar | #7281 (PR #7147) |
| 3 | `new ArrayBuffer(…)` / `new DataView(…)` | #7274 (PR #7121 / #7161) |
| 3 | array search methods on a literal with `fromIndex` (`[1,2,3].indexOf(1, 1)`, `lastIndexOf(true, NaN)`) | **unowned** |
| 3 | string methods (`normalize('bar')`, `replaceAll(…, '$')`, `indexOf(undefined)`) | **unowned** |
| 3 | `unattributed-arm` (diagnostic gap) | none; the diag needs an arm label |
| 2 each | `Test262Error` as a value; `new String(…)`; `expr-module-extern-call-brand`; `{}` (#7128); top-level await; `forof-head-pattern-complex`; `tail-unhandled`; `body-unhandled-stmt` (Annex B function in a block) | `Test262Error` / function values: #7305. `{}`: #7128. Rest: unowned |
| 1 each | 24 more singletons | — |

## (2) Two-family files (159), top pairs

| files | pair | owner(s) |
| --- | --- | --- |
| 9 | Temporal value in a module var + a callback using it (`() => d.round(…)`) | **unowned** (Temporal values) + #7308 |
| 8 | object-literal storage + an unresolved identifier (`callbackfn`, `obj`) | #7280 + function values (#7305) |
| 6 | ambient builtin read + method call on a module binding (`newObj.hasOwnProperty("prop")`) | #7294 / #7267 + **unowned** (`expr-module-scalar-method`) |
| 5 | ArrayBuffer/DataView + method call on the module binding | #7274 + **unowned** |
| 5 | Temporal value in a module var + a method call on it (`d1.abs()`) | **unowned** |
| 4 each | array method + array storage; object storage + ambient read; array storage + its read; object storage + closure; array storage + for-head var; local call target + closure; class expression + `new <ctor>` | mixed. **Array-literal storage** (73 files carry it) has no open lane: the #7106 lever S vector-binding design was withdrawn |

## Clusters worth one lever each

- **Temporal values in module vars:** `new Temporal.X(…)` or
  `Temporal.X.from(…)` stored in a script var (`vardecl-module-value-flow`),
  plus method calls and callbacks on it. 76 module-init-only files are
  Temporal; 47 of them have at most two families, and 22 of those 47 are
  this cluster alone or with a closure / method-call partner. **Unowned.**
- **Array-literal module storage:** 73 files carry it, but it is a sole
  lever in only 1. It pairs with array methods and for-head vars.
  **Unowned.**

## Top unowned single-lever parts (exactly one family)

| # | lever | files |
| --- | --- | --- |
| 1 | ambient builtin static calls beyond gOPD / `JSON.parse` (one file per API, through #7267's admission seam) | 9 |
| 2 | class expression / local class (static, patterned methods; `extends`) | 8 |
| 3 | callback body refusals inside `assert.throws` (heterogeneous inner builtin calls) | 7 |
| 4 | builtin method borrow through `.call` on non-Array prototypes | 5 |
| 5 | BigInt literal / `new Temporal.X` module-var storage | 4 each |

The statement IIFE (6 files) moves up to fourth if #7308 does not cover it.
