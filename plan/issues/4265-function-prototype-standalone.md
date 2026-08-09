---
id: 4265
title: "`Function.prototype`, ES5 standalone: bucket diagnosis — `ToString` of a callable answers `[object Object]`, an object-literal method call does not bind `this`, and most `toString` residue is a MISSING function value, not a wrong string"
status: in-progress
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: function-prototype
goal: es5
related: [4096, 3117, 1888, 1463, 2928]
assignee: "ttraenkler/senior-dev"
origin: "ES5-standalone-90 program, `Function.prototype` bucket. First diagnosis of this bucket."
---

# #4265 — `built-ins/Function/prototype`, standalone: signature breakdown and root causes

## Measurement

All 309 files under `built-ins/Function/prototype`, sequential
`runTest262File(…, "standalone")`, **runtime-eval tier: REFUSAL**
(`--refusal-only`, key `53838e1372b11156`). The 47 `dynamic code evaluation is
not supported` entries are an artefact of that tier and would mostly pass under
`TEST262_FULL_RUNTIME_EVAL=1`; they are excluded from every root-cause count
below and are identical in both arms.

Base (`upstream/main` e1aeff7c2): **152 pass / 148 fail / 9 compile_error.**

| sub-directory | fail | CE | eval-refusal | pass |
| --- | --- | --- | --- | --- |
| `toString` | 44 | 0 | 1 | 35 |
| `bind` | 23 | 5 | 0 | 72 |
| `Symbol.hasInstance` | 11 | 0 | 0 | **0** |
| `apply` | 9 | 0 | 22 | 17 |
| `call` | 5 | 0 | 22 | 22 |
| everything else | 12 | 4 | 2 | 6 |

## Root causes, with evidence

### RC-1 — `ToString` of a CALLABLE answers `[object Object]` (FIXED, +0 here)

§13.15.3 `"" + f` runs ToPrimitive(f, string), which reaches
`Function.prototype.toString` (§20.2.3.5) — never
`Object.prototype.toString`. The standalone concat cascade
(`compileNativeConcatOperand`) had no callable arm, so a function operand fell
through to `$__any_to_string`, whose terminal is the literal `"[object Object]"`.

Fixed in `src/codegen/callable-to-string.ts` +
`src/codegen/string-ops.ts`: a **statically** callable operand (the checker
reports call or construct signatures) emits §20.2.3.5 step 3's NativeFunction
form. Verified: `"" + plain` and `"" + ClassValue` were `[object Object]`, now
`function () { [native code] }`; a class INSTANCE, an object literal, an array
and a user `toString` are all unchanged.

**Measured effect on this bucket: 0.** Stated plainly because it is the
load-bearing finding for whoever picks this up: the failing population does its
stringification **inside the harness**, in
`assertToStringOrNativeFunction(fn, expected) { const actual = "" + fn; … }`,
where `fn` is an untyped parameter. `any` has no call signatures, so a static
predicate can never see it. Regression-checked at 0/0 over
`built-ins/Function/prototype` (309), `language/expressions/addition` (48) and
`language/expressions/concatenation` (5).

**The remaining 15 need the RUNTIME arm**, in `$__any_to_string`'s terminal
(`objectOrErrorTag`, `src/codegen/native-strings.ts`): `ref.test` the value
against the funcref-wrapper ROOT struct
(`getFuncRefWrapperRootTypeIdx`) and against `objectRuntimeTypes.proxyTypeIdx`
with a callable target, and answer NativeFunction before the object tag. Both
type indices are already in `ctx`; what is unverified is whether every closure
representation actually subtypes that root, which is the one thing to measure
before building it.

### RC-2 — `toString` residue splits three ways, and only one third is a STRING defect

The 44 `toString` failures all report
`Conforms to NativeFunction Syntax: <actual>`. Bucketed by `<actual>`:

| actual | files | meaning |
| --- | --- | --- |
| `"[object Object]"` | **15** | the value IS the function; the STRING is wrong — RC-1's runtime arm. All 10 `proxy-*` files + all 5 `class-{declaration,expression}-*`. |
| `"undefined"` | **19** | the value could not be OBTAINED. Class getters/setters via `getOwnPropertyDescriptor`, class-expression methods, async/generator methods, computed-name methods. |
| `"null"` | **8** | ditto. Static class methods, private static methods, `AsyncFunction`/`GeneratorFunction`/`AsyncGenerator` constructor results. |

