---
id: 6738
title: "standalone: `new (a || B)()` with a non-identifier callee expression evaluates to null"
status: done
sprint: Backlog
created: 2026-09-28
updated: 2026-09-29
completed: 2026-09-29
loc-budget-allow:
  # 2026-09-29 (#6738): +4 lines — one import, one comment line and the widened
  # admission expression in tryCompileNativeConstructFromValue. The predicate and
  # the class-result guard live in the new new-value-selecting-callee.ts.
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  # 2026-09-29 (#6738): +1 line — the value-selecting door in the #3981 arm.
  - src/codegen/expressions/new-super.ts::compileNewExpression
  # 2026-09-29 (#6738): +5 lines — the ordinary tail now calls
  # buildOrdinaryConstructCall (construct-under-application.ts) and reserves its
  # i32 scratch local; the ladder itself lives in the new module.
  - src/codegen/native-construct.ts::fillNativeConstructDrivers
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6720, 3981]
---

# #6738 — host-free `new (a || B)()` answers null

## Problem

In `--target standalone` a `new` whose callee is a parenthesized expression
other than an identifier, member access or call — `new (a || B)()`,
`new (cond ? A : B)()` — evaluates to **null** with no trap. The static arms
decline (no identifier), the host-free dynamic-`new` chains in
`compileNewExpression` admit only identifier / member / call callees, and the
legacy `__new_<name>` terminal has no import in standalone.

```js
function ListCache() { this.size = 0; }
ListCache.prototype.set = function (k, v) { this.size++; return this; };
var U;
export function run() {
  var b = new (U || ListCache)();
  return b == null ? 3 : typeof b.set == "function" ? 1 : 2;   // Node 1, standalone 3
}
```

