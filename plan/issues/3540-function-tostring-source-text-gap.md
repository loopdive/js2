---
id: 3540
title: "spec gap: Function.prototype.toString source text — compiled closures stringify as `[object Object]` / callback-shim source instead of NativeFunction syntax (57/80 toString-dir fails)"
status: done
sprint: 77
created: 2026-07-23
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: function
goal: es5
related: [3024, 3534, 1337, 1632]
---

# #3540 — `"" + fn` does not produce NativeFunction (or source) text for compiled closures

## Provenance

Split out of #3534 (per lead direction). After the #3534 closure-representation
fix eliminated every `illegal cast` trap in
`built-ins/Function/prototype/toString/` (67 → 0 trap rows, 11 → 23 pass on the
gc lane), the **residual 57/80 fails in that directory are dominated by ONE
distinct defect**: stringifying a compiled function value does not yield
anything the `nativeFunctionMatcher.js` harness accepts.

## Signature (measured 2026-07-23, gc lane, post-#3534)

`assertNativeFunction(fn)` / `assertToStringOrNativeFunction(fn, expected)`
compute `const actual = "" + fn` and validate it against NativeFunction
syntax (`function <name>? (<params>) { [native code] }`). For compiled values,
`actual` comes back as one of:

- `"[object Object]"` — closure struct boxed to externref, default
  Object-toString path (e.g. `arrow-function.js`, `unicode.js`).
- `"null"` / `"undefined"` — the value read loses the closure entirely
  (e.g. `Function.js`, `method-computed-property-name.js`).
- **The host callback-shim's OWN JS source** — `getter-object.js` stringifies
  the `__cb_N` dispatch shim (`function(...args){const exports=callbackState…`),
  leaking internal runtime source text to user code.

Example rows:

```
fail arrow-function.js  Test262Error: Conforms to NativeFunction Syntax: "[object Object]" (…)
fail Function.js        Test262Error: Conforms to NativeFunction Syntax: "null" (function anonymous…)
fail getter-object.js   Test262Error: Conforms to NativeFunction Syntax: "function(...args){const exports=callbackState?.getExports()…"
```

## Scope note

This spans far more than the 57 files in this directory — every
`Function.prototype.toString` conformance path over a compiled function hits
it. Spec §20.2.3.5 permits an implementation-defined NativeFunction form for
functions whose source is unavailable, so the cheap conforming fix is to make
function-valued externref boxing carry a host `Function` facade (or intercept
`toString`/`Symbol.toPrimitive` on the closure box) that yields
`function <name>() { [native code] }` — the callback-shim leak in
`getter-object.js` additionally needs the shim to override its own `toString`.

## Acceptance criteria

- `"" + fn` for a compiled closure yields a NativeFunction-conforming string
  (accepted by `validateNativeFunctionSource`), never `[object Object]`,
  `null`/`undefined`, or internal shim source.
- Measured pass delta on `built-ins/Function/prototype/toString/` (gc lane;
  post-#3534 baseline: 23/80).
- No closure-representation change (that is #3534's settled invariant:
  externref-boxed closure values, never narrowed).

## Implementation (2026-07-28)

- Host coercion positively identifies raw compiled closures through the emitted
  `__is_closure` discriminator and uses `function () { [native code] }` only
  after user-defined `@@toPrimitive` / `valueOf` / `toString` methods have had
  their ordinary precedence.
- Host callback and closure bridges expose the same NativeFunction facade
  instead of their internal runtime implementation source.
- Standalone finalization extends the shared closure classifier used by
  `typeof` to divert closures through the same facade in
  `__extern_toString`. Closure storage and call dispatch are unchanged.

## Validation

Measured with the maintained forked Test262 runner, official scope only, exact
`built-ins/Function/prototype/toString/` filter (80 files):

- Baseline `ba0bb8ab9b7d893df41b4c7590c51ad05f767175`: gc **23/80**,
  standalone **5/80**.
- Final branch rebased on `83de8d3625deb4e8850dc1bcdac0885db0a15172`:
  gc **44/80** (**21 exact fail-to-pass flips, 0 regressions**), standalone
  **5/80** (0 regressions; 31 failing rows now observe the NativeFunction
  facade but remain red in the standalone-compiled matcher or for independent
  class/builtin/proxy gaps).
- Focused regression gate: 35/35 across #1128, #1988, #1990, #2175, #3429,
  and #3540; `pnpm run typecheck` and Prettier checks pass.
