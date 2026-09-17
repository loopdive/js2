---
id: 6493
title: "ES2015 standalone: a first-class builtin method value refuses instead of working (Function.prototype.call and friends)"
status: done
completed: 2026-09-17
sprint: current
created: 2026-09-17
updated: 2026-09-17
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: ttraenkler/fable-es2015
model: opus
# 2026-09-17 (#6493 S1): +12 lines in the `makeGlue` god-file. The Function
# family's `emitMemberBody` ladder and its `memberIsVariadic` predicate both
# live there and are the ONLY hooks by which a native-proto member body can be
# wired; the body itself is a new module (`src/codegen/function-proto-call-apply.ts`,
# ~250 lines), so what lands in the god-file is one import plus the two arms
# that dispatch to it — the same shape as the `emitFunctionProtoToStringBody`
# arm immediately above.
loc-budget-allow:
  - src/codegen/array-object-proto.ts
# 2026-09-17 (#6493 S4): three `__is_truthy` tokens enter
# `error-stack-accessor.ts`, which had none. This is NOT a hand-rolled
# coercion matrix — it is the single sanctioned standalone ToBoolean native
# (`registerNative` in `registry/imports.ts`), read on the result of a Proxy
# trap. §CreateDataPropertyOrThrow step 4 and §Set step 4 are both defined on
# ToBoolean(the trap's result), and EVERY existing proxy front guard in
# `object-runtime-proxy.ts` coerces the same way with the same helper. The
# alternative, `__to_boolean`, is a HOST IMPORT and would break this lane's
# `result.imports === []` requirement.
coercion-sites-allow:
  - src/codegen/error-stack-accessor.ts
---

# A first-class builtin method value refuses instead of working

Reading a builtin prototype method as a **value** and then calling it — the
`Function.prototype.call.call(f, thisArg)` shape, and every
`<builtin>.prototype.<m>` grabbed off the prototype rather than invoked at a
static call site — throws
`TypeError: <key> is not yet implemented in --target standalone`.

The refusal is not per-method. `builtin-value-read.ts:1747` is a **generic
fallback**: any first-class builtin method value that reaches that arm without
a body gets the degrade-to-catchable TypeError. So a method that is perfectly
well implemented at a static call site has no first-class value at all.

## Measured (standalone baseline fetched 2026-09-16 10:46 UTC)

Two error families, 30 ES2015 rows between them, plus 3 more inside the #6484
acceptance set that fail for exactly this reason:

| refusal | rows |
| --- | --- |
| `Function.prototype.call is not yet implemented` | 17 |
| `Object.prototype.toString is not yet implemented` | 13 |

The 17 are not all about `Function.prototype.call` being interesting in itself —
they are rows whose harness reaches a builtin method through a value. The
clusters: `built-ins/Error/prototype/stack/*` (5), `built-ins/Object/prototype/toString/symbol-tag-*` (5),
`built-ins/TypedArray*` (5), `built-ins/Promise/executor-function-prototype.js`,
`built-ins/Function/prototype/Symbol.hasInstance/this-val-not-callable.js`.

## Implementation Plan

### S1 — give `Function.prototype.call` and `.apply` real first-class bodies

1. Find where `builtin-value-read.ts` dispatches a first-class builtin method
   value (the chain ending at the `genericThrowBody` arm, line ~1747). Add an
   arm for `Function.prototype.call` and `Function.prototype.apply` BEFORE that
   fallback, modelled on the `Math` arm immediately above it
   (`emitMathValueReadBody`), which is the existing example of a family that
   mints its own kernel late.
2. The body is §20.2.3.3 / §20.2.3.1: take the receiver as `this`, the first
   argument as the new `this`, and forward the rest. The standalone lane already
   has a closure-apply substrate (`__apply_closure` / the closed-struct
   dispatchers); route through it rather than inventing a second ABI. A
   non-callable receiver throws a catchable TypeError, never a trap.
3. Arity: `call.length` is 1, `apply.length` is 2, both non-writable,
   non-enumerable, configurable, and `name` is `"call"` / `"apply"`. Several
   target rows read exactly this metadata.

### S2 — `Object.prototype.toString` as a value

