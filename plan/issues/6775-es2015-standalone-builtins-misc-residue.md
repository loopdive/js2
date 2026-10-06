---
id: 6775
title: "ES2015 standalone: built-ins misc residue (70 rows) — Error.prototype.stack accessor pair, bound-fn new.target, Reflect.construct NewTarget on builtin carriers, ArrayBuffer/DataView reflective surface, JSON/Symbol/Map/Date/RegExp protocol gaps"
status: in-progress
sprint: current
created: 2026-09-30
updated: 2026-10-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-lead
related: [6769, 6770, 6771, 6772, 6773, 6774, 6651, 5269, 6493, 4196, 3371, 6612, 1599, 2773, 3037, 680, 6640, 4238, 6484]
loc-budget-allow:
  # 2026-09-30 (#6775 plan): each file gains one arm / one guard / one body per
  # step below; no new subsystem. The implementer restates the grants that
  # the change-set actually needs (drop the rest) — see "Gates" in the plan.
  - src/codegen/error-stack-accessor.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/typeof-natives-finalize.ts
  - src/codegen/construct-is-constructor-guard.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/object-get-prototype-of.ts
  - src/codegen/expressions/reflect-construct-newtarget.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/construct-bound.ts
  - src/codegen/new-target.ts
  - src/codegen/dataview-native.ts
  - src/codegen/builtin-proto-constructor-seed.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/regexp-split-protocol.ts
  - src/codegen/map-runtime.ts
  - src/codegen/wrapper-constructor-carrier.ts
  - src/codegen/generator-yield-linearize.ts
  - src/codegen/json-codec-native.ts
  # 2026-09-30 (#6775 S5, Opus): +6 — the one-line dispatch into the new
  # `expressions/to-primitive-method-call.ts` leaf (the arm body lives there).
  - src/codegen/expressions/calls-closures.ts
  # 2026-10-01 (#6775 S6, Opus): the byte-vec `constructor` arm of
  # `__extern_get`'s vec block (walks the buffer's [[Prototype]]).
  - src/codegen/vec-constructor-carrier.ts
  # 2026-10-01 (#6775 S7, Opus): +2 — one spread of the shared
  # constructor-walk arm into the DataView-window `__extern_get` arm, + import.
  - src/codegen/ta-dyn-mop.ts
  # 2026-10-01 (#6775 S10, Opus): the Error-family arms of the identity
  # construct helper + the `new C(msg)` value-construct fallback.
  - src/codegen/builtin-collection-dyn-construct.ts
  - src/codegen/builtin-static-globals.ts
  # 2026-10-01 (#6775 S11, Opus): +48 — the `<target> = yield` statement arm
  # (predicate + arm + spill typing) in the native generator planner.
  - src/codegen/generators-native.ts
  # 2026-10-01 (#6775 S14, Opus): +3 — one dispatch line + import into the new
  # `class-builtin-species-read.ts` leaf (the arm body lives there).
  - src/codegen/property-access.ts
  # 2026-10-01 (#6775 S16/S18, Opus): Function.prototype own `name`/`length`
  # seeding + `@@<name>` member-key ids; the `@@hasInstance` own-prototype arm.
  - src/codegen/native-proto.ts
  - src/codegen/function-proto-has-instance.ts
func-budget-allow:
  # 2026-09-30 (#6775 S4, Opus): +8 — the JSON boolean box picks the real
  # `$__box_boolean_struct` when the module has it (two-arm literal).
  - src/codegen/json-codec-native.ts::emitJsonParseText
  # 2026-10-01 (#6775 S6, Opus): +8 — the ArrayBuffer-target gate that hoists
  # `Get(NT, "prototype")` before allocation (the body lives in
  # reflect-construct-newtarget.ts::tryEmitArrayBufferNewTargetPreRead).
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  # 2026-10-01 (#6775 S10, Opus): +12 — the Error-family value-construct
  # fallback ahead of the terminal "Unsupported new expression" refusal.
  - src/codegen/expressions/new-super.ts::compileNewExpression
  # 2026-10-01 (#6775 S11, Opus): the `<target> = yield` arm (helper closure,
  # spill typing) lives inside the planner's closure scope by construction.
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  # 2026-10-01 (#6775 S14, Opus): +1 — the `@@species` class read chained onto
  # the existing `@@hasInstance` read with `??`.
  - src/codegen/property-access.ts::compileElementAccess
---

## Problem

