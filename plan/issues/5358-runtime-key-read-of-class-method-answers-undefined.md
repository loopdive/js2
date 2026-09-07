---
id: 5358
title: "A runtime-key read of a class instance's prototype method answers `undefined` — bare `__extern_get`, nothing to delegate to (marked Hooks cluster B, 10 tests)"
status: done
sprint: current
created: 2026-09-06
updated: 2026-09-06
completed: 2026-09-06
assignee: ttraenkler/sendev-5358
pr: 5681
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: compiler
goal: correctness
# 2026-09-06 (#5358): the mechanism lives in the new subsystem module
# src/codegen/runtime-key-class-methods.ts; what remains in the god-files is
# one registration call per dynamic-key read arm (property-access.ts ×2,
# binary-ops-in.ts), the context field (types.ts / create-context.ts) and the
# bridge emitters consuming the union instead of the named set (index.ts).
loc-budget-allow:
  - src/codegen/property-access.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/property-access.ts::compileElementAccessBody
  - src/codegen/binary-ops-in.ts::compileInOperator
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/codegen/index.ts::emitClassMemberKindExports
  - src/runtime.ts::resolveImport
---

## Problem

Split out of #5345 after its agent **refuted the filed diagnosis** with
measurement. The filed version blamed default parameters; it is not that.

`marked`'s `use()` installs hooks with

```js
for (const o in n.hooks) { const a = r[o]; r[o] = c => a.call(r, c); }
```

where `r` is a `Hooks` class instance. With a **runtime key**, `r[o]` answers
`undefined` for **every** prototype method — `preprocess(markdown)` (no default
parameter) exactly as much as `provideLexer(e = this.block)`. The read is a
bare `__extern_get` (there is no `propName`, so no closed dispatcher and no
`classMethodCandidatesForProp` enumeration is involved at all), and the host
side has nothing to fall back to: with a genuine runtime key
`Hooks.prototype[k]` and `Object.getPrototypeOf(h)[k]` are **also**
`undefined`. A class's methods live on the prototype in JS; here they live
nowhere the host can enumerate.

Control that isolates it: the same runtime-key read against a **plain object
literal** returns the function, because a literal's methods are struct
fields.

This is #5195 Step 4.3 (runtime-key member read on a class instance) plus a
JS-host-lane twin of `__class_proto_lookup`, which exists for the standalone
lane only.

## Evidence

- marked `test/unit/Hooks.test.js` is 9/30 on clean main. PR #5653 (#5345
  cluster A) removed the 11 `async option` errors and marked stayed **9/30**:
  the same 10 tests fail one step later on `Cannot read properties of
  undefined (reading 'trim')` — the wrapper `c => a.call(r, c)` closed over
  `a === undefined`. **Clusters A and B are serial**; nothing on marked moves
  until this lands.
- Two pins for this shape are already in
  `tests/issue-5345-absent-property-i32-narrowing.test.ts`, documented as
  failing on both sides.

## Acceptance criteria

1. `h[k]` for a runtime `k` naming a prototype method of a compiled class
   returns a callable that, when called with `.call(h, …)` or directly with
   `h` as receiver, runs the method with `this === h`. Both spellings —
   `h[k]` and `Object.getPrototypeOf(h)[k]` — and `k in h` must agree with
   JS.