The class-tag classifier exists (`object-proto-tostring-native.ts`); what is
missing is the first-class value that reaches it. Wire the value read to the
same helper the static call site uses, so
`Object.prototype.toString.call(x)` and a bare `Object.prototype.toString`
handed to `verifyProperty` both answer. Watch the receiver rules: §20.1.3.6
answers `[object Undefined]` / `[object Null]` for those two receivers rather
than throwing.

### S3 — only if S1 and S2 are green and measured

Audit which other `<builtin>.prototype.<m>` values still hit the generic arm.
Report the list with row counts rather than implementing them all; this lane
should not become a sweep.

## Acceptance

Rows, `COMPILER_POOL_SIZE=2 npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone`,
against a base tree built from the merge-base in its own worktree:

- S1: the 17 `Function.prototype.call` rows, and the three `Function.prototype.call`
  rows inside `built-ins/ArrayIteratorPrototype/next/*`.
- S2: the 13 `Object.prototype.toString` rows.

Controls, 0 lost: `built-ins/Function/prototype`, `built-ins/Object/prototype`,
`built-ins/Error/prototype`, `built-ins/TypedArray/prototype`,
`built-ins/Reflect`, `language/expressions/call`.

## Hazards

- **The generic arm is a load-bearing safety net.** It turns an unimplemented
  builtin into a catchable TypeError instead of a trap. Do not remove or widen
  it — add arms before it.
- **A refusal that becomes a wrong answer is worse than the refusal.** If a
  shape cannot be implemented correctly, leave it refusing and say so.
- Host and gc output must be byte-identical; this lane is standalone/wasi only.
  Prove it on a corpus with sha256 rather than asserting it.
- Execute each new site twice on different arms — a late-minted kernel cached in
  a global must initialise its result local on every execution, not only the
  first.

## Validation required before the PR

TS7 typecheck, lint, prettier; the five source-ratchet gates bare and with
`LOC_GATE_BASE=origin/main`; the compiler-boundaries inventory (a new module
must be classified in `scripts/compiler-boundaries.json` — this gate has caught
two lanes this session); the equivalence gate; and a pin file
`tests/issue-6493-first-class-builtin-method-values.test.ts` asserting, on
standalone with `result.imports` `[]`: `Function.prototype.call` invoked through
a value, its `length` and `name`, the non-callable receiver TypeError, and
`Object.prototype.toString` through a value including the undefined and null
receivers. Growth allowances go in this frontmatter with a dated rationale,
never in `scripts/*-baseline.json`.

## Implementation result (2026-09-17)

Both measurements below were run with
`COMPILER_POOL_SIZE=2 npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone`
on TWO trees: this branch, and a `git worktree add --detach` of the merge-base
`747c0fee19` at `/home/user/js2/.claude/worktrees/lane6493-base`, with the same
`.test262-cache` symlinked into both (without it ~7 rows per set abort on a
missing QuickJS artifact — symmetric, but it hides the real verdict).

### What landed

- `src/codegen/function-proto-call-apply.ts` — §20.2.3.3 / §20.2.3.1 bodies,
  wired into `makeGlue`'s `Function` arm ladder. `call` is registered variadic;
  both route through the existing `__apply_closure` bridge.
- `src/codegen/object-proto-tostring.ts` — §20.1.3.6 step 8 `[object Error]` arm
  (`nominalCarrierArms`, which also now holds the pre-existing Date arm, emitted
  byte-for-byte unchanged).

### Acceptance — 112 rows (`Error/prototype/stack`, `Object/prototype/toString`, `ArrayIteratorPrototype/next`, `Function/prototype/Symbol.hasInstance`, `Promise/executor-function-prototype`)

| | base | branch |
| --- | --- | --- |
| pass | 40 | **42** |
| fail | 72 | **70** |
| `Function.prototype.call is not yet implemented` | **27** | **0** |
| `Object.prototype.toString is not yet implemented` | 5 | 12 |

Net **+2**: 3 rows fixed, 1 lost, 25 rows changed failure reason.

**Fixed (+3)** — all three failed on base with the `Function.prototype.call`
refusal: `Error/prototype/stack/setter-proxy-wrapping-prototype.js`,
`Error/prototype/stack/setter-receiver-is-null-proto.js`,
`Function/prototype/Symbol.hasInstance/this-val-not-callable.js`.