**27 of the 44 are not `toString` bugs at all** — they are missing
property-access results on class prototypes/constructors and on accessor
descriptors. Anyone staffing "Function.prototype.toString" should read that
table first; fixing stringification cannot move them.

For the 10 `proxy-*` files the NativeFunction answer is not an approximation:
a Proxy has no `[[SourceText]]`, so §20.2.3.5 step 3 makes it the **only**
conforming answer.

### RC-3 — an object-literal method call does not bind `this` (NOT FIXED, unfiled before now)

Confirmed by isolated probe, standalone script goal:

```js
var obj = { x: 42, m: function () { return this.x; } };
obj.m();          // NOT 42
obj.m.call(obj);  // 42            ← the composition works
typeof this;      // "object"      ← `this` is bound to SOMETHING, just not obj
```

Mechanism: the callable-field call path in
`src/codegen/expressions/calls-closures.ts` (the `closureInfo` /
`getOrCreateFuncRefWrapperTypes` arms) pushes **the closure ref itself** as the
lifted function's first parameter — that slot is the closure's `self`
environment, not the ECMAScript `this`. Nothing threads the receiver. #4096
built exactly the missing composition (`__apply_closure(F, T, args)`) for the
EXPANDO shape (`o.f = function(){}`) and deliberately narrowed itself to
members "some `<expr>.<name> = …` assignment could have stored", so a member
declared in the object literal is not claimed by it.

**How much of this bucket it accounts for: a minority, but a real one.** The
`apply`/`call` residue includes
`The value of this["…"] is expected to be "…"` (`S15.3.4.3_A3_T6`,
`S15.3.4.4_A3_T6`) and `The value of obj.touched is expected to be true`
(`S15.3.4.3_A5_T6`, `S15.3.4.4_A5_T6`) — receiver-threading failures of exactly
this shape. Its real value is outside this bucket: `obj.m()` is the single most
common shape in ordinary JavaScript, so this is a correctness hole far wider
than the 63 files that motivated the investigation. **Recommend filing the fix
as its own issue at high priority rather than folding it into a
`Function.prototype` push.**

### RC-4 — `Symbol.hasInstance`: 11 files, 0 passing

`Function.prototype[Symbol.hasInstance]` is not implemented as a real function.
Signatures: `Cannot convert undefined or null to object` (`length.js`,
`name.js`), `[object Object] should be an own property` (`prop-desc.js`), and
six `dereferencing a null pointer` runtime errors in the `value-*` /
`this-val-*` files. A whole-subdirectory greenfield; needs OrdinaryHasInstance
plus the property descriptor.

### RC-5 — `bind`: 23 fail + 5 CE, several distinct mechanisms

Not one defect. In descending size: five `15.3.4.5-2-*` files trap with
`dereferencing a null pointer`; three `instance-name*` files read `undefined`
for the bound function's `name`; two `instance-length-*` read `NaN` for
`length`; four need `Reflect.construct` with a distinct NewTarget (a standalone
refusal today); one reports `Function.prototype.bind is not yet implemented in
--target standalone`. Worth splitting before staffing.

### RC-6 — the `length` / `name` / `prop-desc` cluster is the DELETE half, not the getter

Confirming the prior wave's lead: `gOPD(fn, "length").configurable` is already
`true`. The failures (`length should be an own property`,
`caller should be an own property`, `arguments should be an own property`,
`name descriptor …`) are in `verifyProperty`'s delete-and-recheck half — the
property cannot actually be deleted and re-defined on the function object.

## What landed here

Only RC-1's static arm (see above), plus its regression tests. It is included
because it is a real §20.2.3.5 violation with a proved-zero blast radius, not
because it moves this bucket — it does not.

- `src/codegen/callable-to-string.ts` (new)
- `src/codegen/string-ops.ts` (`compileNativeConcatOperand`)
- `tests/es5-standalone-callable-tostring.test.ts`

## Acceptance criteria

- [x] Signature breakdown of all 309 files, with the eval-tier artefact
      separated out.
- [x] RC-1 static arm implemented, tested, 0 regressions over 362 measured files.
- [x] RC-3 confirmed by isolated probe and its mechanism located to a named
      function.
- [ ] RC-1 runtime arm (`$__any_to_string` callable test) — 15 files.
- [ ] RC-3 receiver threading for object-literal methods — file separately.
- [ ] RC-4 `Symbol.hasInstance` — 11 files.
- [ ] RC-5 `bind` — split first.