2. `Hooks.test.js` ≥ 19/30 (the 10 cluster-B tests pass; the remaining
   `illegal cast` bucket is a separate residual, see #5345).
3. Regression test under `tests/`, **untyped `.js` two-file fixtures**:
   runtime-key read of a method with and without a default parameter; a
   plain-object-literal control (already works — anti-vacuity); an inherited
   method through a subclass instance; and the `for…in` + `.call` marked
   shape returning the transformed value. Fails on the parent, passes with
   the fix — exact counts both ways. Flip the two cluster-B pins in the
   #5345 test file in the same PR.
4. **A/B at one HEAD** over all 17 suites, per test file. Anchors on clean
   main: webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740/63740 ·
   lodash 53/62 · redux 63–64/82 · axios 200/231 · stylelint 108/108 ·
   tailwindcss 13/13 · jsdom 6/6 · styled-components 9/9 · uuid 75/75 ·
   marked 9/30 · moment 10/10 · prettier 101/151 · jest 335/356 · hono
   244/324. A runtime-key read of class methods is common in library code —
   watch every package, not just marked.
5. Gates green including `pnpm run check:dogfood-validation`; standalone
   lane byte-identical unless the change is deliberately shared.

## Implementation Plan

1. **Read the two existing mechanisms first**, because this is a bridge
   between them, not a new one:
   - `src/codegen/member-get-dispatch.ts` — `classMethodCandidatesForProp`
     builds per-name `__get_member_<name>` dispatchers with method arms for
     an `any`-typed receiver. It is keyed on a **static** name; a runtime key
     never reaches it.
   - `__class_proto_lookup` (grep `src/codegen` and `src/runtime.ts`) — the
     standalone lane's runtime-key resolver over a class's prototype chain.
     Find why it has no JS-host twin and what it would need from the host
     (`_wasmStructProps` sidecar? the `__member_kind_<key>` /
     `__member_arity_<key>` sidecars from closed-method-dispatch?).
2. **Choose the surface.** Two candidates; measure before committing:
   - (a) **Make the prototype carrier real for the host.** The compiler
     already mints a per-class prototype object for `C.prototype` reads
     (`src/codegen/class-proto-object.ts`, and #5347 is adding a
     struct→prototype reverse map for `getPrototypeOf`). If that carrier
     exposes each method as a callable property (the `__class_call_<m>_<n>`
     bridges from `emitMethodDispatch` already exist per method), then a
     runtime-key read on the instance can fall through to it exactly the way
     JS does — `__extern_get(instance, k)` misses the own sidecar, walks to
     the prototype carrier, hits. This makes `Object.getPrototypeOf(h)[k]`
     correct for free and composes with #5347. **Preferred if #5347's map
     lands first — coordinate; do not build a second reverse map.**
   - (b) A runtime-key arm in `__extern_get` on the host side that asks the
     module a `__runtime_member_get(struct, key)` closed dispatcher generated
     per class (the #2963 pattern with a string-compare ladder). Works
     without a prototype carrier but duplicates dispatch tables per class.
3. Reduce with a negative control (standalone `.mjs`,
   `compileAndRunUpstreamModule`, harness sanity-checked); dump WAT for
   `h[k]` and confirm it is the bare `__extern_get`.
4. Implement (a) unless measurement says otherwise. Bound `this`: the
   returned callable must behave like an unbound prototype method (marked
   does `a.call(r, c)`), not a pre-bound closure.
5. Regression tests; A/B; one PR. Record the standalone-lane status
   explicitly.

## Dispatch

Model: **fable** (`feasibility: hard`, `reasoning_effort: max`). This sits
where three mechanisms meet (closed method dispatch, the prototype carrier,
`__extern_get`), the filed diagnosis has already been wrong once, and the
right answer depends on #5347's design — the same reasoning tier that
resolved #5334's ambiguity.

## Resolution

Base: upstream `main` `a22e2d2623` + PR #5672 (`230e66b114`, #5347's
`ref.test` dispatcher, merged to main during this work). All measurements
through `compileProject` in a standalone `.mjs` (never vitest +
`instantiateWithRuntime`) on untyped `.js` two-file fixtures.

### Root cause — neither of the two designs the plan offered

The WAT for `h[k]` is `local.get $h; extern.convert_any; local.get $k;
call __extern_get` with `$h` the concrete `(ref null $Hooks)` struct, i.e. the
bare host import the issue names. But the **host side was never the gap**:
`__extern_get` → `_safeGet` already consults `_resolveClassMember`
(`src/runtime/class-method-host-bridge.ts`), which resolves a prototype
method through the compiled `__member_kind_<key>` / `__class_call_<key>_<n>`
bridges and hands back a host function that honours an explicit `this`
(#5237) — exactly the unbound-method shape `a.call(r, c)` needs. Measured:
forcing `__member_kind_preprocess` into the pin module via an unrelated NAMED
dynamic call made `h["preprocess"]` read `function` and `a.call(h, "hello")`
run the method, while `provideLexer` (no such call) stayed `undefined`.

Those bridges are emitted only for keys in `ctx.hostDynamicClassMethodNames`,
and every writer of that set is a NAMED call / write / class-value crossing
(`calls.ts`, `assignment.ts`, `call-receiver-method.ts`, `extern.ts`). A
runtime key has no name to register, so a class whose methods are never
dynamically called by name publishes no bridge at all and the resolver misses.
`__register_prototype` cannot help: it registers only the method-NAME csv
(`_prototypeMethodNames`, used by `_wrapForHost` enumeration and
`getOwnPropertyDescriptor`), nothing callable — the `_getProtoMethodBridge`
placeholder for a registered prototype throws by design (#1364b). So
"materialize the carrier" (design a) was never going to answer, and a per-class
string ladder (design b) would duplicate a surface that already exists per key.

### Mechanism

`src/codegen/runtime-key-class-methods.ts` (new): the dynamic-key read arms
register the DEMAND a runtime key implies, and the existing bridge emitters
publish it.

- `$ClassName` struct receiver (`compileElementAccessBody`'s struct fallback,
  `property-access.ts`): the method/accessor names of that class family — the
  class, its ancestors (inherited methods), its descendants (a `Base`-typed
  binding may hold a `Derived`); every class mapped to the receiver's typeIdx
  seeds the family because WasmGC canonicalizes structurally. A statically
  folded key (`const k = "m"; h[k]`) narrows the demand to that one name; an
  object-literal struct registers nothing.
- `externref` receiver with a non-literal key (the externref arm of the same
  function, and the `in` operator's `__extern_has` arm in `binary-ops-in.ts`):
  every class's method names — an `any` may hold any instance, a prototype
  singleton read through `C.prototype`, or a `getPrototypeOf` answer.
- The names go in `ctx.runtimeKeyClassMethodNames`, SEPARATE from
  `hostDynamicClassMethodNames`: that set also relaxes the exact-arity
  admission of `closed-method-dispatch.ts` for NAMED calls (`hostDynamic`),
  and a read must not move how a named call lowers. Only the bridge emission
  in `index.ts` consumes the union (`hostBridgeMethodKeys`): the
  `needsDynamicClassMembers` gate, the numeric-boxing prerequisite scan, the
  rest-parameter (`_vararg`) admission, the `__class_call_*` arity admission
  and `emitClassMemberKindExports`.
- Host `__extern_has` (`src/runtime.ts`) gains the twin: after the own-field
  and `%Object.prototype%` checks, a WasmGC struct answers through
  `hasCompiledClassMember` — the same `__member_kind_<key>` discriminator the
  read resolves with, presence only (a getter is not invoked) — so `k in h`
  and `h[k]` agree on an `any` receiver; the typed-receiver `in` was already
  folded at compile time by #5292.
- Symbol-keyed (`@@`), private (`__priv_`) and standalone-synthetic
  (`__cmdyn$`) member names are never registered; `constructor` neither.
- A statically numeric key (`arr[i]`, `isNumericIndexExpression`) registers
  nothing at any of the three sites — a number never names a method.

### Measured

- `tests/issue-5358-runtime-key-class-method-read.test.ts` (9 tests, one
  compiled module, no member of `Hooks` ever called by name through a
  dynamic receiver — such a call registers the key on its own and hides the
  defect): **2/9 on the parent → 9/9 with the fix.** The two that pass on the
  parent are the guards: the object-literal control and the getter-receiver
  check. Fails on the parent: method with and without a default parameter,
  inherited method through a subclass instance, marked's `for…in` + `.call`
  wrapper (`"pre:ABC"`), default parameter through `.call(h)` /
  `.call(h, false)` (`"lex|lexInline"`), `Object.getPrototypeOf(h)[k]` and
  `Hooks.prototype[k]` (both `function`, both `.call(h, …)` correctly),
  `k in h` typed/any agreement, and the any-receiver read.
- `tests/issue-5345-absent-property-i32-narrowing.test.ts`: the two cluster-B
  pins flipped to `"function"` — **6/7 on the parent → 7/7 with the fix.**
- Standalone lane: byte-identical (`232667` bytes, sha256
  `19108eba…0316d20` on both sides; registration is host-lane only and the
  union helper returns the named set unchanged when nothing registered).
  Incidentally that standalone build of the fixture fails
  `WebAssembly.validate` on BOTH sides — pre-existing, not touched here.

### marked — the issue's attribution was wrong, and AC 2 is NOT met here

Probed marked's real module (`lib/marked.esm.js` compiled through
`compileProject`) on the parent: it **already** publishes
`__member_kind_preprocess` / `__class_call_preprocess_1` /
`__class_call_provideLexer_1` / `__class_call_use_vararg`, because marked's
own `parseMarkdown` calls the hooks BY NAME through an `any` receiver
(`i.hooks.preprocess(n)`), which registers them. `use({hooks:{preprocess}})`
then `parse("*t*")` answers `<p>X<em>t</em></p>` on the parent — the runtime-
key read in `use()` resolved all along; `a` was never `undefined` in marked.
The `Cannot read properties of null (reading 'trim')` the 10 tests die with is
the TEST's `html.trim()` after `await marked.parse(...)` resolved `null`/
`undefined`: **all 10 are the `async: true` path**, and a marked-free bisect
of `parseMarkdown`'s async arm reads `html="<p>[object Promise]</p>"` while
the installed wrapper alone works (`"Wmd"`) and the sync arm works. Reduced
further: inside an async function, `const u = cond ? await later("A") : "B"`
leaves `u` holding the **Promise** (await in either branch; plain-function,
async-function and `any` callees), while a plain `await`, an `if`-guarded
await and an object-literal `async` method operand suspend correctly. Filed
as **#5372** with the full table and a pointer at `async-cps.ts`'s
conditional-initializer arm. marked stays **9/30** with this PR (binary
+1,079 bytes: the six hook bridges the `use()` read now demands). #5345's
`illegal cast` bucket (`should process tokens before walkTokens`) is
untouched and still separate.

### A/B over the 17 suites at one HEAD (base = the same HEAD with the seven
edited sources reverted to their pre-change copies; suites one at a time)

| suite | base | fix | files moved | binary bytes (base → fix) |
| --- | --- | --- | --- | --- |
| webpack | 16/16 | 16/16 | 0 | 853,968 → 853,968 (+0) |
| three | 17/18 | 17/18 | 0 | 432,078 → 432,078 (+0) |
| clsx | 32/32 | 32/32 | 0 | 952,044 → 952,044 (+0) |
| cookie | 63740/63740 | 63740/63740 | 0 | 1,585,328 → 1,585,328 (+0) |
| lodash | 58/62 | 58/62 | 0 | 1,233,214 → 1,233,214 (+0) |
| redux | 67/82 | 67/82 | 0 | 4,239,219 → 4,239,219 (+0) |
| axios | 200/231 | 200/231 | 0 | 27,641,105 → 27,641,105 (+0) |
| stylelint | 108/108 | 108/108 | 0 | 8,465,116 → 8,465,116 (+0) |
| tailwindcss | 13/13 | 13/13 | 0 | 582,090 → 582,090 (+0) |
| jsdom | 6/6 | 6/6 | 0 | 324,650 → 325,009 (+359 (0.11%)) |
| styled-components | 9/9 | 9/9 | 0 | 1,073,836 → 1,073,836 (+0) |
| uuid | 75/75 | 75/75 | 0 | 974,669 → 974,669 (+0) |
| marked | 9/30 | 9/30 | 0 | 1,118,723 → 1,119,802 (+1,079 (0.10%)) |
| moment | 10/10 | 10/10 | 0 | 5,990,196 → 5,990,196 (+0) |
| prettier | 105/151 | 105/151 | 0 | 4,187,759 → 4,187,759 (+0) |
| jest | 335/356 | 335/356 | 0 | 10,204,702 → 10,674,434 (+469,732 (4.60%)) |
| hono | 229/324 | 229/324 | 0 | 11,273,381 → 11,302,034 (+28,653 (0.25%)) |


### Residuals (measured, not addressed)

- A method whose parameter is `i32`/`i64`/`f32` or a struct/vec ref publishes
  no `__class_call_<key>_<n>` bridge (`supportsHostClassBridgeParam` admits
  externref and f64 only, #5204), so its runtime-key read still answers
  `undefined` — e.g. `provideLexer(block = this.block)` when `this.block` is
  a boolean-initialized field. Untyped library code (externref params) is
  unaffected; a typed lane needs its own representation contract.
- A runtime-key WRITE to an instance (`r[o] = wrapper`) lands in the host
  sidecar; a later STATICALLY-typed call `r.preprocess(x)` on the same
  binding dispatches to the class method directly and does not see it.
  marked calls through an `any` (`i.hooks.preprocess`), which does. Not new.
- The `externref`-receiver arm registers every class's method names, so a
  module with classes and any string-keyed `obj[key]` read publishes bridges
  for all of them. The A/B table above is the cost: jest +469,732 bytes
  (+4.6% on 10.2 MB), hono +0.25%, jsdom/marked ≈ +0.1%, the other 13
  suites +0 — with no test movement anywhere (and one more jest module
  validating, 33/34 → 34/34). Gating out statically numeric keys did not
  move jest by a byte, so that growth is genuine string-keyed demand; a
  tighter lever needs a different discriminator, not this one.