**Lost (−1)**: `Error/prototype/stack/setter-proxy-trap-rejects.js`.

**Correction to this file's first draft.** It originally reported −3 and put
all three lost rows under one heading, "the receiver check is too narrow". That
grouping was wrong. Two of them — `getter-this-not-object.js` and
`setter-this-not-object.js` — WERE receiver-check rows and are now FIXED (see
below). The third never was: its receiver is a Proxy, which is an Object and
correctly passes step 1.

All three passed on base for the same accidental reason — each is an
`assert.throws(TypeError, …)` and on base the `Function.prototype.call` refusal
was itself the TypeError, so `Error.prototype.stack` never ran.

*Fixed in round 2 (the two receiver rows).* `emitThisIsObjectCheck`
(`src/codegen/error-stack-accessor.ts`) tested only `null`/`undefined`, on the
stated reasoning that "a boxed primitive receiver reaches the closure as a
wrapper object here". Measured: NOT true on the first-class `get.call(1)` path
— the receiver arrives as the raw boxed primitive. It now rejects every
primitive: `__typeof_{number,string,boolean,bigint}` plus a `ref.test` on the
native `$Symbol` carrier.

Two facts worth recording because both were asserted the other way during
review:

- **`__typeof_symbol` does not exist.** It is looked up in exactly two places
  (`object-runtime-proxy.ts:1374`, `:1546`) and REGISTERED IN NONE; both sites
  document that and fall back to the `$Symbol` carrier `ref.test`, as does
  `reflect-target-guard.ts:185`. This file's first draft named "no
  `__typeof_symbol`" as the blocker that made the rows unfixable — the predicate
  is indeed absent, but the carrier test closes the case, so the conclusion was
  wrong.
- **`__extern_is_object` is a HOST IMPORT**, not a native. Every call site
  registers it with `ensureLateImport` and `src/runtime.ts:14132` implements it
  in JavaScript, so reaching for it would have put an entry in
  `result.imports`, which this lane requires to stay `[]`.

The widening is a UNION OF POSITIVE PRIMITIVE TESTS, never a "not an object"
probe, so it cannot start rejecting genuine objects — the `__typeof_*`
predicates answer FALSE for the corresponding wrapper object, which is exactly
why `emitObjectProtoToStringClassifier` needs its own `[[PrimitiveValue]]` arm
to tag `new String("x")`. Pinned with that control: `new Error()` still answers
a string, `{}` and `new String("x")` still answer rather than throw.

*Still lost, and why it is not in this slice.* `setter-proxy-trap-rejects.js`
needs the Proxy's `defineProperty` trap returning `false` to surface as a
TypeError (CreateDataPropertyOrThrow step 4), and its `set` trap likewise
(Set with Throw=true step 4). `__defineProperty_value` is declared with **no
result value at all** (`ensureLateImport(…, [EXTERNREF, EXTERNREF, EXTERNREF,
F64], [])`), so there is no success bit for the setter to test. Giving it one
changes a shared signature across four call-site families plus the host runtime
implementation — a different subsystem, and not something to approximate with a
re-read probe, which would add observable `getOwnPropertyDescriptor` trap calls
purely to satisfy a test.

**Reason changed (25)** — the biggest group is the nine
`Object/prototype/toString/symbol-tag-*-builtin.js` rows, which now get past
`call` and fail on the real gap: §20.1.3.6 **step 14 `@@toStringTag` is not
implemented in the classifier at all**. Seven of the nine now report the
`Object.prototype.toString` refusal (an unclassifiable Map/Set/WeakMap/WeakSet/
Promise/Symbol receiver), two report a wrong builtin tag
(`[object Array]` for an Array Iterator, `[object Function]` for a
GeneratorFunction). That is the whole S2 headline: the first-class VALUE already
reached the classifier before this change — what is missing is classifier
COVERAGE, not the value.

### Controls — 805 rows, 0 lost

Eight chunks of ≤150 paths, the same list file on both trees. Every chunk is
IDENTICAL: same totals, and the same non-pass `status path` set line for line.

