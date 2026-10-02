---
id: 6713
title: "standalone: calling or constructing a builtin constructor carrier held as a dynamic value (RegExp, Error, TypeError) does not yield an instance (lodash `reIsNative`)"
status: done
completed: 2026-09-28
sprint: current
created: 2026-09-27
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6711, 6703, 4394, 6651, 6736]
# 2026-09-28 (#6713): three one-line hooks into the dynamic call / `new`
# drivers; the lowering itself lives in src/codegen/builtin-ctor-value-invoke.ts.
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
  - src/codegen/expressions/calls.ts::tryEmitInlineDynamicCall
---

# #6713 — dynamic `[[Call]]` / `[[Construct]]` of the standalone `RegExp` carrier

## Problem

lodash 4.18.1 npm-compat **standalone-dynamic** lane, after
[#6711](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6711-standalone-realm-ctors-seeded-without-eval-provider)
(realm object now carries `RegExp`):

```
runtime-error (phase: module-init): TypeError: Cannot read properties of undefined (reading 'test')
```

Inside `runInContext`, `RegExp` is the LOCAL `var RegExp = context.RegExp`
(an externref holding the `__builtin_ctor_RegExp` carrier), so

```js
var reIsNative = RegExp('^' + funcToString.call(hasOwnProperty)
  .replace(reRegExpChar, '\\$&')
  .replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, '$1.*?') + '$');
```

goes through the dynamic-call bridge (`__apply_closure`), which has `[[Call]]`
arms for the `String`/`Number`/`Boolean`/`BigInt` carriers
(`src/codegen/builtin-ctor-callable.ts`, #4394) and for `Object`/`Array`, but
none for `RegExp`. The call answers a non-RegExp value, and the first
`getNative(context, 'DataView')` → `baseIsNative` → `pattern.test(…)` throws.

## Reduction (standalone, `runtimeEvalProvider: false`, 0 imports)

```js
var out = 0;
var R = globalThis.RegExp;
try { if (RegExp('^a+$').test('aa')) out += 1; } catch (e) { out += 100; }     // static: ok
try { if (new RegExp('^a+$').test('aa')) out += 2; } catch (e) { out += 200; } // static: ok
try { if (R('^a+$').test('aa')) out += 4; } catch (e) { out += 400; }          // TRAP: dereferencing a null pointer
try { if (new R('^a+$').test('aa')) out += 8; } catch (e) { out += 800; }      // throws (800)
try { if (R === RegExp) out += 16; } catch (e) {}                               // ok (identity holds)
try { var x = R('^a+$'); if (x instanceof RegExp) out += 32; } catch (e) {}    // TRAP
export function run() { return out; }
```

Each line measured alone on `c2601efa89` + #6711: lines 1, 2, 5 pass; line 4
answers 800; lines 3 and 6 trap with `dereferencing a null pointer` (uncatchable).
Node answers 63 for the whole program. Through a function-scoped alias
(`var RegExp = context.RegExp; RegExp('^a+$')`) the call returns a value whose
`typeof` is `"object"` but whose `.test(…)` throws.

## Direction

Add a `RegExp` arm to the carrier `[[Call]]` guard in `__apply_closure`
(identity `ref.eq` against `ctor:RegExp`, like #4394) that performs §22.2.4.1
with the runtime pattern compiler (`ensureDynamicStandaloneRegExpCompiler`,
already used by `new RegExp(dynamicString)`): string pattern → compile
`ToString(p)` with `flags === undefined ? "" : ToString(flags)`; a RegExp
pattern with undefined flags → return it (call spelling). Mirror it in the
dynamic `[[Construct]]` path so `new R(p)` builds a fresh RegExp. Check the
runtime compiler accepts lodash's `reIsNative` source (lazy `.*?`, escaped
`\(\) \{ \[native code\] \}`) — if it defers ("poisoned" simple compile), that
is the next link.

Same family, next in line for lodash: the `Error` / `TypeError` carriers held
as values (`var Error = context.Error`) also fail — `var E = globalThis.Error;
new E('x')` traps with `illegal cast` (uncatchable), and a lodash probe
`throw new Error('…')` placed inside `runInContext` rendered only as
`[object WebAssembly.Exception]`. A lodash probe after the `reIsNative`
definition confirmed `reIsNative == null || typeof reIsNative.test !=
'function'` holds at module init. Scope the fix as dynamic `[[Call]]` /
`[[Construct]]` for the builtin constructor carriers that lodash's
`runInContext` aliases (`RegExp`, `Error`, `TypeError`, `Date`, `String`,
`Object`, `Function`), RegExp first.

Separately observed (not a lodash blocker): `typeof Function.prototype` reads
`"object"` in standalone (spec: `"function"`), and
`Function.prototype.toString.call(Object.prototype.hasOwnProperty)` throws at
top level while the same call through a `context.Function` alias returns a
string.

## Implementation Plan

(Executed 2026-09-28.)

1. **Helpers, minted on demand** — new module
   `src/codegen/builtin-ctor-value-invoke.ts`. When a call or `new` site's
   callee TRACES to a constructor name (`X.RegExp` / `X["TypeError"]` off any
   receiver, the ambient global, or a single-assignment alias of either —
   `tracedBuiltinCtorValueName`), mint once per module:
   - `__builtin_ctor_value_RegExp(pattern, flags, isCall)` — §22.2.4.1, the
     exact sequence the static `RegExp(obj)` lane emits. That sequence was
     factored out of `regexp-ctor-regexp-like.ts` into
     `registerRegExpCtorRuntime` / `resolveRegExpCtorOps` /
     `regExpCtorOperationInstrs` (byte-identical for the existing caller); the
     step-2 call-spelling shortcut takes an extra runtime `isCall` conjunct.
   - `__builtin_ctor_value_<Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError>(message)`
     — §20.5.1.1: spec ToString (`__extern_to_string_spec`, a Symbol throws)
     unless undefined, then the native `__new_<Name>` `$Error_struct` ctor.
   The carrier slot is RESERVED (not materialized) at mint time so a later read
   reuses it (`reserveBuiltinConstructorIdentityGlobal`, and a new
   `reserveBuiltinNamespaceObjectGlobal` factored out of
   `emitBuiltinNamespaceObject`).
2. **`[[Call]]`** — `builtinCtorCallableArmInstrs` (the #4394 front guard of
   `__apply_closure`) prepends one `ref.eq`-identity arm per minted helper.
   `tryEmitInlineDynamicCall` mints the helper for a traced callee.
3. **`[[Construct]]`** — `emitBuiltinCtorValueConstructOnNull` retries a null
   dynamic-`new` result against the carrier: appended to the standalone
   TypedArray/bound/runtime-eval chain in `compileNewExpression` and to
   `emitDynamicNewFallback`'s standalone no-match base.
   `resolvesToDynamicAnyCtorValue` no longer rejects a LOCAL binding named like
   an extern class (`var RegExp = context.RegExp`) in the host-free lanes
   (`shadowsExternClassName`); it fell to a `__new_RegExp` import that cannot
   exist and constructed null without evaluating its arguments.
4. **Typed aliases** — `var R = globalThis.RegExp; R(p)` / `new E(m)` carry the
   lib constructor interface and took the typed closure-call / extern-class
   lowerings (null-deref trap, `illegal cast`, or `undefined`).
   `tryCompileBuiltinCtorAliasInvoke` (hooked in `tryRegExpConstructorCall` and
   at the top of `compileNewExpression`) emits
   `callee === carrier ? helper(args) : <today's lowering, re-entered>`;
   declines for spread / function-bearing arguments.

The runtime decision is always reference identity against the carrier global;
the name trace only decides whether a helper is minted. Standalone only
(`ctx.standalone && !ctx.wasi`); modules without a traced site are
byte-identical, and the JS-host lane is byte-identical.

## Resolution

lodash 4.18.1 standalone-dynamic lane (`generate-npm-compat-report.mjs --only
lodash --no-write --perf-only --lane standalone-dynamic`, 0 imports):

- before (`2e23e49fb1`): `runtime-error (module-init): TypeError: Cannot read
  properties of undefined (reading 'test')` — died at `lodash.js:1547`.
- after: `runtime-error (module-init): TypeError: called value is not a
  function` — module init now runs to `lodash.js:17127` (of 17226). Located with
  step markers: `baseForOwn(LazyWrapper.prototype, …)` →
  `isArrayLike(LazyWrapper.prototype)` is wrongly true because a function's
  `prototype` object answers a numeric `.length` → filed as
  [#6736](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6736-standalone-fnctor-prototype-length-reads-number).

Regression test `tests/issue-6713-builtin-ctor-value-invoke.test.ts`: parent
`95000` / null-deref trap; fix `127` / `63` (Node: `127` / `63`).

Scoped standalone test262 (`run-test262-paths.mts --standalone`,
`built-ins/RegExp/*.js` + `built-ins/Error/**` + `built-ins/NativeErrors/**`,
675 rows): parent pass 614 / fail 52 / compile_error 9, fix pass 614 / fail 52 /
compile_error 9 — the 61 non-pass rows are the identical set (no gains, no
losses; none of these rows invokes a carrier through a variable). JS-host
control: the lodash js-host binary is byte-identical parent vs fix
(sha256 `b0fc935a6a428ee6…`, 1,286,632 B), as is a standalone module exercising
the refactored static `RegExp(obj)` lane.

Residuals (pre-existing, not addressed): `x instanceof <carrier value>` with a
dynamic RHS (`e instanceof context.TypeError`) answers false even for a
statically constructed error; on a `$NativeRegExp` receiver read through `any`,
`re.constructor` / `re[Symbol.match]` read undefined, so `RegExp(re)` through
the alias clones instead of returning `re` (§22.2.4.1 step 2).