Measured on main `e16ace7ca0` + #6720, single file, `runtimeEvalProvider:
false`. Same answer with or without a runtime-eval site in the module.

## Why it matters

lodash-es uses exactly this shape: `new (Map || ListCache)` in
`_mapCacheClear.js` and `_stackSet.js`. Since
[#6720](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6720-standalone-lodash-es-module-init-null-property-regression)
`Map` is the real realm carrier, so both operands are constructible, but the
`new` never reaches either. The `words` / `kebabCase` lane does not hit it;
any lodash-es operation that builds a `MapCache` or `Stack` at run time does
(`memoize`, `isEqual`, `cloneDeep`, `uniqBy`, …).

## Suggested fix

Admit any expression callee to the host-free native construct path
(`tryCompileNativeConstructFromValue` → `__native_construct_<N>`), which
already evaluates the callee once to an externref and dispatches by runtime
value (closure, class, Proxy, collection carrier). Check the #3981 note that
widening that gate is a larger blast radius, and run the scoped standalone
test262 `language/expressions/new` slice before and after.

## Implementation Plan

Executed as written (2026-09-29, base `0aeb5733bb`).

1. **Admission** — new `src/codegen/expressions/new-value-selecting-callee.ts`:
   `isValueSelectingNewCallee(callee)` is true when the callee, seen through
   parens / `as` / `!` / `satisfies`, is `a || b`, `a ?? b`, `a && b`,
   `c ? a : b` or `(x, a)`. `new (f())()` stays out (the #6651 F4 blast-radius
   note). `isValueSelectingNewSite` adds the host-free gate and declines when
   the checker already names a compiled class result (`new (c ? A : B)()` of
   two same-shaped classes reduces to `A`, whose typed consumers the static
   class arm owns — admitting it turned a wrong-but-live answer into a cast
   trap).
2. **Wiring** — `compileNewExpression`'s #3981 door and
   `tryCompileNativeConstructFromValue`'s admission accept that shape, so the
   callee is evaluated once to an externref and handed to the existing
   `__native_construct_<N>` driver, which already dispatches by value
   (closure, class object, Proxy, #6720 collection carrier).
3. **Under-application** — measuring (2) showed the driver itself was the
   next wall: its ordinary tail called `__call_fn_method_<N>` at the CALL-SITE
   arity, and that dispatcher only admits closures declaring `<= N` formals.
   `new (U || Cache)()` with `function Cache(entries) { this.clear(); }` — and
   the pre-existing `function mk(C) { return new C(); } mk(Cache)` — never ran
   the constructor body. New `src/codegen/construct-under-application.ts`
   dispatches at `max(N, __closure_arity(callee))` (<= 8), padding omitted
   formals with the canonical `undefined` and seeding `__argc` with N — the
   accessor-driver (#4392) / `__apply_closure` (#3592) rule. Without
   `__closure_arity` or a wider dispatcher the tail is byte-identical.
4. **Runtime-eval carrier** — measuring the lodash-es lane after (1)-(3) moved
   its failure into module init: `TypeError: value is not a constructor` from
   `new (memoize.Cache || MapCache)` (`_memoizeCapped.js` runs `memoize` at
   init). lodash-es is a runtime-eval CONSUMER (`template` builds
   `Function(...)` from a runtime string), so every top-level function
   declaration is published as the #2928 AOT-callable carrier, which no
   construct arm and no `__reflect_is_constructor` arm recognises. That is
   pre-existing — on main, `new MapCache()` from another module of the full
   graph already throws the same TypeError — but #6738 surfaced it at init.
   `unwrapRuntimeEvalCarrierCallee` (same new module) replaces a branded
   carrier callee by its `target` at the top of both construct drivers. `[]`
   when the module minted no carrier.

## Resolution

Fixed on branch `issue-6738-new-logical-callee` (base `0aeb5733bb`).

- **Regression test** `tests/issue-6738-new-value-selecting-callee.test.ts`,
  four rows, each checked against Node: parent tree **0/4**, fix **4/4**.
  Rows: the issue repro; `||`/`??`/`?:`/comma callees over fnctors, a class
  and the realm `Map` carrier; an under-applied constructor (`this.clear()`,
  padded formal, `arguments.length`); a two-module runtime-eval consumer
  (`new (U || MC)()` and `new MC([1, 2])` of an imported function).
- **Scoped standalone test262**, `scripts/run-test262-paths.mts --standalone`,
  parent vs fix, per-row diff empty both times:
  - `language/expressions/new` + `built-ins/Reflect/construct` +
    `built-ins/Proxy/construct` + `built-ins/Function/prototype/bind`
    (198 rows): 164 pass / 30 fail / 4 CE on both.
  - `built-ins/Array/{of,from}` + `language/expressions/logical-assignment` +
    `language/expressions/conditional` (163 rows): 131 pass / 32 fail on both.
- **lodash-es `standalone-dynamic` lane**
  (`generate-npm-compat-report.mjs --only lodash-es --no-write --perf-only`):
  before `optimization-error` (`wasm-opt -O4 failed: unexpected expr type …
  Flatten.cpp:231`); after **`measured`** (`words(text).length +
  kebabCase(text).length`, wasm 113.7 µs vs node 3.0 µs). Unoptimized, the
  same sample answers 28 on both trees.
- **JS host**: the value-selecting admission is `noJsHost`-gated and the
  construct driver is never reserved in the default host lane; four probe
  modules compile to byte-identical `--target gc` binaries before and after.
  (`js-host-native`, which can reserve a driver, gets the same ladder/unwrap.)
- Gates: loc/func budgets (allowances above), coercion sites, oracle ratchet,
  dead exports, dogfood validation, host-import policy, `tsc` — all green.
- Pre-existing, unchanged by this PR (same failure on the parent tree): #3981
  "links the instance to the constructor's prototype", #6460 / #6612 / #6619
  pinned-residual expectations (the #6612 `Set().size` pin now reads the
  correct `0` on both trees).

Next blocker for the lodash-es cache classes:
[#6758](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6758-standalone-lodash-es-hash-listcache-instances)
— `new Hash()` / `new ListCache()` instances are broken in the multi-module
graph, so `memoize(f)(4)` traps `RuntimeError: illegal cast`.