| chunk | set | rows | base | branch |
| --- | --- | --- | --- | --- |
| cc1-00/01 | `built-ins/Function/prototype` (minus the acceptance overlap) | 298 | 250 pass / 45 fail / 3 CE | same |
| cc2-00/01 | `built-ins/Object/prototype` (minus the overlap) | 207 | 190 pass / 17 fail | same |
| cc3-00 | `built-ins/Error/prototype` (minus the overlap) | 30 | 28 pass / 2 fail | same |
| cc4-00 | `language/expressions/call` | 92 | 72 pass / 20 fail | same |
| cc5-00 | `built-ins/Reflect`, every 2nd path | 77 | 68 pass / 8 fail / 1 CE | same |
| cc6-00 | `built-ins/TypedArray/prototype`, every 14th path | 101 | 69 pass / 32 fail | same |
| **total** | | **805** | **677 pass / 124 fail / 4 CE** | **identical** |

`built-ins/Reflect` and `built-ins/TypedArray/prototype` are DETERMINISTIC
SAMPLES (every 2nd / every 14th path, sorted), not the full directories — 153
and 1,404 rows respectively were out of reach for a two-tree isolate run on a
shared box. That is a real limit on this control, stated rather than papered
over; the three directories where this change can actually bite
(`Function/prototype`, `Object/prototype`, `Error/prototype`) were run in full.

### Other evidence

- **gc / js-host byte-identity**: 34 sha256 pairs (13 `website/playground/examples`
  sources + 4 synthetic call/apply/toString/Error programs, × `{gc, gc+nativeStrings}`),
  zero diffs between the trees.
- **standalone byte-identity**: of four standalone probes, only the one that
  actually emits the §20.1.3.6 classifier differs; the Date-arm extraction is
  byte-preserving.
- **pin**: `tests/issue-6493-first-class-builtin-method-values.test.ts` — 7/7
  green here, 4/7 RED on the merge base (the other three are guards).
- **equivalence gate**: 1720 passing / 22 known failures, no new regressions.
- **existing suites** `issue-4481`, `issue-4491-wave7`, `issue-4492`,
  `issue-4492-wave5`, `issue-5406`, `arrow-call-apply`: 9 failed / 108 passed on
  BOTH trees, identical down to the assertion message.

### S3 audit — which `<builtin>.prototype.<m>` values still refuse

Sampled 22 members through a first-class value on both trees; the two answers
are IDENTICAL, because that spelling (`v.call(recv, …)` on a member value) is
claimed syntactically by `calls.ts`'s reflective `.call` route and never
materializes `Function.prototype.call`. Still refusing:
`Function.prototype.bind`, `Object.prototype.{hasOwnProperty,
propertyIsEnumerable, toLocaleString}`, `Map.prototype.get`,
`Set.prototype.has`, `WeakRef.prototype.deref`, `ArrayBuffer.prototype.slice`,
`%TypedArray%.prototype.subarray`, `BigInt.prototype.toString`; plus
`Array.prototype.{indexOf,reduce,sort}` on the sibling "not yet callable as a
value" message. Row counts are NOT given: the promoted standalone artifact
(`benchmarks/results/test262-standalone-current.json`) carries only bucket
sample signatures, and no per-row standalone JSONL exists to count against.

### Residuals, named

0. **A Proxy receiver whose `defineProperty` / `set` trap returns `false`** does
   not raise the TypeError §CreateDataPropertyOrThrow step 4 / §Set step 4
   require — `built-ins/Error/prototype/stack/setter-proxy-trap-rejects.js`.
   `__defineProperty_value` reports no success value at all, so the stack setter
   has nothing to test; see the acceptance section for why that signature change
   is a different subsystem. Out of this slice, deliberately.

