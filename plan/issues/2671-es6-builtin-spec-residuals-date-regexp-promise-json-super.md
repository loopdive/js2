---
id: 2671
title: "ES2015 builtin/feature spec residuals: Date, RegExp, Promise, JSON, super (~400 fails — tracking, slice per area)"
status: ready
created: 2026-06-25
updated: 2026-07-02
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: builtins, regexp, promise, date, json, super
goal: spec-completeness
related: [1343, 1440, 1444, 1439, 1465, 1368, 1551, 1342]
sprint: current
---

# #2671 — ES2015 builtin/feature spec residuals (Date / RegExp / Promise / JSON / super)

## Edition / impact

- **Edition:** ES2015.
- **Fail count (residual after the canonical done issues):**
  - `built-ins/Date` — **104** (residual of #1343, #1440)
  - `built-ins/RegExp` — **95** (residual of #1444, #1439, Symbol.\* protocol)
  - `built-ins/Promise` — **76** (residual of #1465, #1368)
  - `built-ins/JSON` — **44** (#1342 was wont-fix; reviver/replacer descriptor edges)
  - `language/expressions/super` — **68** (residual; #1551 ready covers eval order)
- **Tracking issue.** The canonical per-feature issues are all `done`; these are
  the long tails. This bundles them so the lead can slice one area at a time
  rather than leave the residuals un-issued. Lower priority than the structural
  clusters (#2666–#2670) — these are narrower, more scattered edge cases.

## Sub-area notes & sample failures

### Date (104)

Missing/incomplete `toISOString` (`toISOString is not a function`),
`set*`-with-`ToNumber`-coercion side-effect ordering, `proto-from-ctor-realm-*`,
annexB `getYear`/`setYear` + not-a-constructor checks.

```
built-ins/Date/prototype/toISOString/15.9.5.43-0-11.js
built-ins/Date/prototype/setSeconds/arg-ms-to-number.js
annexB/built-ins/Date/prototype/getYear/not-a-constructor.js
```

> **The `toISOString is not a function` cluster is NOT a Date-method gap — it
> reduces to the structural dispatch issue #2767.** Root-caused 2026-06-28: the
> ~11 `toISOString` (and ~4 other Date-prototype) failures all use the bare-`var`
> shape `var date; date = new Date(…); date.toISOString()`. An uninitialized /
> untyped `var`/`let` is typed `any`/externref, so the nominal-symbol gate in
> `compileDateMethodCall` (`symName !== "Date"`) bails to the generic dynamic
> path and the host throws `toISOString is not a function`. The typed form
> (`const d = new Date(0)`) already works. Fixing #2767 (recover the assigned
> nominal type for a bare-`var` receiver at the call-dispatch hub) flips this
> whole Date cluster at once — and the same fix generalizes to DataView /
> ArrayBuffer / RegExp bare-`var` receivers. **Do the Date `toISOString` residual
> via #2767, not as a Date-specific patch here.**

**Progress (dev-2046, 2026-06-25):**

- ✅ **`getYear` (Annex B §B.2.4)** — was MISSING entirely (returned
  undefined/null; `setYear` existed but not the getter). Added to `DATE_METHODS`
  / `DATE_PROTO_METHODS` + a `getFullYear()-1900` codegen arm (NaN-guarded).
  `annexB/.../getYear/` test262: 6/7 pass (the 1 fail is `not-a-constructor.js`,
  the general #930-family "method is not a constructor" gap shared by ALL Date
  methods — not getYear-specific). `tests/issue-2671-getyear.test.ts` 6/6.
- 📋 **`Date.parse` / `new Date(str)` NaN in HOST mode** — carved to **#2678**.
  The native parser (`__date_parse`, #2164) works but is gated standalone/WASI-
  only; host wiring needs js-string-externref support (dual-mode change), too big
  to fold into the `getYear` quick win.
- ⏳ Remaining Date: `set*` ToNumber-coercion side-effect ordering,
  `proto-from-ctor-realm-*`, not-a-constructor (#930-family).

**Progress (dev-builtin2671c, 2026-06-26): `set*` Invalid-Date
[[DateValue]]-clobber on ToNumber side-effect — SHIPPED (+12 test262).**

Verified-first against the real test262 harness (`runTest262File`, `setExports`
wired — critical: a `: any` receiver routes through generic host dispatch and
silently bypasses the typed Date codegen, so the repro/test must let `dt` infer
as `Date`, matching the plain-JS test262 source).

Root cause in `compileDateMethodCall` (`src/codegen/expressions/builtins.ts`):
the time-of-day setters (`setSeconds/setMinutes/setHours/setMilliseconds` +UTC)
and the calendar setters `setDate/setMonth` (+UTC) read `t = [[DateValue]]`
FIRST, then ToNumber each arg, then — §21.4.4.\* step "If t is NaN, return NaN" —
return WITHOUT writing `[[DateValue]]`. The compiler's invalid-branch wrote the
Invalid-Date sentinel **unconditionally**, clobbering a `[[DateValue]]` that a
ToNumber side-effect (`value.valueOf()` calling `this.setTime(0)`) had
legitimately re-set. Fixed both then-branches to write the sentinel only when
the receiver was still VALID before the call (`curTs != sentinel`) and an arg
invalidated it; an already-invalid receiver now returns NaN without touching the
slot.

- `setFullYear/setUTCFullYear/setYear` (§21.4.4.21) are exempt — they
  re-validate an Invalid receiver to `t=+0` and ALWAYS write — and were already
  correct; their `isSetFullYear` then-branch keeps the unconditional write.
- Flips 12 `built-ins/Date/prototype/<setter>/date-value-read-before-tonumber-when-date-is-invalid.js`
  (the 12 non-FullYear setters; FullYear's 2 already passed). 230/232 pass across
  the touched `set*`/`get*` dirs — the 2 residual setFullYear fails
  (`15.9.5.40_1.js` not-a-constructor #930-family, `arg-year-to-number.js` valueOf
  calling-convention) are pre-existing and unrelated.
- Guard: `tests/issue-2671-date-setter-ordering.test.ts` (41/41).
- ⏳ Remaining Date: `proto-from-ctor-realm-*`, not-a-constructor (#930-family),
  `A4` multi-arg ctor `PoisonedValueOf` (object→f64 ToNumber on class instances).

### RegExp (95)

`Symbol.split` / `Symbol.match` / `Symbol.replace` / `Symbol.search` protocol
edge cases: `lastIndex` get/coerce errors, species constructor validation,
`exec` lastIndex access ordering, ToPrimitive on species ctor.

```
built-ins/RegExp/prototype/Symbol.split/str-get-lastindex-err.js
built-ins/RegExp/prototype/Symbol.split/species-ctor-ctor-non-obj.js
built-ins/RegExp/prototype/exec/success-lastindex-access.js
```

**Progress (dev-2671e, 2026-06-26): RegExp `lastIndex` value-preserving data
slot (§22.2.7.2 RegExpBuiltinExec step 4) — SHIPPED.**

Verified-first against current main through the real worker harness (`compile` +
`__setExports` + `wrapExports`). Root cause: the extern `RegExp` interface typed
`lastIndex` as `number`, so the host import eagerly `ToNumber`'d any assigned
value at WRITE time. The spec instead stores whatever is assigned **verbatim**
and coerces only inside `exec` (`lastIndex = ToLength(? Get(R, "lastIndex"))`,
writing back only when the regex is global/sticky). On pristine main,
`r.lastIndex = {valueOf(){…}}` followed by a non-global `r.exec(s)` returned
`r.lastIndex !== counter` (identity discarded — the eager set stored the coerced
number), failing `assert.sameValue(r.lastIndex, counter)`; on the dynamic-receiver
path the eager coerce of an opaque WasmGC struct threw "Cannot convert object to
primitive value".

Host-mode-scoped fix in three parts:

- **`src/codegen/index.ts`** (`collectInterfaceMembers`): carry
  `RegExp.lastIndex` as `externref` (not `number`) in **host mode only**
  (`!ctx.standalone && !ctx.wasi`) so the raw value round-trips through the native
  RegExp; numeric uses coerce at the use site, the exec-time ToLength runs in
  native code. Standalone/WASI keep their native struct-field RegExp path
  untouched (the `RegExp_*_lastIndex` extern import is never emitted there).
- **`src/runtime.ts`** (`resolveImport`, RegExp `lastIndex` get/set): the
  **default (deferred)** representation stores a struct behind a small coercion
  shim (`_makeLastIndexShim`) whose ToPrimitive bridges to `_hostToPrimitive`, so
  native exec / the protocol ToLength fire the struct's `valueOf` once (a throw
  surfaces as the program's own error); the get-import unwraps the shim back to
  the raw struct so an explicit `r.lastIndex` read keeps object identity. Numbers
  pass through verbatim; the global/sticky numeric write-back is unchanged.
- **`src/runtime.ts`** (`__regex_symbol_call` protocol-depth carve-out): the one
  case the deferred shim cannot cover — a `lastIndex` set performed by a
  user-overridden `exec` _invoked from_ `RegExp.prototype[@@replace]` — because
  native V8 @@replace does **not** ToLength the JS-visible `lastIndex` in its
  empty-match advance (verified: `execCalls=2`, `valueOf` count `0`). A
  `_regexProtocolDepth` counter (inc/dec around the protocol dispatch, `finally`)
  marks sets that happen _during_ a protocol call; those coerce eagerly so a
  throwing `valueOf` surfaces at the assignment (§22.2.5.8 "abrupt completion
  during coercion of lastIndex"). Sets outside any protocol stay deferred.
- Flips **8** `built-ins/RegExp` files: `exec/success-lastindex-access`,
  `exec/failure-lastindex-access`, `exec/failure-g-lastindex-reset`,
  `exec/S15.10.6.2_A4_T11`/`_T12`, `Symbol.match/builtin-y-coerce-lastindex-err`,
  `Symbol.matchAll/this-tolength-lastindex-throws`, and keeps
  `Symbol.replace/coerce-lastindex-err` green (the proxy-only first cut regressed
  this one; the protocol-depth carve-out fixes it). Guard:
  `tests/issue-2671-regexp.test.ts` (8/8). **Differential vs pristine main: +7
  pass, 0 regressions** across 340 protocol/exec/test files and all 64
  `lastIndex`-named `built-ins/RegExp` tests (sequential `runTest262File`); 228/228
  broad host-mode regex vitest tests pass; String.prototype.replace/split/match
  (which route through the same protocol path) verified correct. The
  standalone-refusal failures (`issue-1474`/`issue-1539-*`/`issue-2161-matchall`)
  pre-exist on pristine main (unrelated — standalone is gated out).
- ⏳ Remaining RegExp: `Symbol.split`/`Symbol.replace` protocol (species ctor
  validation + dynamic `exec`/`lastIndex` dispatch on arbitrary objects), dotAll
  lone-surrogate string-rep (deep string-backend), `str-get-lastindex-err`
  (Symbol.split lastIndex getter-error ordering — separate root cause).

### Promise (76)

resolve-element function attributes (extensible/own-props), invoke-resolve
error-close paths, race/all resolver-element edge cases, `then` spec asserts.

```
built-ins/Promise/all/resolve-element-function-extensible.js
built-ins/Promise/all/invoke-resolve-error-close.js
built-ins/Promise/prototype/then/S25.4.5.3_A1.1_T2.js
```

**Progress (agent-af359e7cc95c024c6, 2026-06-28): GetCapabilitiesExecutor
functions — `Promise.resolve`/`Promise.reject` capability-ctor sites — SHIPPED
(+6 test262).**

Verified-first through the real worker harness (`compile` + `__setExports` +
`wrapExports`). Root cause: V8's `Promise.resolve.call(C)` / `Promise.reject.call(C)`
run PromiseResolve(C) → NewPromiseCapability(C) → `Construct(C, «executor»)`,
exactly like the four aggregators. When `C` is a user
`function NotPromise(executor){ executor(fn1, fn2); }` (lowered to a WasmGC
closure), the `executor(...)` call must wrap its closure arguments into
host-callable functions through the `__call_function` host helper — otherwise
V8's NewPromiseCapability throws "Promise resolve or reject function is not
callable" (the wasm closures reach V8 as opaque structs). The codegen gate
`calleeIsCapabilityCtorParam` (src/codegen/expressions/calls.ts) scanned only
`Promise.{all,allSettled,race,any}.call(<fn>, …)`, so the `resolve`/`reject`
capability sites fell through and the executor's closure args were never wrapped.

- Fix: add `resolve`/`reject` to the scanned combinator set (one-line, additive,
  JS-host-only — the `emitBoundFunctionCall` route is already gated by
  `!ctx.standalone && !noJsHost(ctx)`, so standalone/WASI is untouched).
- Flips **6** `built-ins/Promise/executor-function-*` files: `-extensible`,
  `-length` (length 2), `-name` (""), `-not-a-constructor` (no own `.prototype`),
  `-prototype` (`[[Prototype]]` === Function.prototype), `-property-order`
  (length,name). Top-level `built-ins/Promise` survey: 46→52 pass, 0 regressions;
  `resolve/` (26/4) and `reject/` (12/3) subdirs byte-identical vs pristine main
  (baseline-toggle differential). `tests/promise-combinators.test.ts`'s 2
  pre-existing failures are unrelated (present with the change reverted).
- Guard: `tests/issue-2671-promise-executor.test.ts` (14/14).

**Progress (dev-2937f, 2026-07-02): capability slice 2 — fn statics + prelude
`thrower` + thenable-element marshaling — SHIPPED (+28 test262, measured by
full failing-Promise sweep, 0 regressions in a 29-file passing sample + 38-file
cross-area sample).**

Reground 2026-07-02 (fresh baseline): Date 57 / RegExp 129+7CE / Promise 132+5
/ JSON 45+4CE / super 75. Biggest single-signature bucket: 25× "Promise resolve
or reject function is not callable" — the `Promise.<agg>.call(Constructor,
[thenables])` family. Root-caused as THREE stacked gaps, all fixed:

1. **Compiler (`src/codegen/declarations.ts`)** — a TOP-LEVEL `F.<prop> = …`
   static write on a function DECLARATION was silently dropped from
   `__module_init` (the keep-in-init scan only recognized module-global roots
   — same bug class as the documented #1268/#2660-S2 keeps beside it). So
   `Test262Error.thrower = fn` (real sta.js) never existed. Fixed with a
   narrowly-scoped keep: direct `F.<name> = …` (bare-identifier receiver, name
   ≠ `prototype` — prototype chains stay with the compile-time fnctor lift)
   where `F ∈ topLevelFunctionNames`, host lanes only (standalone
   byte-identical).
2. **Harness (`tests/test262-runner.ts`)** — the synthesized prelude's
   `Test262Error` CLASS lacked the real sta.js `thrower` static entirely.
   Added as a static METHOD (marshals host-callable as a value; the
   assignment form would hit the classSet variant of gap 1).
3. **Host runtime (`src/runtime.ts` `_toIterable`)** — a wasm object-literal
   THENABLE element crossed as a RAW struct; V8's
   `Invoke(C.resolve(elem), "then", «resolveElement, reject»)` found no
   `.then` → aggregate rejected. Now wraps ONLY then-bearing structs
   (detected via `__sget_then` + `_safeGet` fallback — note `_safeGet` alone
   reads sidecar/accessor/proto layers, NOT struct-shape fields) in the
   `_wrapForHost` live-mirror; non-thenables pass through raw (identity
   preserved).

- Flips **28** `built-ins/Promise` files: `new-resolve-function`,
  `same-{resolve,reject}-function` ×3, the full `resolve-element-function-*` /
  `reject-element-function-*` attribute families (all/allSettled/any), and
  `invoke-resolve-on-{promises,values}-every-iteration-of-*`.
- Guard: `tests/issue-2671-promise-capability.test.ts` (3/3).
- ⏳ Remaining Promise (~107), bucketed with root causes:
  - **#2976 (filed this slice)**: `call-resolve-element*` /
    `resolve-before-loop-exit*` / `resolve-from-same-thenable*` (~10) — the
    variants whose `Constructor` declares a CAPTURING inner `resolve`: a
    capture-carrying nested fn decl materializes a FRESH closure per
    reference (`Constructor === Constructor` → false), so the
    `Constructor.resolve` static lands on a dead instance → V8 "resolve is
    not a function". Compiler substrate — measured & filed as #2976.
  - `new-{resolve,reject}-function` allSettled/any variants (~4): p2.then's
    captured-counter increment doesn't write back (capture-writeback family,
    #2826-adjacent) — p1's does; needs its own verification pass.
  - `any/*` AggregateError `.errors` marshaling (~4): `error.errors.length`
    reads 0.
  - invoke-resolve error-close paths, `then` spec asserts (as before);
    `allKeyed/*` (proposal dir, ~10 "Cannot convert undefined to object").

### JSON (44)

reviver/replacer with non-configurable / define-prop-err properties
(`Object.defineProperty called on non-object` — ties to #2668), replacer
wrong-type handling, function values.

```
built-ins/JSON/parse/reviver-array-non-configurable-prop-delete.js
built-ins/JSON/stringify/replacer-wrong-type.js
```

**Progress (agent-ae565d4893a5783d7, 2026-06-26): JSON.stringify array-replacer
PropertyList slice — SHIPPED.**

Verified-first against the fresh baseline jsonl (JSON area = **55** standalone
fails, not 44 — the gross count is higher than the residual estimate; the other
four areas measured Date 100 / RegExp 178 / Promise 145 / super 81). Reproduced
on current main with single-file processes through the real worker harness
(`setExports` wired — critical: without it the array-replacer branch is silently
disabled and _every_ replacer test mis-reports as a fail).

Three host-runtime (`src/runtime.ts`) bugs in the array-form replacer, all
fixed (JSON.stringify-scoped — `_liveGet` has 5 callers, all in the JSON
serialize/toJSON walk; `_normaliseJsonReplacer`/new `_buildJsonPropertyList`
feed only JSON.stringify):

- **Absent PropertyList keys emitted with a zero default** instead of dropped:
  the live walk read each key via `_liveGet`, which invoked a module-global
  `__sget_<key>` getter on a struct lacking that field — those return `0`/`null`,
  not `undefined`. `JSON.stringify({a:{b:2,c:3}}, ['c','b','a'])` produced
  `{"c":0,"b":0,"a":{"c":3,"b":2,"a":null}}`. Gated the getter on the canonical
  `_wasmStructHasOwn` own-property check (true for every real field, so present
  fields and accessor/getter own-props are unaffected).
- **No de-duplication** of the PropertyList (`['key','key']` kept both) — §25.5.2.1
  step 4.b.iv requires "append only if not already present".
- **String/Number wrapper-object elements** (`new String`/`new Number`) were
  ignored instead of ToString'd into keys.
- Fixed tests: `replacer-array-order`, `replacer-array-number-object`,
  `replacer-array-string-object` (fail→pass; `tests/issue-2671-json-replacer.test.ts`
  8/8). 25 currently-passing JSON tests spot-checked — no regression.
- ⏳ Remaining JSON: `replacer-array-duplicates`/`-undefined`/`-empty` (getter
  side-effect counting + sparse/hole handling), reviver descriptor edges (ties to
  #2668), Proxy/BigInt/circular cases — separate root causes, not in this slice.

**Progress (dev-builtin2671, 2026-06-26): JSON.stringify §25.5.2 host-runtime
serialization fidelity (wrong-type replacer + circular crash) — SHIPPED.**

Verified-first through the real harness (`runTest262File`, `setExports` wired).
Two `src/runtime.ts` host-runtime bugs, both rooted in `_wasmToPlain`
mis-treating a non-vec WasmGC struct as an empty array (`__vec_len`'s not-a-vec
default is 0, indistinguishable from an empty vec):

- **Non-array object replacer not ignored** (§25.5.2.1 step 4.b):
  `JSON.stringify({key:[1]}, {})` produced `"{}"` (the empty `{}` materialised
  as `[]` → empty PropertyList that filtered every key) instead of the full
  `'{"key":[1]}'`. Fixed in `_normaliseJsonReplacer` by gating the PropertyList
  path on the **positive** `__is_vec` discriminator (`ref.test` over all
  registered vec types); a plain object answers 0 and falls through to "no
  replacer". Genuine array replacers cross the host boundary as real JS arrays
  and hit the existing `Array.isArray` branch, so they are unaffected.
- **Circular structure stack-overflows instead of throwing TypeError**
  (§25.5.2.5/6 step 1): `var o:any={}; o.prop=o; JSON.stringify(o)` recursed
  `_wasmToPlain → _structToPlainObject → _wasmToPlain` (via the `__sget_prop`
  field getter) until a host RangeError "Maximum call stack size exceeded". Added
  an opt-in, **path-scoped** `seen` set threaded through `_wasmToPlain` /
  `_structToPlainObject` (added before descending, removed in `finally`, so a DAG
  with shared-but-acyclic refs still flattens); the JSON fast path passes a fresh
  set, all non-JSON callers omit it (behaviour unchanged). A self-referential
  struct now throws the spec TypeError.
- Guard: `tests/issue-2671-json-replacer.test.ts` extended to 15/15 (8 prior + 7
  new wrong-type/array-replacer cases). Acyclic/DAG/shared-ref JSON verified
  byte-identical; `built-ins/JSON/stringify` survey unchanged at 35 pass / 31
  fail (no regression).
- ⚠️ **Harness blockers — these correct fixes do NOT flip their test262 files**
  (recorded so future devs don't re-chase them):
  - `replacer-wrong-type.js` / `space-wrong-type.js` — `wrapTest`'s
    `assert_sameValue(..., (true|false))` rewrite regex (test262-runner.ts
    ~L2000) is not paren-balanced, so `assert.sameValue(JSON.stringify(obj,
true), json)` is mis-wrapped as `assert_sameValue_bool` (it greedily matches
    the _inner_ `, true)`). The replacer fix advances `replacer-wrong-type` from
    failing at assert #1 to assert #8 (the mis-wrapped `true` line). Needs a
    harness regex fix (tester scope), not a compiler change.
  - `value-array-circular.js` — uses a **typed** `var direct = []` which routes
    JSON.stringify through a separate typed-array serialization path (not
    `_wasmToPlain`); the cycle there does not throw. `value-object-circular.js`
    needs the nested object-literal getter (`get p3(){…}`) case too (assert #2
    hits a separate codegen null-deref). Both need typed-path / getter work.
- ⏳ Remaining JSON value cases (separate, deeper root causes): function values
  inside arrays/objects render as `[[]]`/`{"key":[]}` instead of `[null]`/`{}`
  (captureless closures answer `__is_closure`=0, then mis-flatten as `[]`);
  Symbol values leak as a numeric id; lone-surrogate string escaping; BigInt
  (gated).

**Other areas — verified NOT independent of the deferred member-dispatch /
string substrate (do NOT pick these before the proto-read substrate lands):**

- **RegExp Symbol.split** (8, all "Cannot convert object to primitive value"):
  bottoms out in `Symbol.species` construction + dynamic `exec`/`lastIndex`
  dispatch on arbitrary objects.
- **RegExp dotAll** (~8): root cause is lone-surrogate string representation
  (`"\uD800"` literal reaches the host `length` import as `undefined`) — a deep,
  broad string-backend issue, high regression risk.
- **super** (81): prototype-chain member dispatch.
- **Date** (100): scattered singletons; the cleanest cluster (`A4` multi-arg
  ctor `PoisonedValueOf`, 7) needs object→f64 ToNumber on class instances.

### super (68)

super-property access on null-proto / computed key errors, `super(...spread)`
argument-list evaluation + getter side effects (eval order is #1551).

```
language/expressions/super/prop-dot-cls-null-proto.js
language/expressions/super/call-spread-err-sngl-err-expr-throws.js
```

## Acceptance criteria

- This is a **tracking issue**; ship by area. Per-area target: pass **≥ 50%** of
  that area's residual fails.
- When an area is taken on, either reopen the canonical issue (#1343/#1440 Date,
  #1444/#1439 RegExp, #1465/#1368 Promise, #1551 super) or spin a child issue;
  update this tracker.
- No regression in currently-passing tests for the touched area.

## Notes

- JSON reviver descriptor failures partially resolve once #2668 (defineProperty
  fidelity) lands — sequence JSON after #2668.
- Deprioritized relative to #2666–#2670; pick up after the structural clusters.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — tracking umbrella. The referencing PR landed the RegExp lastIndex value-preserving data-slot slice (host). Date / Promise / JSON / super areas remain (~400 fails); slice per area. Stays ready as the tracker.

## Landed slices (reconcile 2026-07-02)

Per-area slices merged so far (all `fix(#2671)` PRs):

- **Date**: PR #2076 (`Date.prototype.getYear`, Annex B §B.2.4), PR #2129
  (`set*` must not clobber `[[DateValue]]` re-set during `ToNumber`).
- **RegExp**: PR #2134 (`lastIndex` value-preserving data slot, host mode).
- **JSON**: PR #2100 (`JSON.stringify` array-replacer PropertyList fidelity),
  PR #2127 (wrong-type replacer + circular-structure crash).
- **Promise**: PR #2225 (Promise.resolve/reject capability-ctor sites, +6 test262).

**super** area untouched so far. Stays `ready` as the tracker — acceptance is
per-area ≥50% of the residual fails, not yet measured/claimed for any area.