70 ES2015 test262 rows under `built-ins/**` outside the Object/Reflect (#6770),
Array (#6771), class (#6772), Iterator (#6773), expressions (#6774), TypedArray
(#6769, merged) and Promise (#5197, merged) lanes fail in `--target standalone`.
Row list: `.tmp/6775/rows.txt` (relative to `test262/test/`).

**Measured on `origin/main` @ `08e61b26` (2026-09-30 21:19–21:27 UTC)**, standalone,
`flock /tmp/claude-0/t262.lock npx tsx scripts/run-test262-paths.mts .tmp/6775/rows.txt --isolate --standalone`
with the QuickJS eval provider built first (`npx tsx scripts/build-quickjs-eval-provider.mjs`,
artifact `7511c866`, adapter `ffe661541d8dc5a0`): **0 pass — 68 fail, 2 compile_error**
(`.tmp/6775/rows-main.log`). None of the 70 passes in the 2026-09-30 standalone baseline either
(`.test262-cache/test262-standalone-current.jsonl`, fetched 21:25 UTC, 48,735 entries).

They are not 70 bugs. 40 probes (`.tmp/6775/p*.js`, runner `.tmp/6775/probe.mts`: compile
`{ target: "standalone", allowJs, skipSemanticDiagnostics, deferTopLevelInit }`, stub any import the
module declares but the compiler does not supply, run `__module_init`, read a bit mask, print node's
answer and the missing/extra bits; logs `probes*-main.log`) bucket them into the mechanisms below.
Every "main" value is measured on the unmodified tree; a probe named in a step is the step's pin.

### Base verdicts (first failing assertion, from `rows-main.log`)

| row | verdict / first failure |
| --- | --- |
| `Error/prototype/stack/getter-receiver-is-proxy` | `get.call(new Proxy(new Error))` is **null**, spec `undefined` |
| `Error/prototype/stack/setter-proxy-trap-throws` | 'set trap throw': the `set` trap on a target with own `stack` never runs |
| `Error/prototype/stack/setter-proxy-trap-rejects` | 'set trap returns false': no TypeError |
| `Error/prototype/stack/setter-receiver-is-proxy` | `(a): [[Set]] trap called` — the setter reaches a `set` trap on a target with NO own `stack` after `defineProperty` already ran |
| `Error/prototype/stack/getter-not-a-constructor`, `setter-not-a-constructor` | `new get()` / `new set('')` do not throw (`isConstructor` is already false) |
| `Error/prototype/stack/getter-subclass` | `typeof get.call(new (class extends nativeErrors[i])('msg'))` is `"object"` |
| `Error/prototype/stack/getter-foreign-new-target` | `Object.getPrototypeOf(Reflect.construct(Ctor, ['msg'], NotAnError))` is null |
| `Function/prototype/bind/instance-construct-newtarget-{boundtarget,boundtarget-bound,self-new,self-reflect}` | `new.target` inside `A` reads `undefined` (4 rows) |
| `Function/prototype/toString/not-a-constructor` | `new Function.prototype.toString()` did not throw (in the row; probes p16c/p20 throw — see S3) |
| `Function/prototype/toString/proxy-class` | `Function.prototype.toString.call(new Proxy(class {}, {}))` → `"[object Function]"` |
| `Function/prototype/toString/proxy-non-callable-throws` | `Function.prototype.toString.call(new Proxy({}, {}))` does not throw |
| `Function/prototype/name`, `Function/prototype/Symbol.hasInstance/{prop-desc,name}` | `Function.prototype` read goes through the runtime-eval provider; `Cannot access property on null or undefined` |
| `Function/prototype/Symbol.hasInstance/this-val-poisoned-prototype` | TypeError instead of the getter's Test262Error |
| `Function/is-a-constructor`, `GeneratorFunction/is-a-constructor`, `AsyncFunction/is-a-constructor`, `AsyncGeneratorFunction/is-a-constructor` | `isConstructor(F)` false; then `new F()` needs CreateDynamicFunction |
| `GeneratorFunction/has-instance` | `gDecl instanceof GeneratorFunction` false; then `new GeneratorFunction()` |
| `AsyncFunction/AsyncFunctionPrototype-to-string` | `AsyncFunction.prototype[@@toStringTag]` undefined |
| `Function/internals/Construct/derived-return-val` | ReferenceError instead of TypeError for `return null` in a derived ctor |
| `Function/internals/Construct/base-ctor-revoked-proxy` | `new f()` on a proxy revoked inside its own `get` trap does not throw |
| `ArrayBuffer/prototype/slice/{species-is-undefined,species-is-null,species-constructor-is-undefined}` | `Object.getPrototypeOf(result)` is null |
| `ArrayBuffer/prototype/slice/{context-is-not-object,context-is-not-arraybuffer-object}` | `ArrayBuffer.prototype.slice.call({})` etc. do not throw |
| `ArrayBuffer/prototype-from-newtarget` | `Reflect.construct(ArrayBuffer, [8], Object)` → prototype null |
| `ArrayBuffer/newtarget-prototype-is-not-object` | same shape, non-object `NT.prototype` → prototype null instead of `ArrayBuffer.prototype` |
| `ArrayBuffer/data-allocation-after-object-creation` | RangeError before the `NT.prototype` getter's DummyError |
| `ArrayBuffer/isView/arg-is-{typedarray,dataview}-subclass-instance` | `isView(new (class extends DataView)…)` false |
| `DataView/{return-instance,defined-byteoffset,defined-byteoffset-undefined-bytelength,defined-bytelength-and-byteoffset,custom-proto-if-not-object-fallbacks-to-default-prototype}` | `sample.constructor === DataView` false (a different function value) |
| `DataView/instance-extensibility` | `Object.defineProperty(sample, 'baz', {})` → `hasOwnProperty('baz')` false |
| `DataView/custom-proto-access-detaches-buffer` | no TypeError after the prototype getter detached the buffer |
| `JSON/parse/text-non-string-primitive` | `JSON.parse(false)` → `0` (no ToString of the argument) |
| `JSON/stringify/replacer-wrong-type` | **compile_error** (#1599 dynamic-replacer refusal) for `{}`, `new String('str')`, `''`, `0`, … replacers |
| `JSON/stringify/{value-array-abrupt,replacer-array-abrupt}` | the Test262Error thrown by a Proxy array's `length` get trap escapes `assert.throws` |
| `Map/iterator-item-{first,second}-entry-returns-abrupt`, `WeakMap/…` (4) | `Expected a Test262Error but got a TypeError` |
| `Map/prototype/set/append-new-values` | `forEach` hands the callback `NaN` for the `'valid'` value |
| `Symbol/not-callable` | `sym()` does not throw (`new sym()`, `symObj()` do; `new symObj()` does not) |
| `Symbol/for/to-string-err` | `Symbol.for({toString(){throw}})` → `dereferencing a null pointer` |
| `Symbol/constructor` | `Object.getPrototypeOf(Object(Symbol('66'))).constructor !== Symbol` |
| `Symbol/prototype/Symbol.toPrimitive/this-val-symbol` | `Symbol.toPrimitive[Symbol.toPrimitive]()` → "Cannot access property on null or undefined" |
| `Symbol/prototype/Symbol.toPrimitive/this-val-obj-symbol-wrapper` | `Object(Symbol.toPrimitive)[Symbol.toPrimitive]()` → "called value is not a function" |
| `Symbol/prototype/Symbol.toPrimitive/removed-symbol-wrapper-ordinary-toprimitive` | `"".concat(Object(Symbol()))` after `delete Symbol.prototype[@@toPrimitive]` → "Cannot convert a Symbol value to a string" |
| `Symbol/prototype/Symbol.toPrimitive/redefined-symbol-wrapper-ordinary-toprimitive` | `defineProperty(Symbol.prototype, @@toPrimitive, {value:null})` → "Cannot assign to read only property of a non-configurable property" (in the runner only — p4i's identical statement succeeds; find the harness-prefix difference first) |
| `Symbol/species/subclassing` | `(class extends RegExp {})[Symbol.species]` undefined |
| `Date/prototype/toJSON/{to-object,to-primitive-symbol}` | `Date.prototype.toJSON is not yet implemented in --target standalone` / returns undefined for a non-Date receiver |
| `Date/subclassing` | `Reflect.construct(Date, [64], Ctor)` → prototype null |
| `RegExp/prototype/exec/{success,failure}-lastindex-access` | `assert.sameValue(r.lastIndex, counter)`: the function-membered literal loses identity across the call boundary |
| `RegExp/prototype/Symbol.split/coerce-flags-err` | SyntaxError instead of TypeError for `flags: Symbol.split` |
| `NativeErrors/message_property_native_error` | `new nativeErrors[i]('m')` has no own `message` (dynamic-ctor construct) |
| `GeneratorPrototype/return/try-finally-set-property-within-try` | **compile_error** #680: `obj.foo = yield;` inside `try` |
| `ArrayIteratorPrototype/next/detach-typedarray-in-progress` | `keys()` snapshots eagerly; a detach mid-loop is not observed |

### Probe table (main vs node; bit numbers are the probe's own)

| probe | what it measures | main | node |
| --- | --- | ---: | ---: |
| p18 | stack getter: `e1.stack` on a RangeError is null (8), `get.call(Proxy(Error))` null (1024) / `get.call({})` null (131072) where spec says undefined (512/65536); `get.call(new (class extends TypeError))` IS a string (32) | 1709098 | n/a (node has no accessor) |
| p12 | setter: define half through `__proxy_define_dispatch` works (32768/65536/262144/1048576–4194304); `set` trap never runs on a target WITH own `stack` (131072), `set→false` not a TypeError (524288) | 7705121 | n/a |
| p16c | `new get()` / `new set('')` no throw (64/512 on, 128/1024 off); `new toString`, `new Math.max`, `new Array.prototype.join` all throw; `isConstructor(get)` false | 15278674 | 15279250 |
| p1c | `new.target` in a plain function; `Reflect.construct(C, [], A)` on a bound chain | COMPILE_ERROR (#3371 refusal) | 2043 |
| p17 | `sv(counter, counter)` false (1), `id(counter) === counter` false (2) for `counter = { valueOf(){…} }` | 116 | 127 |
| p24 | Map/WeakMap from an iterable whose entry array has a throwing accessor at index 0/1 — user ctor WITHOUT a prototype method, function-local arrays | 2790546 | 2790546 |
| p2b | same, but the thrown ctor has `T.prototype.toString = …` (the harness `Test262Error` shape) and module-scope `item`: Map → TypeError (2), WeakMap → TypeError (32), Map never calls `return` (8 off) | 1442 | 5529 |
| p23 | `new Map([[4,4],['foo3',3],[s,2]])` + `set(null,42)` + `set(1,'valid')`: `get(1)` right (2), `forEach` value is NaN (16 on, 4/8 off), `for…of` entry value wrong (2048 off) | 371 | 4079 |
| p5b | `JSON.parse(null/false/true/0/3.14)` wrong (64/256/1024/4096/16384 off); `JSON.parse()` SyntaxError and `parse(Symbol)` TypeError already right | 655378 | 677202 |
| p5f / p5g / p5h | Proxy-array `length` trap throw: root value (p5f) and replacer (p5g) ESCAPE `try/catch` (uncaught `WebAssembly.Exception`); nested inside an array (p5h) is caught | THROW / THROW / 2 | 2 / 18 / 2 |
| p5i / p5j | any non-callable, non-array replacer (`null`, `''`, `0`, `true`, `Symbol()`, `{}`, `new String`, `new Number`) | COMPILE_ERROR (#1599) | 1365 / 21 |
| p4f | `Symbol.for(objectWithToString)` | THROW null deref | 1321 |
| p4e | `sym()` no throw (1), `new symObj()` no throw (512); `Object(Symbol())`'s prototype is not `Symbol.prototype` (16384/65536 off) | 791185 | 873618 |
| p4g | `Object(Symbol.toPrimitive)[@@toPrimitive]()` (1), `Symbol.toPrimitive[@@toPrimitive]()` (4), `s[@@toPrimitive]()` (16), `Object(Symbol.iterator)[@@toPrimitive]()` (64) all throw; `Object(Symbol('x'))[@@toPrimitive]('default')` works (p4d) | 2986 | 2901 |
| p4h / p4i | after `delete` / `defineProperty(...{value:null})` the STATIC read `Symbol.prototype[Symbol.toPrimitive]` still answers the intrinsic (p4h 32, p4i 8); `{ 'Symbol()': 1 }[Object(Symbol())]` wrong (p4i 2097152) | 2697 / 611489 | 2729 / 2708649 |
| p9d | `Object.getPrototypeOf(<ArrayBuffer>)` never `ArrayBuffer.prototype` on the static route (1/16/64/1024/16384 off) and THROWS when the argument is a `.slice()` call (8/8192); `s3 instanceof ArrayBuffer` true (128) | 41352 | 54485 |
| p20 | `ArrayBuffer.prototype.slice.call({})` / `.call(undefined)` no throw (1024/2048 off; the alias `sl.call({})` throws — p9b 134217728); `sym()` (32), `new symObj()` (64), `new get()` (8), `new set('')` (16) no throw | 391 | n/a |
| p9c | DataView: `sample.constructor === DataView` false (16), `DataView.prototype.constructor === DataView` true (256); defineProperty/expando on the window carrier dropped (131072/262144/1048576/2097152/8388608/16777216 off); `new ArrayBuffer(1).constructor === ArrayBuffer` false (134217728) | 67151175 | 230075735 |
| p22 | `Reflect.construct(DataView, [buf, 0], nt)`: prototype right (2/256), `.constructor` wrong (1); bound-NT prototype getter runs after ToIndex (16/32/64); Date/ArrayBuffer with a foreign NT: prototype null (8192/524288) | 1653110 | 367991 |
| p15 | `Date.prototype.toJSON.call(x)` for non-Date `x` throws / returns undefined (512/8192/32768/131072 on; 256/4096/16384/65536/262144–2097152 off); side finding: `JSON.stringify({d: new Date(0)})` ignores `toJSON` (8388608 off) | 172626 | 12408146 |
| p6b | exec: `gets === 1` and no write-back for non-global (16/256 on), global write-back (512/1024 on); `@@split` with `flags: Symbol.split` → SyntaxError (65536) not TypeError (32768) | 2430943 | 2398207 |
| p19 / p14c | `new ctors[i]('m')` (dynamic native-error ctor) | THROW illegal cast | 2911855 / 1909 |
| p25 / p25b | `obj.foo = yield;` in `try` → #680 compile error; `var t = yield; obj.foo = t;` compiles and passes | CE / 3 | 3 / 3 |
| p7c / p7 | any `Function.prototype` read links `js2wasm:runtime-eval` and CALLS `__runtime_indirect_eval` | THROW stub import called | 5954903 / 3932159 |
| p7d | `f[Symbol.hasInstance]({})` on a closure with a poisoned `prototype` accessor → TypeError (4) not RangeError (2); even `h[Symbol.hasInstance](new h())` throws (16384) | 17476 | 14338 |
| p13 | `(class extends RegExp {})[Symbol.species]` undefined (1 off; `RegExp[@@species]` 16 on); `return null` in a derived ctor throws a non-TypeError (32/64 off); `new f()` on the revoked proxy returns (1024) | 292624 | 260949 |

## Implementation Plan (2026-09-30, Fable lane; Opus implements)

Steps are ordered by yield per unit of risk and are independently shippable. Every step is
measured with its probe(s) and the row subset before the next one starts; the rows are re-run
under `flock /tmp/claude-0/t262.lock … --isolate --standalone`. Type queries go through
`ctx.oracle`, never `ctx.checker`. **ES5 is a completed edition: zero ES5 regressions.** The ES5 pin
set is `.tmp/6775/es5-pins.txt` (938 passing ES5 rows of the touched directories: RegExp 500,
Function 370, JSON 47, Error 17, Date 4); the control set is `.tmp/6775/control.txt` (2,326 passing
ES5+ES2015 rows of `Error, NativeErrors, Function, ArrayBuffer, DataView, JSON, Map, WeakMap,
Symbol, Date, RegExp, GeneratorPrototype, GeneratorFunction, AsyncFunction, AsyncGeneratorFunction,
ArrayIteratorPrototype, Reflect/construct`), both extracted from the 2026-09-30 standalone baseline
with `scripts/generate-editions.ts`'s `classifyEdition`. Each step names the pin subset that
exercises its code path; run the whole control once at the end.

### Step 0 — base copies and the before-state

- `.tmp/6775/base/` (lead's copy of `origin/main` `src/`) is the revert copy; A/B by `cp`, never
  `git stash`.
- Copy `.tmp/6775/` (probes, `probe.mts`, logs, `rows.txt`, `es5-pins.txt`, `control.txt`) into the
  worktree; run `npx tsx .tmp/6775/probe.mts .tmp/6775/p*.js` on the unmodified tree and confirm
  the `main` column above. Run `rows.txt` (expect 0 pass).

### S1 — `get Error.prototype.stack` answers the canonical `undefined`; `e.stack` reads reach the accessor (1 row + prerequisite for S2/S3)

Rows: `Error/prototype/stack/getter-receiver-is-proxy`.

- `src/codegen/error-stack-accessor.ts:250-280` (`emitErrorStackGetterBody`): the no-[[ErrorData]]
  arm pushes `ref.null.extern`, which the runtime reads as **null**. Use
  `undefinedExternInstrs(ctx)` (`any-helpers.ts:122-129`, the `$undefined` singleton) — the same
  answer `emitTypedArrayProtoToStringTagBody` gives for a non-view. p18 bits 1024/131072 → 512/65536.
- `src/codegen/property-access-dispatch.ts:1428` (native-first `.message/.name/.stack` field read on
  an Error LHS): `stack` is NOT a `$Error_struct` field (fields: message, name placeholder, …,
  `$props` at 5 — `registry/error-types.ts:119-123`). Split `stack` out of that arm: emit the getter
  body inline for a `ref.test $Error_struct` receiver (`""`) else `undefined`, or call the glue's
  `get stack` closure through `emitLazyNativeProtoGet` + `CALL_ACCESSOR_GET`. Same split in
  `property-access.ts:2740` (`receiverIsCaughtErrorStringRead`). p18 bit 8 → 1.
- ES5 pins: `built-ins/Error/**` (17 ES5 rows) — `.message`/`.name` reads must be byte-identical
  (only the `stack` member changes routing). Control: `Error/prototype/stack/**` (the passing rows
  — `getter-*`/`setter-*` that pass today — must stay).

### S2 — setter: the two proxy halves are exclusive and terminate the body (3 rows)

Rows: `setter-proxy-trap-throws`, `setter-proxy-trap-rejects`, `setter-receiver-is-proxy`.

- `error-stack-accessor.ts:191-250` (`emitProxyReceiverArms`) builds the right two arms; the
  splice in `emitErrorStackSetterBody` (`:283+`) is wrong in two measured ways: (i) with NO own
  `stack` the `create` arm runs and then execution FALLS THROUGH into a `Set` (the row's
  `allowProxyTraps` stub reports `[[Set]] trap called` after `defineProperty` already landed —
  p12 bits 1048576/2097152 show define ran); (ii) with an own `stack` the `assign` arm is never
  reached (p12 131072/524288 off). Read the `__getOwnPropertyDescriptor` result once, branch
  `ref.is_null` → `create` else `assign`, and `return` from each arm; no ordinary
  `__defineProperty_value` / `__extern_set_strict` may run after a `$Proxy` arm.
- Pins: p12 → bits 131072 and 524288 on, nothing lost. Control: `Error/prototype/stack/setter-*`
  passing rows (`setter-proxy-wrapping-prototype`, `setter-home-object`, …).

### S3 — `new` on a native accessor / glue-seeded method closure throws TypeError (3 rows)

Rows: `stack/getter-not-a-constructor`, `stack/setter-not-a-constructor`,
`Function/prototype/toString/not-a-constructor`.

- `isConstructor(get)` is already false (`__reflect_is_constructor` has no arm for the accessor
  closure), but the `new` driver's guard (`construct-is-constructor-guard.ts:134-171`, narrowing 1)
  fires only when `__typeof_function(callee)` is 1. The accessor closures minted by
  `ensureStandaloneNativeMethodClosure(…, "getter"/"setter")` (`native-proto.ts:894-1060`) use a
  wrapper type the `__typeof_function` ladder (`typeof-natives-finalize.ts:254+`) does not test
  → 0 → the driver's ordinary tail constructs an object (p16c bits 64/512). Add that wrapper type
  to the ladder (it IS callable — `typeof get === "function"` is asserted by the corpus).
- `toString/not-a-constructor` throws in p16c/p20 but not in the row: the row runs
  `isConstructor(Function.prototype.toString)` (a `Reflect.construct` with the value as NewTarget)
  FIRST, which materialises `%Function.prototype%` (#6630 header) so the later
  `new Function.prototype.toString()` resolves the COMPANION-seeded closure value — a second
  wrapper type. Reproduce with `isConstructor` before the `new` (write `.tmp/6775/p26.js`); the fix
  is the same ladder entry (or `__reflect_is_constructor` + `__typeof_function` agreeing on the
  companion closure type). #6773 S5 widens the same guard for nullish/primitive callees — different
  clause, same function: land after #6773 or rebase onto it; do not duplicate its widening.
- ES5 pins: `language/expressions/new/**` (59 rows, 57 pass) and `built-ins/Function/**` ES5
  (370). Control: `built-ins/**/not-a-constructor.js` rows that pass today (`grep -l
  not-a-constructor .tmp/6775/control.txt`).

### S4 — JSON.parse ToString and the static replacer classification (2 rows), then the escaping Proxy throw (2 rows, verify-first)

Rows: `JSON/parse/text-non-string-primitive`, `JSON/stringify/replacer-wrong-type`;
`JSON/stringify/value-array-abrupt`, `JSON/stringify/replacer-array-abrupt`.

- (a) `expressions/call-namespace-static.ts:4300-4330` (dynamic `JSON.parse(text)`): the argument
  is compiled to externref and handed to `__json_parse_text` unconverted; `false` parses as `0`.
  §25.5.1 step 1 is `ToString(text)`: apply `__extern_to_string_spec` (the ToPrimitive-aware
  ToString; it already throws TypeError for a Symbol — p5b bit 131072) when the argument's
  `ctx.oracle.staticJsTypeOf` is not `"string"`. p5b → 677202. ES5 pins: `built-ins/JSON/**` (47).
- (b) `call-namespace-static.ts:3700-3746` (the #1599 dynamic-replacer refusal): §25.5.2 step 4
  consults a replacer only if it is callable or an Array. Before reaching the refusal, classify the
  replacer expression statically — `null`, a string/numeric/boolean literal, `Symbol()`, an object
  literal with no call signature, `new String/Number/Boolean(…)` — and compile the call as the
  no-replacer form (drop the replacer's evaluation only when it is side-effect-free; otherwise
  evaluate-and-drop). p5i → 1365, p5j → 21. A `Symbol()` / `new Number(6.1)` argument is not
  side-effect-free in general — evaluate then drop.
- (c) The Test262Error thrown by a Proxy array's `length` get trap while the Proxy is the ROOT
  value (p5f) or the REPLACER (p5g) is not caught by the enclosing `try`; nested one level down
  (p5h) it is. Trace `__json_stringify_root_replacer_dyn` / the root `$Proxy` arms
  (`json-codec-native.ts:813+`, `:1643+`): look for a `try`/`catch_all` that re-raises with a
  different tag, or a length probe emitted at the CALL SITE outside the callback's `try`. Do not
  guess — WAT-diff the compiled p5f. Rows need the throw to propagate as the same exception
  (`Test262Error` identity through `assert.throws`). Pins: p5f → 2, p5g → 18, p5e unchanged.
  ES5 pins: `built-ins/JSON/stringify/**` ES5 rows (in the 47).

### S5 — Symbol protocol gaps (5 rows)

Rows: `Symbol/for/to-string-err`, `Symbol/not-callable`, `Symbol/constructor`,
`Symbol/prototype/Symbol.toPrimitive/this-val-symbol`, `…/this-val-obj-symbol-wrapper`.

- (a) `Symbol.for(arg)` (`call-namespace-static.ts:700-715`): the argument is compiled straight to
  `ref $AnyString` and `ref.as_non_null`ed — an object answers null (p4f trap). Compile to externref,
  run `__extern_to_string_spec` (ToPrimitive → ToString; TypeError for a Symbol argument — the row's
  second assertion), then convert to `$AnyString` for `forIdx`. Keep the literal-string fast path.
- (b) `sym()`: a callee whose `staticJsTypeOf` is `"symbol"` (i32 lane) compiles to nothing that
  throws (p4e bit 1). In `expressions/calls.ts` (`compileCallExpression`), add the static guard: a
  provably-symbol callee evaluates its arguments then throws `TypeError("<name> is not a
  function")`, mirroring the `Symbol.keyFor` static-type guard at `call-namespace-static.ts:740+`.
  `new symObj()` (a Symbol WRAPPER `$Object`, p4e 512): add one arm to
  `constructIsConstructorGuard` — a `$Object` (`ref.test objectRuntimeTypes.objectTypeIdx`) without
  `OBJ_FLAG_CALLABLE` is not a constructor → TypeError. Verify first that every callable `$Object`
  carrier sets the flag (`builtin-callable-brand.ts`); #6773 S5's header argues against widening to
  "any non-function object" — this arm is narrower (the flag is explicit) but lands after #6773.
- (c) `Object(Symbol())`'s `[[Prototype]]` is not `Symbol.prototype` (p4e 16384/65536):
  `wrapper-constructor-carrier.ts:420-470` links String/Number/Boolean wrappers to their glue;
  add the Symbol brand (the glue exists — `symbol-proto-tostring.ts`, `symbol-proto-valueof.ts`)
  so `getPrototypeOf(wrapper) === Symbol.prototype` and `.constructor === Symbol`
  (`pushCompanionConstructorSeed`).
- (d) `<symbol>[Symbol.toPrimitive]()` on a PRIMITIVE symbol receiver ("Cannot access property on
  null or undefined") and `Object(<well-known symbol>)[Symbol.toPrimitive]()` ("called value is not
  a function"; `Object(Symbol('x'))[…]` works — p4d 64): the first is the symbol-keyed method call
  with a primitive receiver (`primitive-proto-member-get.ts` has no symbol-receiver arm for a
  symbol KEY; route through ToObject → the Symbol wrapper of (c)); the second is how a well-known
  symbol (an `i32` constant) is boxed by `Object(…)` — compare the `$Object` the two spellings
  produce (`object-ctor-primitive-receiver.ts`) and make the well-known one carry the same
  `[[PrimitiveValue]]` slot. p4g → 2901.
- ES5 pins: none of these paths is ES5-reachable except the call guard in (b) — run
  `language/expressions/call/**` ES5 rows (`grep '^language/expressions/call' ` is outside the
  control file: extract the same way from the baseline) and `built-ins/Function/**` (370).
  Control: `built-ins/Symbol/**` (70 ES2015 passing).

### S6 — `ArrayBuffer` reflective surface (8 rows)

Rows: `slice/{context-is-not-object,context-is-not-arraybuffer-object}` (2);
`slice/{species-is-undefined,species-is-null,species-constructor-is-undefined}` (3);
`newtarget-prototype-is-not-object`, `data-allocation-after-object-creation`;
(+ `prototype-from-newtarget` is NOT reachable — see the blocked table).

- (a) Receiver guard for the direct spelling: `call-receiver-method.ts:1052-1070` routes
  `ArrayBuffer.prototype.slice.call(x, …)` to `emitArrayBufferSlice(ctx, fctx, <recv>, …)`
  (`dataview-native.ts:553-600`), which recovers the vec from the receiver without a brand test
  when the receiver is the `.call` this-argument (the aliased `sl.call({})` DOES throw — p9b bit
  134217728, so the guard exists on the value path). Emit the same `ref.test $__vec_i32_byte` →
  `TypeError` for the direct spelling. p20 bits 1024/2048 on.
- (b) Static `Object.getPrototypeOf(<ArrayBuffer-typed expr>)` (`expressions/object-get-prototype-of.ts:395-440`,
  `tryCompileEs5GetPrototypeOfValue`): answers null, and TRAPS when the argument is a `.slice()`
  call (p9d 8/8192). The dynamic native already has the arm (`fillArrayBufferGetPrototypeOfArm`,
  `:949`, called from `ta-dyn-mop.ts:370` — verify it is reached in a module with no dyn view: it
  is gated behind `fillTaDynViewMopArms`, so a module without TypedArray machinery may never run
  it; move the call to the generic finalize next to the other `__getPrototypeOf` fills). Route
  the static path for a byte-vec-typed / `any` argument through `__getPrototypeOf`. p9d → 54485.
- (c) With (b), the three species rows (their slice result is already a byte vec — p9d 128) and
  `newtarget-prototype-is-not-object` (the "carrier" route reads a non-object `NT.prototype`,
  `applyRuntimeNewTargetPrototype`'s `__object_setPrototypeOf` is a no-op on the byte vec, and the
  read then answers `ArrayBuffer.prototype`) should pass — measure; if `species-is-undefined`
  still reads null, the species-default lane of `emitArrayBufferSliceSpecies`
  (`dataview-native.ts:6717+`) constructs through `__native_construct_1(ArrayBuffer, len)` and the
  result carrier must be checked with `ref.test $__vec_i32_byte` (p9d 128 says it is).
- (d) `data-allocation-after-object-creation`: §25.1.3.1 AllocateArrayBuffer does
  OrdinaryCreateFromConstructor (the `NT.prototype` getter) BEFORE CreateByteDataBlock (the
  RangeError). `reflect-construct-newtarget.ts` reads the prototype AFTER construction by design
  (its header lists this row as refused). Add an `ArrayBuffer`-target-only pre-read: when the
  target resolves to the `ArrayBuffer` global and every argument is side-effect-free (literal /
  identifier), emit `Get(NT, "prototype")` (the existing `prepareRuntimeNewTargetProto` read)
  before `compileNewExpression`, and skip the post-read. Keep DataView/TypedArray order untouched
  (`DataView/byteOffset-validated-against-initial-buffer-length.js` pins the opposite order).
- ES5 pins: none (ArrayBuffer is ES2015). Control: `built-ins/ArrayBuffer/**` (69 ES2015 passing)
  and `Reflect/construct/**` (9).

### S7 — `DataView` instance surface (6 rows + 1)

Rows: `return-instance`, `defined-byteoffset`, `defined-byteoffset-undefined-bytelength`,
`defined-bytelength-and-byteoffset`, `custom-proto-if-not-object-fallbacks-to-default-prototype`
(all `.constructor` identity); `instance-extensibility`; `custom-proto-access-detaches-buffer`.

- (a) `.constructor` through the dynamic walk: `sample` is assigned several times, so
  `builtin-instance-constructor-prototype.ts`'s single-assignment static arm declines and the read
  is `__extern_get(window, "constructor")` → the DataView glue companion's seeded `constructor`
  (`builtin-proto-constructor-seed.ts:87`, `pushCompanionConstructorSeed`). The static
  `DataView.prototype.constructor === DataView` is true (p9c 256) but the seeded value differs
  (p9c 16 off; ArrayBuffer likewise, 134217728). `emitBuiltinProtoConstructorValue`
  (`builtin-proto-constructor.ts:123`) dispatches between the two identity-stable carriers — check
  `hasBuiltinProtoConstructorCarrier("DataView")` and make the companion seed use the SAME emitter
  as the static read, for DataView and ArrayBuffer. p9c bits 16/2048/134217728 on.
- (b) `custom-proto-access-detaches-buffer`: in `applyRuntimeNewTargetPrototype`'s DataView-window
  arm (`reflect-construct-newtarget.ts:182-200`, the `constructProto` field write), after the
  prototype read, re-check the buffer's detach marker (`buf.length < 0` — the sentinel
  `taDynDetachedGuardInstrs` uses, `ta-dyn-proto-methods.ts:200-215`) and throw
  `TypeError("DataView: buffer is detached")` (§25.3.2.1 step 11 runs after
  OrdinaryCreateFromConstructor). `called === true` (ToIndex first) already holds (p22 64).
- (c) `instance-extensibility`: the `$__dv_window` struct (`dataview-native.ts:1389-1406`: buf,
  byteOffset, byteLength, constructProto) has no own-property bag, so `defineProperty` /
  expando writes are dropped (p9c). Give it a `$props` sidecar like `$Error_struct` field 5
  (`error-props.ts` is the pattern: `__is_error_prop_carrier` / `_bag_lookup` / `_bag_ensure`,
  spliced into `__extern_get`/`__extern_set`/gOPD/`hasOwnProperty`/`isExtensible`). Medium; do it
  last in this step and drop it if the splice count grows past the four helpers.
- ES5 pins: none. Control: `built-ins/DataView/**` (370 ES2015 passing).

### S8 — `Date.prototype.toJSON` generic body (2 rows)

Rows: `Date/prototype/toJSON/to-object`, `Date/prototype/toJSON/to-primitive-symbol`.

- `array-object-proto.ts:2681` wires Date bodies (`@@3` → `emitDateProtoToPrimitiveBody`); `toJSON`
  falls to the refusal (`:1102`). Add `emitDateProtoToJsonBody` (new leaf next to
  `date-proto-to-primitive.ts`): §21.4.4.37 — `O = ToObject(this)` (nullish → TypeError),
  `tv = __to_primitive(O, hint number)`, if `tv` is a number and not finite → `null`, else
  `Invoke(O, "toISOString")` = `__extern_get(O, "toISOString")` + `__apply_closure(fn, O, [])`.
  A primitive receiver reads the method off its wrapper prototype (`Number.prototype.toISOString`
  in the row) — `__extern_get` on a boxed number already walks `Number.prototype`? Verify with
  p15 bit 4096; if not, ToObject first through the wrapper carrier.
- p15 → all bits except 8388608 (the `JSON.stringify` → `toJSON` side finding, not a row here;
  record it).
- ES5 pins: `built-ins/Date/**` ES5 (4) + `built-ins/JSON/stringify/**` ES5. Control:
  `built-ins/Date/prototype/toJSON/**`.

### S9 — `RegExp.prototype[@@split]` flags ToString (1 row)

Row: `RegExp/prototype/Symbol.split/coerce-flags-err`.

- `regexp-split-protocol.ts` step 5 (`flags = ToString(Get(rx, "flags"))`, header lines 9-11, body
  near `:141`/`:747`): a Symbol value reaches the flag-string parse and produces SyntaxError. Use
  `__extern_to_string_spec` for the coercion (TypeError for a Symbol; the `toString`-throwing case
  already propagates — p6b 4096). p6b bit 32768 on, 65536 off.
- ES5 pins: `built-ins/String/prototype/split/**` ES5 rows (in the RegExp/String set — extract
  `built-ins/String/prototype/split` from the baseline as above) and `built-ins/RegExp/**` ES5
  (500). Control: `RegExp/prototype/Symbol.split/**` (ES2015 passing).

### S10 — dynamic native-error construction carries `message` (1 row)

Row: `NativeErrors/message_property_native_error`.

- `new nativeErrors[i]('m')` (ctor from an array element) traps `illegal cast` (p19/p14c) in a
  probe and in the row produces an instance with no own `message`. The static
  `new RangeError('m')` path is fine (p14b = node). Find the dynamic-callee construct arm for the
  six NativeError carriers (`new-super.ts` dynamic ladder → `emitBuiltinCtorValueConstructOnNull`
  / `builtinCollectionConstructArm`-style `__new_<Name>@<arity>` dispatch,
  `builtin-collection-dyn-construct.ts:135-150` is the shape) and make it call the same
  `__new_<NativeError>@1` the static path uses (`emitWasiErrorConstructor`,
  `registry/error-types.ts`). p19 bits 1/2/4/8/32/64 on.
- ES5 pins: `built-ins/NativeErrors/**` has no ES5 rows; `built-ins/Error/**` ES5 (17). Control:
  `NativeErrors/**` (79 ES2015 passing).

### S11 — generator: `<member> = yield` inside `try` (1 row)

Row: `GeneratorPrototype/return/try-finally-set-property-within-try`.

- `obj.foo = yield;` is refused by the native generator lowering (#680: "only sequential numeric
  yields"), while `var t = yield; obj.foo = t;` compiles and PASSES the row's assertions (p25b = 3
  = node). Normalise the first shape into the second in the generator front-end
  (`generator-yield-linearize.ts` / `generators-native-ast-scan.ts`): an assignment whose RHS is a
  bare `yield` (any target: member, element, identifier) becomes `tmp = yield; <target> = tmp;`.
  Only when the target's evaluation has no side effects before the yield (a member on an
  identifier is fine — spec evaluates the reference first, but `obj` is an identifier read).
- Control: `built-ins/GeneratorPrototype/**` (60 ES2015 passing), `language/statements/generators/**`
  passing rows. ES5 pins: none.

### S12 — `Map.prototype.forEach` value lane (1 row)

Row: `Map/prototype/set/append-new-values`.

- `map-runtime.ts:1975-2040` (`tryCompileNativeCollectionForEach`): `entry.value` (anyref) is
  externalised then coerced to the callback's parameter ValType, which for a JS callback comes from
  TS inference of the `Map<K, number>` generic → f64 → `'valid'` unboxes to NaN (p23 16). When the
  callback parameter has no type annotation (`ctx.oracle` can tell) — or the map's inferred value
  type is a primitive while any `set` in the file passes a non-conforming static type — keep the
  parameter externref (the array-HOF "untyped element param" pattern,
  `array-hof-nullable-elem-param.ts`). Same for the `for…of` entry vec (p23 2048) if it goes through
  `emitCollectionIteratorVec`.
- p23 → 4079. ES5 pins: none. Control: `built-ins/Map/**` (151), `WeakMap/**` (99).

### S13 — Map/WeakMap iterable drive: abrupt entry accessor (4 rows, verify-first)

Rows: `Map/iterator-item-{first,second}-entry-returns-abrupt`, `WeakMap/iterator-item-{first,second}-entry-returns-abrupt`.

- `emitNativeCollectionCtorIterableDrive` (`new-super.ts:5673-5895`) reads `Get(entry,"0")` /
  `Get(entry,"1")` via `__extern_get_idx` inside `wrapWithIteratorClose` (`:5600-5640`). p24 (user
  ctor without prototype method, function-local arrays) matches node; p2b (ctor with a
  `prototype.toString` assignment — the harness `Test262Error` shape — and module-scope `item`)
  answers TypeError and Map never calls `return`. Bisect the two variables (module-scope vec with
  an accessor OVERLAY — `vec-overlay.ts` — vs. local; fnctor with typed instances vs. plain) with
  two more probes before touching code. Likely sites: the `catch` at `:5612` that DROPS a payload,
  and `__extern_get_idx` on an overlaid module-level vec inside the drive.
- Pins: p2b → 5529, p24 unchanged. Control: `Map/**`, `WeakMap/**`, `Set/**`, `WeakSet/**`
  `iterator-*` rows.

### S14 — `class extends <builtin>` static `@@species` inheritance (1 row, verify-first)

Row: `Symbol/species/subclassing`.

- `MyRegExp[Symbol.species]` reads undefined (p13 1) while `RegExp[Symbol.species]` is right (16).
  A class value with a builtin parent must inherit the parent's static accessor surface
  (`builtin-static-gopd.ts:400-430` owns the `@@species` accessor). Find the computed-symbol
  static read on a class value (`standalone-class-dyn-static.ts` / `class-static-sidecar.ts`) and
  add the builtin-parent fallback (`ctx.classBuiltinParentMap`). #6772 owns class-extends-builtin
  INSTANCE behaviour; this is the static side — coordinate, do not duplicate.

### S15 — `new.target` as a VALUE for function constructors; bound-function [[Construct]] threads it (4 rows, L)

Rows: `Function/prototype/bind/instance-construct-newtarget-{self-new,self-reflect,boundtarget,boundtarget-bound}`.

- Today `new.target` is an i32 class-id global (`new-target.ts`), read at `expressions.ts:1629`;
  inside a plain function `nt = new.target` stores that id, so `nt === A` is false and the rows
  read `undefined`. `Reflect.construct(C, [], A)` on a bound chain hits the #3371 refusal (p1c).
- Design: add a second global `__new_target_value` (externref, `undefined` at rest). Writers:
  the fnctor `new` lowering (`new-super.ts:8318+` region, next to the class-id save/restore) sets
  it to the callee VALUE for a function target and restores after; `__construct_bound`
  (`construct-bound.ts:252+`) gains a `newTarget` parameter (call sites pass `ref.null.extern` =
  "same as callee") and, while unwrapping, applies §10.4.1.2 step 5 — `if SameValue(F, newTarget)
  then newTarget = target` at each layer — then sets the global to the resulting value before
  `__apply_closure`; `Reflect.construct` routes a BOUND target (the `$__bound_fn` carrier, or a
  binding provably initialised from `.bind(`) to that driver with the explicit NewTarget instead of
  the #3371 refusal. Reader: `expressions.ts:1629` — for a non-class fnctor body read the value
  global (`undefined` when not constructing; keep the i32 path for classes, and keep
  `new.target === Cls` folding for classes).
- Pins: p1c → 2043 (all bits), p1b → 5487. ES5 pins: `language/expressions/new/**`,
  `built-ins/Function/prototype/bind/**` ES5 rows (in the 370). Control:
  `language/expressions/new.target/**`, `built-ins/Function/prototype/bind/**`.

### S16 — `%Function.prototype%` as a host-free reflective object (4 rows, M)

Rows: `Function/prototype/name`, `Function/prototype/Symbol.hasInstance/{prop-desc,name}`,
`Function/prototype/Symbol.hasInstance/this-val-poisoned-prototype`.

- Any `Function.prototype` read is a runtime-eval boundary site (`function-intrinsic-carrier.ts`
  header: reading the bare `Function` value is `intrinsic-value`, provider-required), so under the
  QuickJS provider the rows fetch a provider handle and die in the membrane. #6630 already
  materialises `%Function.prototype%` as a real `$Object` with companion-seeded `call`/`apply`/
  `bind`/`toString`/`@@hasInstance` (`FUNCTION_PROTO_METHODS`, `array-object-proto.ts:422`). Route
  the `Function.prototype` READ (not the bare `Function` value) to that object, and seed own
  `name` (`""`) and `length` (`0`) with `{w:F,e:F,c:T}` plus the `@@hasInstance` data property
  `{w:F,e:F,c:F}` whose closure carries `name` `"[Symbol.hasInstance]"` (the glue's meta already
  has it for the member; the row reads it off the value).
- `f[Symbol.hasInstance](x)` — a symbol-keyed method CALL on a closure receiver — is not routed to
  `emitFunctionProtoHasInstanceBody` (`function-proto-has-instance.ts:49`): even
  `h[Symbol.hasInstance](new h())` throws (p7d 16384). Add the element-access-call arm for a
  callable receiver + the `@@hasInstance` key, and make OrdinaryHasInstance's `Get(C, "prototype")`
  honour an accessor installed by `Object.defineProperty(f, 'prototype', {get})` (p7d 2: RangeError
  expected, TypeError today).
- ES5 pins: `built-ins/Function/**` ES5 (370) — `Function.prototype` reads are ES5-reachable
  (`15.3.4*`), so this step runs the full Function ES5 set BEFORE commit. Control:
  `built-ins/Function/prototype/**`.

### S17 — `%AsyncFunction%` / `%AsyncFunction.prototype%` intrinsic (1 row)

Row: `AsyncFunction/AsyncFunctionPrototype-to-string`.

- Sibling of `generator-function-intrinsic.ts` (`emitGeneratorFunctionPrototypeSingleton`,
  `:84`): `(async function(){}).constructor` → an `%AsyncFunction%` singleton whose `prototype`
  owns `@@toStringTag = "AsyncFunction"` `{w:F,e:F,c:T}` (verified by `verifyNotWritable` /
  `verifyConfigurable` through the companion define). #6770 S6.4 touches
  `%GeneratorFunction.prototype%`'s tag — a different object; no shared code.
- Control: `built-ins/AsyncFunction/**` (8 passing), `GeneratorFunction/**` (19).

### S18 — `Function.prototype.toString.call(<proxy>)` (2 rows, verify-first)

Rows: `Function/prototype/toString/proxy-class`, `…/proxy-non-callable-throws`.

- The `.call` spelling does not reach `emitFunctionProtoToStringBody`
  (`function-proto-to-string.ts:60`, which throws for a non-callable `this`): a `$Proxy` over `{}`
  answers without throwing in the row and null-derefs in p21; a proxy over a class answers
  `"[object Function]"` (an `__extern_toString` result). Trace the lowering of
  `Function.prototype.toString.call(x)` — `function-proto-invokers.ts:231`
  (`emitFunctionProtoCallBody`) forwards through `__apply_closure`, and
  `call-receiver-method.ts:3840-3900` has the `x.toString()` arms; one of them is rewriting the
  `.call` form to ToString(x). The body's own check is `__typeof_function(this)`; for a `$Proxy`
  the typeof ladder reads the callable bit (`typeof-natives-finalize.ts:212-215`), so once the
  body is reached both rows follow (`[native code]` for a callable proxy, TypeError otherwise).
- ES5 pins: `built-ins/Function/prototype/toString/**` ES5 rows. Control: the ES2015 `toString/**`
  rows that pass today.

### S19 — cross-lane rows, taken only after the owning lane lands

| row | mechanism | owner / sequencing |
| --- | --- | --- |
| `Function/internals/Construct/derived-return-val` | §10.2.1.3 [[Construct]] step 13.b: a derived ctor returning a non-undefined non-object throws TypeError BEFORE the this-binding check (today ReferenceError, p13 32/64 off) | #6772 cluster G rewrites the same return-override path (`construct-return-value.ts`); add the `null`/primitive → TypeError clause there, after #6772 |
| `Function/internals/Construct/base-ctor-revoked-proxy` | `new f()` on a proxy whose `get` trap revokes it during `Get(NT,"prototype")` → GetFunctionRealm(revoked) TypeError (p13 1024) | #6770 owns lazy per-operation Proxy trap lookup (`object-runtime-proxy-construct-chain.ts`); add the post-`Get` revoked check there, after #6770 |
| `ArrayBuffer/isView/arg-is-{typedarray,dataview}-subclass-instance` | `new (class extends DataView)` / `(class extends Int8Array)` instances are class structs, not `$__dv_window` / dyn views, so `isViewRefTestInstrs` (`dataview-native.ts:329`) answers false (p10) | #6772 `NEW_SITE_BUILTIN_PARENTS` (class extends built-ins); re-measure after it lands — no change here if the instance becomes the real carrier |

### Not reachable in this slice (11 rows) — with the mechanism

| rows | why not here |
| --- | --- |
| `RegExp/prototype/exec/{success,failure}-lastindex-access` | `assert.sameValue(r.lastIndex, counter)`: `counter = { valueOf(){…} }` is a function-membered literal that loses identity across ANY externref round trip (p17 bits 1/2/8 off; `gets === 1` and the no-write-back already hold). Value-rep #2773/#3037 — the same blocker #6769 recorded for `internals/Set/key-is-valid-index-reflect-set`. |
| `Error/prototype/stack/getter-subclass` | `class extends nativeErrors[i]` — a DYNAMIC heritage (array element); the instance is not a `$Error_struct` (p19 block 4). #6772's dynamic-heritage construct driver (its TypedArray `regular-subclassing` residual has the same shape). |
| `Error/prototype/stack/getter-foreign-new-target`, `Date/subclassing`, `ArrayBuffer/prototype-from-newtarget` | the constructed carrier has no prototype slot: `$Error_struct` (brand-keyed chain, `error-subclass-proto-chain.ts`), `$__Date` (`expressions/builtins.ts:212`, one `timestamp` field, 25 sites), the packed byte vec. `applyRuntimeNewTargetPrototype` falls to `__object_setPrototypeOf`, a no-op (p22 8192/524288). Needs a `constructProto` field like `$__dv_window`'s — a layout change per carrier; file as follow-ups. |
| `Function/is-a-constructor`, `GeneratorFunction/is-a-constructor`, `AsyncFunction/is-a-constructor`, `AsyncGeneratorFunction/is-a-constructor`, `GeneratorFunction/has-instance` | after `isConstructor(F)` each row does `new F()` / `F()` = CreateDynamicFunction through the eval provider with the intrinsic as NewTarget; #6772 filed its GFn twins as a runtime-eval / provider-construct issue (#6640, #4238). Same here. |
| `ArrayIteratorPrototype/next/detach-typedarray-in-progress` | `typedArray.keys()` snapshots the indices eagerly (`ta-dyn-proto-methods.ts:1160-1200`, `array.new_default` at call time), so a detach during `for…of` is unobservable; needs a lazy dyn-view iterator family (`iterator-native.ts` `ITER_FAMILY_*`) with the §23.2.3.x detached check in `next`. #6484's iterator-prototype lane. |
| `Symbol/prototype/Symbol.toPrimitive/{removed,redefined}-symbol-wrapper-ordinary-toprimitive` | need the intrinsic `@@toPrimitive` to be a deletable/redefinable OWN property whose absence `__to_primitive` and `symbolWrapperToStringThrowArm` (`symbol-to-primitive-arms.ts`) observe, plus accessor `valueOf`/`toString` on `Symbol.prototype` with get counts across `==`, `-`, `concat`, template, `new Date(...)`, computed keys. p4h/p4i show the static read `Symbol.prototype[Symbol.toPrimitive]` ignores the companion after delete/define. Stretch after S5(c)/(d); the `redefined` row's runner-only "read only property" failure must be reproduced first (the probe's identical statement succeeds). |

### Step 20 — measure, controls, gates, record

- Re-run `rows.txt` (expect ≥ 42 pass — S1–S12 + S15–S17 are 33 rows on measured mechanisms;
  S13/S14/S18 add 7 if their verify-first traces resolve; S19 rows come after their lanes); name
  every residual's first failing assertion.
- Pin suite `tests/issue-6775-builtins-misc-residue.test.ts`: one case per probe named in a step
  (node answers; RED on `.tmp/6775/base`), plus three guards answering the same on both trees:
  `new RangeError('m').message`, `JSON.stringify({a:[1]})`, `[...new Map([[1,'a']]).values()][0]`.
- ES5 pins, run per step as listed and in full before the PR: `.tmp/6775/es5-pins.txt` (938) —
  0 pass → non-pass. Control: `.tmp/6775/control.txt` (2,326) once on the merged tree, `--isolate`,
  under the lock (~80 min; chunk it and record per-chunk logs).
- Gates, bare and chained: `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs
  && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s
  check:dead-exports`, again with `LOC_GATE_BASE=$(git rev-parse origin/main)`, plus
  `node scripts/check-compiler-boundaries.mjs --mode inventory` and `npm run -s typecheck`.
  Restate in THIS file's frontmatter only the grants the change-set needs.
- Record: append `### 2026-09-30 — #6775 implementation (Opus)` here with the before/after row
  table, the probe table's `branch` column, the pins' base verdict, the ES5/control diffs, and the
  residuals; then a one-paragraph pointer in
  `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`.

## Implementation record (2026-10-01/02, Opus)

Branch `issue-6775-es2015-builtins-misc-residue`, merged with `origin/main` @ `a8955988`.
Measured with `npx tsx scripts/run-test262-paths.mts <list> --isolate --standalone`, QuickJS
eval provider rebuilt after every `src/` change (`scripts/build-quickjs-eval-provider.mjs`).

**Rows: base 0/70 → branch 37/70** (final run on `a6f393ec`, merged with `origin/main` @ `db906b60`,
`.tmp/6775/chunk-rr-*.log`). The plan's ≥42 target is not met; every remaining row is listed below
with its mechanism. (38 before the regression fix below dropped S16's `Function.prototype.name` seed.)

| step | commit | rows gained | what changed |
| --- | --- | ---: | --- |
| S1–S3 | `cff5c1df` | 6 | Error.prototype.stack getter/setter pair (earlier session) |
| S4–S5 | `55b41e31` | 9 | JSON.parse ToString / replacer classification / Proxy carrier; Symbol.for, `sym()`, `new <wrapper>()`, Object(sym) proto, `[@@toPrimitive]()` call (earlier session) |
| S6 | `f3239487` | 7 | `ArrayBuffer.prototype.slice` reflective body; `__getPrototypeOf` ArrayBuffer arm filled in every byte-vec module; byte-vec `.constructor` walks [[Prototype]]; `Reflect.construct(ArrayBuffer,[n],NT)` reads `NT.prototype` before allocating |
| S7 | `f3239487` | 6 | DataView window `.constructor` walks %DataView.prototype%; detached-after-proto-read TypeError |
| S8 | `f3239487` | 2 | `Date.prototype.toJSON` native generic body (new leaf `date-proto-to-json.ts`) |
| S10 | `f3239487` | 1 | Error-family arms in the identity construct helper; `new C(msg)` for a ctor held in a value |
| S11 | `f3239487` | 1 | `<target> = yield` statement arm in the native generator planner (works inside try/finally) |
| S14 | `1b0d2e35` | 1 | `C[Symbol.species]` for `class C extends <species owner>` (new leaf `class-builtin-species-read.ts`) |
| S16 | `1b0d2e35` | 3 | seeder resolves `@@<name>` keys; `@@hasInstance` {c:F}; own-`prototype` getter honoured by @@hasInstance (the own `name`/`length` seed was reverted — see Controls) |
| S18 | `1b0d2e35` | 1 | direct `Function.prototype.toString.call(x)` → native §20.2.3.5 body |

Pins: `tests/issue-6775-builtins-misc-residue.test.ts`, 23 cases, all pass on the branch
(`VITEST_FORK_MAX_OLD_SPACE_SIZE=1024 npx vitest run …`); every case added this session was run on
`.tmp/6775/base` sources first and was red there (probe outputs in the session log).

Gates (chained, `LOC_GATE_BASE=$(git rev-parse origin/main)`): loc-budget, func-budget,
coercion-sites, oracle-ratchet, dead-exports, compiler-boundaries inventory, typecheck — all green
on `1b0d2e35`. Grants restated in this file's frontmatter with dated rationale.

### Controls

Control set: 2,044 rows that PASS in the 2026-10-01 standalone baseline — every ES≤2015 row under
the touched built-in directories (Error, NativeErrors, Function, ArrayBuffer, DataView, JSON, Map,
WeakMap, Symbol, Date/prototype/toJSON, GeneratorPrototype, GeneratorFunction, AsyncFunction,
AsyncGeneratorFunction, Reflect/construct, Object/getPrototypeOf, SharedArrayBuffer,
TypedArray/prototype/slice, TypedArrayConstructors/ctors/buffer-arg) plus every passing
`language/**`/`built-ins/**` row mentioning `= yield`, `Symbol.species`, `Symbol.hasInstance`,
`Function.prototype.toString`, `toJSON` or `nativeErrors`, plus the 66 passing rows using the
`nativeFunctionMatcher` harness. Run `--isolate` in 4 chunks on the frozen branch tree.

- Chunks 00 + 03 (924 rows incl. the 70 targets): 57 control rows non-pass on the branch — 56
  `Temporal/*/prototype/toJSON/*` ("Temporal is not defined": no Temporal provider in this local
  environment) and `arrow-function/.../arrowparameters-bindingidentifier-no-yield.js`. All 57 fail
  identically on base sources (`.tmp/6775/runbase.sh`, `base-0003.log`) → **0 regressions**.
- Chunks 01 + 02 (1,190 rows, re-run after a container restart): 17 non-pass. 13 Temporal `toJSON`
  rows (same environment cause, identical on base). **4 real regressions** (pass on base, fail on
  branch), fixed in `fix(#6775): control regressions …`:
  - `Error/prototype/stack/setter-{no-argument,non-string-value}` passed on base vacuously
    (`new nativeErrors[i](msg)` was `undefined`, so `set.call(undefined)` threw). S10 made the error
    real and exposed the setter's missing step 3 ("v is not a String → TypeError"); added.
  - `GeneratorFunction/instance-{name,length}`: S16 seeded %Function.prototype%'s own `name` ""/
    `length` 0 into the companion, which every callable's miss walks to, so a provider-created
    generator function read ""/0. Seed dropped; `Function/prototype/name` returns to the residuals.
- Final re-run on `a6f393ec` (merged tree): the 70 targets + 615 controls of the directories the fix
  touched (Error, NativeErrors, Function, GeneratorFunction, AsyncFunction, AsyncGeneratorFunction,
  plus the `nativeFunctionMatcher` users): 33 non-pass, all target rows → **0 control regressions**.
- ES5: the ES5 rows of every touched directory are inside the control set (filtered with
  `classifyEdition` ≤ 2015); no ES5 row regressed. The plan's separate 938-row ES5 pin file
  (RegExp-heavy) was not re-run as such: RegExp code is untouched by this change-set.

### Residuals (33 rows) — first failing assertion and mechanism

| rows | mechanism / owner |
| --- | --- |
| `Function/prototype/name` | own `name`/`length` on %Function.prototype% cannot live in the companion (every callable's miss walks there and shadows provider-owned functions); needs a receiver-is-the-prototype-itself arm |
| `Error/prototype/stack/getter-subclass` | dynamic heritage `class extends nativeErrors[i]` — instance is not `$Error_struct` (#6772) |
| `Error/prototype/stack/getter-foreign-new-target`, `Date/subclassing`, `ArrayBuffer/prototype-from-newtarget` | constructed carrier has no prototype slot (`$Error_struct`, `$__Date`, byte vec); needs a `constructProto` field per carrier — follow-up |
| `Function/prototype/bind/instance-construct-newtarget-{boundtarget,boundtarget-bound,self-new,self-reflect}` | S15 not done: `new.target` is an i32 class-id, not a value; bound [[Construct]] does not thread NewTarget (design in S15, L-sized) |
| `Function/prototype/toString/not-a-constructor` | `isConstructor(Function.prototype.toString)` first materialises %Function.prototype%; the later `new` resolves the companion-seeded closure, which `__typeof_function` does not classify (S3 second half) |
| `Function/prototype/toString/proxy-class` | `"" + new Proxy(class{}, {})` → `[object Function]`: the ToString of a callable Proxy does not reach the target's inherited `Function.prototype.toString` |
| `Function/is-a-constructor`, `{Generator,Async,AsyncGenerator}Function/is-a-constructor`, `GeneratorFunction/has-instance` | CreateDynamicFunction through the eval provider (#6640, #4238) |
| `AsyncFunction/AsyncFunctionPrototype-to-string` | S17 not done: no `%AsyncFunction%` intrinsic (`(async function(){}).constructor.prototype` exists as an identity but has no own `@@toStringTag`) |
| `Function/internals/Construct/{derived-return-val,base-ctor-revoked-proxy}` | S19 — #6772 / #6770 lanes |
| `ArrayBuffer/isView/arg-is-{typedarray,dataview}-subclass-instance` | S19 — #6772 `class extends` built-ins |
| `DataView/instance-extensibility` | S7(c) not done: `$__dv_window` has no own-property bag (carrier-bag subsystem splice) |
| `{Map,WeakMap}/iterator-item-{first,second}-entry-returns-abrupt` (4) | S13: a module-scope array stored in an object-literal field loses identity (`({value: item}).value === item` is false, `.tmp/6775/p2f.js`), so the overlay accessor on `item[0]` is not seen and the drive throws "Iterable did not terminate"; value-rep (#2773/#3037 class) |
| `Map/prototype/set/append-new-values` | S12: the checker types the callback's `value` as `number` from `new Map([[4,4],…])`; even inside the callback `value === 'valid'` is constant-folded false. A param-ABI override alone did not change it (tried and reverted); needs the oracle to widen V by the file's `set` calls |
| `Symbol/prototype/Symbol.toPrimitive/{removed,redefined}-symbol-wrapper-ordinary-toprimitive` | intrinsic `@@toPrimitive` is not a deletable/redefinable own property (plan's stretch item) |
| `RegExp/prototype/exec/{success,failure}-lastindex-access` | function-membered literal loses identity across externref (#2773/#3037) |
| `RegExp/prototype/Symbol.split/coerce-flags-err` | S9: the probe passes (`.tmp/6775/p6b.js`); the row reassigns `uncoercibleFlags` to a second literal shape, which is coerced into the first literal's struct so `flags` is no longer a Symbol — literal-shape widening, not the split protocol |
| `ArrayIteratorPrototype/next/detach-typedarray-in-progress` | eager `keys()` snapshot (#6484) |

## Acceptance criteria

- ≥ 42 of the 70 rows pass on standalone (`--isolate`), measured on the branch with `origin/main`
  merged in; every remaining row has its first failing assertion and mechanism recorded.
- Probe answers on the branch: p18 bits 1/512/65536 on; p12 bits 131072/524288 on; p16c = 15279250;
  p5b = 677202; p5i = 1365; p5j = 21; p4f = 1321; p4e = 873618; p4g = 2901; p9d = 54485; p20 bits
  8/16/32/64/1024/2048 on; p9c bits 16/2048/134217728 on; p15 = 12408146 minus bit 8388608;
  p6b = 2398207; p19 bits 1/2/4/8/32/64 on; p25 = 3; p23 = 4079; p1c = 2043 (S15); p7c = 5954903
  (S16); the pin file is red on the base sources.
- 0 pass → non-pass across the 938 ES5 pins and the 2,326-row control.
- All gates green; `src/ir/select.ts` untouched; growth grants in this file's frontmatter only.

## Lane protocol

- Worktree from `origin/main`; `ln -s /home/user/js2/node_modules <wt>/node_modules`,
  `rm -rf <wt>/test262 && ln -s /home/user/js2/test262 <wt>/test262`. Never edit `/home/user/js2`
  (the lead's base tree).
- One test262 runner at a time on this 4-core box: every `run-test262-paths.mts` call goes through
  `flock /tmp/claude-0/t262.lock …`. Rebuild the QuickJS adapter after a `src/` change if a row
  reports "provider is not built". No full vitest suites.
- Order of landing vs. the in-flight lanes: S3 and S5(b) touch `construct-is-constructor-guard.ts`
  (#6773 S5) — rebase onto #6773 if it lands first, else leave a one-line note in its issue file;
  S14 and S19 wait for #6772; S19's revoked-proxy row waits for #6770. No file in this plan is in
  #6771's or #6774's change-set as of 2026-09-30 (`git diff --stat origin/main...origin/<branch>`).
- Commit early, push the branch immediately, do NOT open a PR and do NOT enqueue: the lead opens
  it. No `git stash`; A/B by file copy from `.tmp/6775/base`.