1. **A callee with more than 8 DECLARED parameters traps.** `__apply_closure`'s
   arity cap (#1888 / #3310) is `unreachable` above 8 declared formals, so
   `Function.prototype.call.call(f9, …)` now aborts the module where base
   answered a silent `null`. Argument COUNT above 8 is unaffected (it degrades
   to `undefined`, as on base). Fixing the cap needs the finalize-time closure
   inventory, which is not reachable from a member body.
2. ~~**`apply` with a Symbol `argArray`**~~ — **FIXED in round 2.** It threw no
   TypeError because there is no `__typeof_symbol`; it now uses the same
   `$Symbol` carrier `ref.test` the receiver check does, so every primitive
   `argArray` (Number, String, Boolean, BigInt, Symbol) raises the §20.2.3.1
   step 3 CreateListFromArrayLike TypeError while a real array and a plain
   array-LIKE still spread. Pinned with both controls.
3. **`.length` through a variable** still folds from the lib.d.ts signature:
   `Function.prototype.apply.length` is 2 (correct) but `var a =
   Function.prototype.apply; a.length` is 1, because
   `expectedArgumentCountOfSignature` stops at `argArray?`. Pinned in the test
   file so it fails loudly when fixed.
4. **§20.1.3.6 step 14 `@@toStringTag`** is absent from the classifier — see the
   25-row reason-change group above.

## S4 — close the last regression (blocking; plan written 2026-09-17)

**This is not a judgment call — it is a hard gate.** The one lost row,
`built-ins/Error/prototype/stack/setter-proxy-trap-rejects.js`, is classified
**ES2015** (`website/public/benchmarks/results/test262-file-editions.json` maps
it to edition index 3 = ES2015), ES2015 is `ratcheted: true` in
`scripts/test262-edition-ratchet-baseline.json`, and the row reads
`"status":"pass"` in `.test262-cache/test262-standalone-current.jsonl` (the very
baseline CI's `--compare` arm uses). `scripts/test262-edition-ratchet.ts`
Check 2 fails on **any single** pass→not-pass inside a ratcheted edition and has
**no allowance, waiver or `regressions-allow` mechanism** — grep confirms. It
runs inside the REQUIRED `merge shard reports` check, so net +2 with this row
lost is ejected from the merge queue, whatever the headline says.

### The fix: give the stack setter the success bit it is missing, for the one receiver where it exists

Round 2's report said the blocker is that `__defineProperty_value` "has no
result value at all", so the setter has nothing to test, and that giving it one
changes a shared signature across four call-site families plus the host runtime.
That is correct **for the ordinary path** and it stays out of scope. It is
**not** the only channel. For a **Proxy** receiver — which is exactly what this
test uses — the trap's own booleanish result is already carried by natives that
exist today:

| native | signature | what it returns |
| --- | --- | --- |
| `__proxy_define_dispatch` | `(proxy, key, desc) -> externref` | §10.5.6 the defineProperty trap's result, as-is |
| `__proxy_set_dispatch` | `(proxy, key, value) -> externref` | §10.5.9 the set trap's result, as-is |
| `__create_descriptor` | `(value: externref, flags: i32) -> externref` | a data descriptor object from a value + the same flag encoding `__defineProperty_value` decodes |
| `__is_truthy` | booleanish externref → i32 | ToBoolean, the coercion every proxy front guard already uses |

All four are **standalone natives**, not host imports (`registerNative` in
`src/codegen/object-runtime-proxy.ts` / `object-runtime-descriptors.ts`), so
this adds nothing to `result.imports`. That distinction is load-bearing: it is
why `__extern_is_object` was rejected in round 2.

### Change

In `src/codegen/error-stack-accessor.ts`, `emitErrorStackSetterBody`, at the
steps 3–4 `if/else` (the `create` / `assign` arms): wrap each arm in a
**Proxy-receiver branch**, keeping the existing arm as the `else`.

- Guard: `ref.test` the `$Proxy` struct type on `any.convert_extern(local 1)` —
  the same front guard `object-runtime-proxy.ts` patches onto the `__extern_*`
  helpers. A non-Proxy receiver takes the existing path **byte-for-byte**; this
  must be provable, not assumed (see acceptance).
- **create arm, Proxy receiver** (no own `stack`): build the descriptor with
  `__create_descriptor(value, CREATE_DATA_PROPERTY_FLAGS)` — reuse the constant
  already in this file, do not re-spell the flags — then
  `__proxy_define_dispatch(recv, "stack", desc)`, coerce with `__is_truthy`,
  and on **falsy** throw a TypeError via the file's existing
  `buildThrowJsErrorInstrs`. That is §CreateDataPropertyOrThrow step 4.
- **assign arm, Proxy receiver** (own `stack` present):
  `__proxy_set_dispatch(recv, "stack", value)`, `__is_truthy`, falsy → TypeError.
  That is §Set step 4 with Throw = true.
- Every one of the four `funcMap.get` lookups must be `undefined`-guarded the
  way the existing three are, and the whole S4 arm must **degrade to the current
  behaviour** when any is missing — this file already returns `null` (no body)
  rather than emitting a half-wired path, and that contract holds.

### Order-preservation constraints

- A trap that **throws** must still propagate unchanged; only a *falsy return*
  becomes a TypeError.
- The trap is invoked **exactly once** per set. Do not read the result back with
  a `getOwnPropertyDescriptor` probe to infer success — that would add an
  observable `getOwnPropertyDescriptor` trap call, which round 2 correctly
  refused to do.
- Step 1 (the primitive-receiver check) and step 2 (the home-object identity
  compare) run **before** this, unchanged. A Proxy is an Object and passes
  step 1; a Proxy wrapping `%Error.prototype%` is a different reference and
  correctly passes step 2 on to its traps (`setter-proxy-wrapping-prototype.js`
  already pins this and must stay green).

### Acceptance

1. The 112-row acceptance set: **40 pass on base → 43 on branch, zero lost.**
   Same two-tree protocol as rounds 1–2 (merge-base worktree, `.test262-cache`
   symlinked into both), same list file.
2. `setter-proxy-trap-rejects.js` passes for **both** halves — (a) the
   `defineProperty` trap and (b) the `set` trap — not just whichever one the
   first assertion reaches.
3. The 805-row control set stays identical, line for line.
4. **Zero host imports**: assert `result.imports` is `[]` on a standalone probe
   that exercises the new arm.
5. Non-Proxy receivers emit **byte-identical** wasm: sha256 a standalone probe
   that uses `Error.prototype.stack`'s setter on a plain object, before and
   after. A diff here means the ordinary path moved and the claim above is false.
6. Pin the two halves in
   `tests/issue-6493-first-class-builtin-method-values.test.ts`, plus the
   controls that prove the arm does not fire for an ordinary receiver.
7. All gates exit 0, run bare, including the compiler-boundaries inventory
   (`--mode inventory --base HEAD^1`) if any new module appears.

### Out of scope, still

Residuals 1 (`__apply_closure`'s >8-declared-parameter cap), 3 (`.length`
through a variable) and 4 (§20.1.3.6 step 14 `@@toStringTag`) stay named and
unfixed. Giving `__defineProperty_value` a general success channel — the fix for
an **ordinary** receiver whose define fails (non-extensible target, non-writable
own property) — also stays out: it is the shared-signature change round 2
described, and this Proxy arm does not approximate it or block it.

## S4 implementation result (2026-09-17)

**The regression is closed: 43 pass / 69 fail on the branch against 40 / 72 on
the merge base, zero rows lost.** Same two-tree protocol as rounds 1-2 (a
detached worktree at merge-base `747c0fee19`, `.test262-cache` and `test262`
shared), same 112-row list file, same runner invocation
(`COMPILER_POOL_SIZE=2 npx tsx scripts/run-test262-paths.mts --isolate <list>
--standalone`).

### The lost row, traced across all three trees

Run one row, three trees, one command each:

| tree | `setter-proxy-trap-rejects.js` | why |
| --- | --- | --- |
| merge base `747c0fee19` | **pass** | accidental — the `Function.prototype.call` refusal was itself the TypeError both `assert.throws` wanted |
| round-2 tip `2358e2383b` | **fail** | `defineProperty returns false — Expected a TypeError to be thrown but no exception was thrown at all` |
| this branch | **pass** | half (a) raises the real §CreateDataPropertyOrThrow step-4 TypeError |

### What landed

One arm in `emitErrorStackSetterBody` (`src/codegen/error-stack-accessor.ts`):
steps 3-4 now split on `ref.test $Proxy` over the receiver. The `else` is the
existing `__defineProperty_value` / `__extern_set_strict` pair, unchanged. The
`then` reads the spec's SUCCESS BOOLEAN off the dispatcher that already carries
it, and throws when ToBoolean of it is false.

**Both halves were genuinely broken, for DIFFERENT reasons — round 2 named only
one of them, and named it wrongly.**

- `__defineProperty_value` is **not** "declared with no result value at all";
  the standalone native is registered `[externref, externref, externref, f64] ->
  [externref]` and returns the target object `O`
  (`object-runtime-descriptors.ts`). The real blocker is different and larger:
  it carries **no Proxy front guard at all** (only `__obj_define_from_desc`
  does), so on a `$Proxy` receiver it `ref.cast $Object`-ed the proxy carrier
  and stored into it. Measured on the round-2 tip: the `defineProperty` trap
  ran **zero** times, so neither a `false` return nor a THROWING trap was
  observable.
- `__extern_set_strict` does reach the `set` trap, but on the #4504
  result-channel build it drops `__reflect_set`'s boolean and reads the shared
  channel, which the proxy front guard returns before ever writing. Measured: a
  `set` trap returning `false` completed silently.

### Correction to the S4 plan: the `set` half needs the 4-argument dispatcher

The plan named `__proxy_set_dispatch`. **That one cannot be used**, and the
measurement is in its own source: its trap-ABSENT arm pushes `ref.null.extern`
as a deliberate placeholder for `__extern_set`'s front guard to DROP
(`buildDispatch`, `object-runtime-proxy.ts`). `__is_truthy(null)` is 0, so
believing that result throws on every trap-absent proxy — which would have
taken out `setter-receiver-is-proxy.js` and re-broken
`setter-proxy-wrapping-prototype.js`, the row round 1 had just fixed.

`__proxy_set_receiver_dispatch(recv, "stack", v, recv)` is used instead. It owns
its answer on both arms (trap present → the trap's booleanish result; trap
absent → `__box_boolean` of `__reflect_set_receiver`), it is the spec's own
shape — §Set(O, P, V, true) is `O.[[Set]](P, V, O)` — and it is exactly where
`__extern_set_strict` was already routing this write, so the SIDE EFFECTS are
unchanged and only the missing throw is added. Everything else in the plan held:
`__proxy_define_dispatch`, `__create_descriptor` and `__is_truthy` all exist
with the stated signatures and are all `registerNative` standalone natives.

### Acceptance — 112 rows, both trees

| | base `747c0fee19` | branch |
| --- | --- | --- |
| pass | 40 | **43** |
| fail | 72 | **69** |

Row-level, not count-level: the branch's 69-row non-pass set is a strict SUBSET
of the base's 72-row set. **Lost: none.** Fixed (+3):
`Error/prototype/stack/setter-proxy-wrapping-prototype.js`,
`Error/prototype/stack/setter-receiver-is-null-proto.js`,
`Function/prototype/Symbol.hasInstance/this-val-not-callable.js`.

### Byte identity of the ordinary path — measured, not asserted

Acceptance item 5 asked for a sha256 of a standalone probe that uses the stack
setter on a plain object, before and after. **That probe's sha DOES change**
(`7fc7dffe…` → `022d559c…`), and it must: the arm is emitted in every module
that mints the setter body, because the proxy natives are present in every
standalone module (verified — `__proxy_create`, `__proxy_define_dispatch` et al
are in `funcMap` even for a program containing no `new Proxy`), so there is no
sound "this module cannot make a Proxy" gate to hang it on.

What item 5 was actually protecting is intact, and here is the measurement that
shows it: compiling the SAME probe with the new arm suppressed by a temporary
switch reproduces **`7fc7dffea5d15437` exactly** — the pre-change sha, bit for
bit. So the whole byte delta is the new arm; the ordinary arm's instruction
stream is untouched (it is literally the same `Instr[]`, handed to the new `if`
as its `else`). Separately, a standalone probe that never reaches the setter is
unchanged outright (`ca9b6842c74fcfca` on both trees).

### Controls — 805 rows, 0 lost

Rebuilt from the same six directories and the same deterministic samples
(`built-ins/Reflect` every 2nd path, `built-ins/TypedArray/prototype` every
14th); the per-directory row counts reproduce rounds 1-2 exactly (298 / 207 /
30 / 92 / 77 / 101 = 805). Every chunk is IDENTICAL between the trees — same
totals AND the same non-pass `status path` set, line for line.

| chunk | set | rows | base = branch |
| --- | --- | --- | --- |
| cc1-00/01 | `built-ins/Function/prototype` (minus the acceptance overlap) | 298 | 250 pass / 45 fail / 3 CE |
| cc2-02/03 | `built-ins/Object/prototype` (minus the overlap) | 207 | 190 pass / 17 fail |
| cc3-04 | `built-ins/Error/prototype` (minus the overlap) | 30 | 28 pass / 2 fail |
| cc4-05 | `language/expressions/call` | 92 | 72 pass / 20 fail |
| cc5-06 | `built-ins/Reflect`, every 2nd path | 77 | 68 pass / 8 fail / 1 CE |
| cc6-07 | `built-ins/TypedArray/prototype`, every 14th path | 101 | 69 pass / 32 fail |
| **total** | | **805** | **677 pass / 124 fail / 4 CE** |

The totals match round 1's recorded table line for line, which is the check
that the control set was rebuilt correctly and not merely re-described. The
sampling caveat from round 1 still applies and is not papered over: `Reflect`
and `TypedArray/prototype` are samples, the three directories where this change
can bite (`Function/prototype`, `Object/prototype`, `Error/prototype`) were run
in full.

Equivalence gate: exit 0 — 1720 passing, 22 known failures, no new regressions.

### Zero host imports

`result.imports` is `[]` on every probe that exercises the new arm, asserted in
the pin file's shared `runLines` helper. All four natives it calls are
`registerNative`, not `ensureLateImport` — the distinction that ruled
`__extern_is_object` out in round 2.

### Pins

`tests/issue-6493-first-class-builtin-method-values.test.ts` — 11/11 green, two
new `it`s. The first pins both halves plus two order-preservation properties a
sloppier fix would break: a trap that THROWS propagates its own completion
unchanged (`RangeError`, not this arm's TypeError), and the trap runs EXACTLY
ONCE (`n === 1` — a success bit inferred by re-reading the property would show 2
and add an observable `getOwnPropertyDescriptor` trap call). The second is the
ordinary-receiver control, including the two trap-absent proxy lines that would
be the first casualty of believing `__proxy_set_dispatch`'s placeholder.

Both were run against the round-2 tip `2358e2383b` to confirm they are pins and
not decoration. RED there on exactly four lines and no others: `defineFalse`
NO-THROW, `setFalse` NO-THROW, `defineThrows` NO-THROW, and `defineTrue` with
`n=0` (the trap never ran at all). Every line of the ordinary-receiver `it`,
including both trap-absent proxies, reads the SAME on the round-2 tip as here —
which is what makes it a control rather than a second copy of the first test.

### New residual, measured here — a `$Proxy` in a shape-typed local is NULLED

`lib.d.ts` types `new Proxy<T>(target, handler)` as `T`, so `var p = new
Proxy({stack: 'old'}, …)` gives `p` the TARGET'S OBJECT SHAPE as its static
type. The `$Proxy` carrier fails that struct's downcast on the way into the
typed local, and the binding reaches every later use as a **null externref**.

Measured three ways on this branch: `id(p)` sees `x === null`; `c.call(probe,
p)` binds `this` to **globalThis** (the sloppy nullish-this substitution) rather
than to `p`; and the stack setter dies at its own §1 receiver check. A proxy
over an EMPTY object literal (`{}` → no struct shape), one built inline in the
call, or one over an `any`-typed target (`JSON.parse(...)`) all survive intact —
which is how the arm above was proved on a receiver that actually arrives.

This is **pre-existing and unrelated** to #6493 (it reproduces for a plain user
function with no accessor involved), but it has a specific consequence worth
recording: in `setter-proxy-trap-rejects.js` the (b) receiver is spelled `new
Proxy({ stack: 'old' }, …)` and is therefore nulled, so half (b) of that ROW
passes off the §1 TypeError rather than off §Set step 4. Half (a)'s receiver is
`new Proxy({}, …)` and is genuinely exercised. Both halves are pinned
genuinely in the test file, where the (b) receiver is spelled so it survives.
`setter-proxy-trap-throws.js` stays failing for the same reason — its (c) case
uses the shape-typed spelling.
