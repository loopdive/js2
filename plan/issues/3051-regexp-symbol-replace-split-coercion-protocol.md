---
id: 3051
title: "RegExp.prototype[@@replace] / [@@split] coercion protocol: ToString/ToInteger/ToLength on result-array + lastIndex/limit/flags args (~48 fails)"
status: in-progress
assignee: dev-3051c
sprint: current
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
model: fable
architect_spec: done
created: 2026-07-05
task_type: bugfix
area: codegen, runtime
language_feature: regexp, symbol-replace, symbol-split, abstract-operations
es_edition: 6
goal: spec-completeness
test262_category: built-ins/RegExp/prototype/Symbol.replace, built-ins/RegExp/prototype/Symbol.split
test262_fail: 48
related: []
---

# #3051 — RegExp `[@@replace]` / `[@@split]` coercion protocol

## Source

Default-lane test262 harvest of current main
(`.test262-cache/test262-current.jsonl`, 2026-07-02 promoted baseline). **48**
fails under `built-ins/RegExp/prototype/Symbol.replace/*` (31) and
`built-ins/RegExp/prototype/Symbol.split/*` (17). Flagged as dev-sized during the
harvest (dev-3025) but not filed at the time (the `claim-issue.mjs --allocate`
ref was contended). Error breakdown: 35 `assertion_fail`, 11 `runtime_error`
(`Cannot convert object to primitive value` / `Cannot convert a Symbol value to a
number`), 2 `compile_timeout` (`poisoned-stdlib.js`,
`last-index-exceeds-str-size.js` — likely a hot loop / recompile blowup, may be a
separate concern).

## Problem

Our `RegExp.prototype[@@replace]` and `[@@split]` implementations do NOT perform
the spec-mandated abstract-operation coercions on their inputs and on the exec
**result array**. The two clusters:

### A. `@@replace` result-array coercion (spec §22.2.6.11, the bulk — ~20 files)

After each `RegExpExec(rx, S)`, the algorithm reads the result **through the
ordinary Get/ToXxx protocol**, so a user-subclassed / proxied result object's
getters and coercions must run in the right order:

- `result-coerce-matched*` — `matched = ? ToString(? Get(result, "0"))`.
- `result-coerce-index*` — `position = ? ToIntegerOrInfinity(? Get(result, "index"))`, then clamp to `[0, length]`.
- `result-coerce-length*` — `nCaptures = max(? ToLength(? Get(result, "length")) - 1, 0)`.
- `result-coerce-capture*` — each capture `? ToString(capN)` (unless undefined).
- `result-coerce-groups*` / `result-get-groups-prop*` — `groups = ? Get(result, "groups")`; named-group substitution reads coerce.
- `result-get-*-err` / `result-coerce-*-err` — the corresponding getter/coercion **throwing** must propagate (abrupt completion), not be swallowed.

The `*-err` variants prove ordering + abrupt propagation; the plain `*-coerce`
variants prove the coercion actually runs (e.g. an `index` of `"2"` string or a
boxed Number must be `ToIntegerOrInfinity`'d).

### B. arg / lastIndex / limit / flags coercion (~28 files across both)

- `@@replace` `arg-2-coerce*` — the replacement value, when not callable, is
  `? ToString(replaceValue)`; `coerce-global` / `coerce-unicode` — `global` /
  `unicode` flags read via `? ToBoolean(? Get(rx, "global"|"unicode"))` (the
  `runtime_error: Cannot convert a Symbol value to a number` is this flag read on
  a value that must coerce, not trap).
- `@@replace` `coerce-lastindex` / `g-pos-increment|decrement` — after a
  zero-length match with `global`, `lastIndex` is `? ToLength(? Get(rx,
"lastIndex"))` then `AdvanceStringIndex`.
- `@@split` `coerce-limit-err` / `toint32-limit-recompiles-source` — `limit` is
  `? ToUint32(limit)`; `limit-0-bail` — a `0` limit returns `[]` immediately.
- `@@split` `coerce-flags` / `str-coerce-lastindex` / `str-get-lastindex-err` /
  `str-set-lastindex-*` — flags string via `? ToString(? Get(rx, "flags"))`, and
  the splitter's `lastIndex` get/set protocol.
- `@@split` `species-ctor*` — `C = ? SpeciesConstructor(rx, %RegExp%)`, then
  `splitter = ? Construct(C, [rx, newFlags])`; the `species-ctor-*-non-obj` /
  `-non-ctor` variants must `TypeError`.

## Sample failing files

- `Symbol.replace/result-coerce-index.js`, `result-coerce-length.js`,
  `result-coerce-matched.js`, `result-coerce-capture.js`,
  `result-coerce-groups.js` (+ their `-err` twins).
- `Symbol.replace/arg-2-coerce.js`, `coerce-global.js`, `coerce-unicode.js`,
  `coerce-lastindex.js`, `g-pos-increment.js`.
- `Symbol.split/coerce-limit-err.js`, `coerce-flags.js`,
  `str-coerce-lastindex.js`, `species-ctor.js`, `species-ctor-y.js`,
  `limit-0-bail.js`.

## Suggested approach

1. Locate the `@@replace` / `@@split` lowering (grep `Symbol.replace` /
   `@@replace` / `symbolReplace` in `src/codegen/` and the RegExp runtime helper
   in `src/runtime.ts`). Identify whether these are host-imported JS helpers or
   Wasm-native — the coercions must run either way (dual-mode).
2. Thread the exec **result array** reads through the real Get + ToString /
   ToIntegerOrInfinity / ToLength protocol (Cluster A) — this is the largest,
   most self-contained slice (~20 `result-*` files) and a good first PR.
3. Then the arg/lastIndex/limit/flags coercions (Cluster B) — `ToString` on the
   replacement, `ToBoolean` on flag gets, `ToUint32` on `limit`, `ToLength` on
   `lastIndex`, and `SpeciesConstructor` for `@@split`.
4. The 2 `compile_timeout` files (`poisoned-stdlib.js`,
   `last-index-exceeds-str-size.js`) may be a separate hot-loop/recompile issue —
   defer / split out if they don't fall out of the coercion fixes.

Net-positive slices; verify no regression in the passing
`Symbol.replace`/`Symbol.split` corpus and in `String.prototype.replace` /
`String.prototype.split` (which delegate to these).

## Acceptance criteria

- The `result-coerce-*` / `arg-*-coerce` / `coerce-*` / `species-ctor-*`
  `Symbol.replace` and `Symbol.split` files pass (materially below the 48
  recorded here).
- No regression in currently-passing `RegExp`/`String` replace/split tests.

## Landed Slice 1 (dev-3051) — result-array coercion via exec-return host-wrap

**PR: exec-override result-object host-wrapping** (`src/runtime.ts`,
`tests/issue-3051.test.ts`). Root cause found by regrounding: in the default
(JS-host) lane, `re[Symbol.replace/split/match/search](...)` is delegated to the
**native V8** protocol via the `__regex_symbol_call` host import. When a test
overrides `regexp.exec = fn` (the bulk of the `result-*` cluster), the compiled
`fn` returns a **compiled object literal** used as the match result. Object
literals are opaque WasmGC structs, so when V8's native protocol did
`Get(result, "0" | "index" | "length" | "groups")` on the returned struct it
read `undefined` — the spec `ToString` / `ToIntegerOrInfinity` / `ToLength`
coercions (and nested `valueOf`/`toString` on capture/index sub-objects) never
ran. Fix: when `regexp.exec = fn` is stored (the `extern_set` / `extern_set_strict`
host bindings, guarded on `key === "exec" && obj instanceof RegExp`), wrap `fn`'s
**return value** in `_wrapForHost` (`_wrapExecReturnForHost`) so the native
protocol observes the struct's fields and dispatches the nested closures.
Arrays / non-struct returns pass through unchanged. Covers @@replace, @@split,
@@match, @@search (all read exec's result the same way).

**Impact (local default-lane, measured):**

- `Symbol.replace`: 39 → 54 pass (**+15**); `Symbol.split`: 28 → 28 (unchanged).
- Newly passing: `result-coerce-{index,index-undefined,matched,matched-global,capture,length,groups}` and their `-err` twins where the throw was already in the coercion arm, plus `coerce-lastindex`, `g-pos-increment`, `g-pos-decrement`.
- No in-corpus regressions; `issue-1329-b3` / `issue-2161` still green. (`issue-682`'s 4 failures are **pre-existing** on `origin/main`, unrelated — standalone refusal tests.)

## Landed Slice 2 (dev-3051b) — replaceValue ToString bridge + flag Symbol-coercion

**PR: `src/runtime.ts` (`wrapCallable` data-struct guard) + `src/codegen/index.ts`
(RegExp `.global`/`.unicode` externref retype) + `tests/issue-3051.test.ts`.**
Two dev-doable clusters from the Slice-1 remaining list:

- **replaceValue `ToString` (cluster 2 — `arg-2-coerce{,-err}`):** in
  `__regex_symbol_call`, the second @@replace/@@split arg was routed through
  `wrapCallable`, whose `_wrapWasmClosure` probe **false-positives on ANY struct**
  when the module exports `__call_fn_N` (it checks dispatcher existence, not
  closure-ness). So a non-callable object-literal replaceValue
  (`{toString(){…}}`) got wrapped as a callable bridge → V8 saw
  `functionalReplace = true`, INVOKED it, and `ToString` of the bogus return was
  `"null"`. Fix: gate `wrapCallable` on the **positive `__is_data_struct`
  discriminator** (same marker `_wrapForHost`'s get-trap uses) — a data struct
  routes straight to `_wrapForHost` (property proxy) so native `ToString` /
  `ToPrimitive` reaches its `toString`/`valueOf` closure fields; genuine closures
  are never in the data-struct set, so functional replace is unchanged.
- **flag Symbol-coercion (cluster 3 — `coerce-global`, `coerce-unicode`):**
  test262 re-marks the spec-readonly `.global`/`.unicode` writable
  (`Object.defineProperty(r,'global',{writable:true})`) then assigns arbitrary
  values (`r.global = Symbol.replace`). The extern property typed `boolean` made
  the generated `RegExp_set_global(externref, i32)` setter eagerly ToNumber the
  RHS → a Symbol trapped at the wasm boundary before storing. Fix: **retype
  `.global`/`.unicode` to `externref` in host mode** (mirroring the #2671
  `lastIndex` treatment) so the raw value round-trips onto the native RegExp and
  the native @@replace/@@split protocol performs the spec `ToBoolean` itself;
  explicit `r.global` reads coerce externref→boolean at the use site (verified a
  boxed `false` still unboxes falsy, and `=== true`/`=== false` still work).

**Impact (local default-lane, isolated per-file sweep of
`built-ins/RegExp/prototype/Symbol.{replace,split}`, apples-to-apples vs the
same runner on `origin/main`): 83 → 88 pass (+5), zero regressions.** Flips:
`arg-2-coerce`, `arg-2-coerce-err`, `coerce-global`, `coerce-unicode`, and
`Symbol.split/coerce-limit-err` (bonus — the same `wrapCallable` data-struct
guard lets the @@split `limit` object's throwing `valueOf` propagate).
Broader validation: isolated sweep of the delegating corpus (459 files across
`String.prototype.{replace,replaceAll,split,match,matchAll,search}` +
`RegExp.prototype.{global,unicode,Symbol.match,Symbol.matchAll,Symbol.search}`)
showed **0 regressions**; regex vitest suites (issue-1329-b3 / 1539 / 1911 /
1912 / 2161) unchanged (the 2 pre-existing standalone-refusal fails are on
`origin/main` too). `tests/issue-3051.test.ts` — 10/10 pass.

## Landed Slice 3 (dev-3051c) — accessor-only exec-result marshals to null (throwing-getter cluster subset)

**PR: `src/codegen/closures.ts` (`computeClosureWrapperSig`) +
`tests/issue-3051.test.ts`.** Fixes `result-get-{index,length,matched}-err`
(**+3**, zero regressions across the whole `Symbol.replace`+`Symbol.split`
corpus: 88 → 91 pass / 25 → 22 fail on the isolated per-file sweep).

**Root cause — the architect's Cluster-1 hypothesis was WRONG; verified
empirically first (per the "specs turned out incomplete" caveat).** The failure
is NOT a wasm-exn swallowed in the `_wrapForHost` get-trap. It is upstream of any
getter read: the poisoned result object literal has _only_ an accessor and NO
data field (`{ get index(){ throw } }`). Such an accessor-only literal compiles to
a JS-host plain object (externref `$Object`) via `compileObjectLiteralWithAccessors`
(literals.ts:1039), but the `r.exec = function(){ return poisoned; }` closure has a
TS-**inferred structural return type** `{ index: number }`, which `resolveWasmType`
maps to a **struct** return. `return poisoned` then coerces the externref host
object to a struct it does not match → the value marshals to **`null`** at the
host-invocation bridge (`__call_fn_N`). V8's native `@@replace` sees `r.exec()` →
`null` → `RegExpExec` finds no match → the result-object reads (and their throwing
getters) never run → no throw → `assert.throws` fails. Empirically confirmed with
`execReturnBridge` instrumentation (`ret === null` for the accessor-only case;
`isWasmStruct=false` real object for a data-bearing sibling, which already passed).
Cases _with_ a data field (`result-get-{capture,groups}-err`: `{ length:2,
get 1(){throw} }`) already passed pre-Slice-3 because the data field routes the
literal to a real host object whose getter V8 dispatches normally.

**Fix:** `computeClosureWrapperSig` now forces the closure's wasm return type to
externref when the body returns a host-path accessor object literal (an object
literal with get/set accessors, or a var directly initialized to one). This
mirrors the existing `initForcesExternref` var-hoisting tag (index.ts:15737 /
declarations.ts:4273) — the RETURN-position analog was missing. Detection is
purely syntactic (AST + checker symbol resolution), so it is identical between the
pre-scan (`ensureFuncValueWrappersRegistered`) and the actual-compile calls (the
pre-registered funcref wrapper type matches the compiled signature). Impact surface
is narrow: closures that return accessor object literals are rare, and such objects
are already externref host objects everywhere else, so forcing externref return is
representation-neutral for every other consumer. Host-lane only (standalone RegExp
delegates to the native backend #682; the change is in generic closure
return-typing and does not alter the standalone floor — validated below).

## Remaining Work (Slice 3+ — senior-depth)

Not addressed by Slice 1, 2, or 3. Distinct mechanisms, all senior-depth:

0. **[SLICE-3 CORRECTION] The remaining `result-*-err` twins need a DIFFERENT
   fix than the index/length/matched trio Slice 3 landed** — see the corrected
   root cause above. `result-get-groups-prop-err` (`{ length:0, index:0, groups:{
get foo(){throw} } }`) and `result-coerce-groups-err` (`{ length:1, 0:'',
index:0, groups:null }`, expects `TypeError` from `ToObject(null)`) both have
   an **outer object with only DATA fields** (no direct accessor), so Slice 3's
   predicate does not fire and the outer still marshals to null (or its `groups`
   data field reads as `undefined` host-side — cf. the `mkOnlyData` probe: a
   struct-typed data object returned through the closure bridge reads its fields
   as `undefined`). Empirically, adding a dummy accessor to the outer (forcing it
   onto the host path) makes `groups-prop-err` pass — so the nested throwing
   getter dispatches fine ONCE the outer is a real host object. The general fix is
   to route object literals returned from an exec-override closure (or, more
   broadly, any closure whose inferred return type is a plain object) onto the
   host `$Object` path so their data fields AND nested accessor values are
   host-readable. That is a broader object-literal-representation change (higher
   regression risk across every closure-returning-object site) — **STOP-AND-
   DOCUMENTED here rather than stranded.**

1. **`result-*-err` (remaining twins)** — the `groups`-family, see item 0 above.
   The `index`/`length`/`matched` trio was Slice 3. **Senior-depth (object-literal
   representation).**
2. **[CORRECTION] The "`Cannot convert object to primitive value` @@split cluster"
   IS the SpeciesConstructor cluster.** Reading the actual files, `coerce-flags`,
   `limit-0-bail`, `str-coerce-lastindex`, `str-result-coerce-length`,
   `str-set-lastindex-{match,no-match}`, `str-get-lastindex-err` ALL use
   `RegExp.prototype[Symbol.split].call(obj, …)` where `obj` is a plain object with
   `obj.constructor[Symbol.species]` returning a **fake-RegExp splitter** (custom
   `exec`, `lastIndex` get/set, `flags` getter). So this is not a separate
   "object-arg ToPrimitive" family — it is the same `SpeciesConstructor` +
   host-callable-user-constructor + fake-RegExp-splitter mechanism as item 3.
   Merge items 2 and 3.
3. **`SpeciesConstructor` for @@split** (`species-ctor{,-y,-err,-ctor-non-obj,-species-non-ctor}`,
   `splitter-proto-from-ctor-realm`, + all of item 2): `C = SpeciesConstructor(rx,
%RegExp%)` then `Construct(C, [rx, flags])` — bridging a user constructor and a
   fake-RegExp splitter object through the native split. This crosses the
   host-marshaling substrate (Fable-reserved). **~14 files, the deepest cluster —
   STOP-AND-DOCUMENTED, not attempted this slice** (would strand a broad change).
4. **method-as-value (`name.js`, both replace + split)**:
   `RegExp.prototype[Symbol.replace]` accessed as a **value** (for `.name`) rather
   than called — the codegen resolves the member to the protocol-id `i32.const 8`,
   so `verifyProperty(<8>, "name", …)` fails. Separate codegen feature
   (well-known-symbol method as first-class value), orthogonal to 1–3.

## Test Results (Slice 1)

`tests/issue-3051.test.ts` — 5/5 pass. Local default-lane sweep of
`built-ins/RegExp/prototype/Symbol.{replace,split}`: replace 54/69, split 28/43
(was 39/69, 28/43).

## Implementation Plan (arch, 2026-07-05) — Slice 3+ (senior-depth)

**Slices 1 & 2 landed** (dev-3051 / dev-3051b). Re-scoped `status: ready`,
`feasibility: hard`, `model: fable` for the four remaining clusters. These are
distinct mechanisms; land each as its own commit. All four live in the JS-host
lane's `__regex_symbol_call` (`src/runtime.ts:10587`) and the
`_wrapForHost`/`_wrapExecReturnForHost` bridge (runtime.ts:2347). Standalone lane
delegates to the native RegExp backend (#682) — verify each fix has a standalone
story or is host-lane-gated so the standalone floor is unaffected.

### Cluster 1 — `result-*-err` abrupt-throw through a throwing getter (the biggest)

Files: `result-get-{index,length,matched}-err`, `result-get-groups-prop-err`,
`result-coerce-groups-err`. The exec result object has `get index(){ throw new
Test262Error() }`. V8's native `@@replace`/`@@split` reads it through the
`_wrapForHost` proxy (`_wrapExecReturnForHost`, runtime.ts:2347) → invokes the
compiled getter closure → the wasm `throw` must surface as a **JS exception V8
propagates** back to the user's `try/catch`.

**Mechanism to build:** the get-trap in `_wrapForHost` that dispatches a struct's
accessor/getter closure (grep the get-trap accessor arm near runtime.ts:5278 and
the `WebAssembly.RuntimeError` guards at runtime.ts:2941-3074) catches wasm traps
today (`e instanceof WebAssembly.RuntimeError`) and converts them to a
`_PRIM_ABSENT`/undefined sentinel (runtime.ts:3057). A user `throw new
Test262Error()` in a compiled getter surfaces as a wasm exception (tag
`ensureExnTag`), NOT a `WebAssembly.RuntimeError` — so it must be **re-thrown as
the underlying JS error value**, not swallowed. The fix: in the getter-dispatch
arm, when the caught exception is a wasm-thrown user exception (has the exn tag /
carries a boxed JS error payload), extract the payload and `throw` it as a JS
value so V8's protocol propagates it to the user catch. Confirm how compiled
`throw new X()` is represented at the host boundary (does the module export a
helper to unwrap the thrown externref? grep `ensureExnTag` consumers + any
`__get_pending_exception`/`getArg` host-side unwrap). This is the reusable
"wasm-exception → host → user-catch" bridge — once built it also helps #3050's
host lane and any throwing-getter-through-native-protocol case.

**Edge:** an actually-buggy wasm trap (real RuntimeError) must STILL be swallowed
to the absent sentinel where it is today — only _user_ throws propagate. Keep the
two exception classes distinct.

### Cluster 2 — `Cannot convert object to primitive value` (@@split object args)

Files: `coerce-flags`, `limit-0-bail`, `str-coerce-lastindex`,
`str-result-coerce-length`, `str-set-lastindex-{match,no-match}`. An object arg /
`lastIndex` round-trip that must `ToString`/`ToLength`/`ToPrimitive` traps at the
wasm boundary before reaching the protocol. Slice 2's data-struct guard fixed the
_throwing-valueOf_ subset (`coerce-limit-err`); these plain object-to-primitive
cases still trap because the value is passed to V8 as an opaque wasm struct with
no `[Symbol.toPrimitive]`/`valueOf`/`toString` visible.

**Fix:** ensure EVERY object-typed arg into `__regex_symbol_call` (runtime.ts:
10588 params `arg0`,`arg1`) and every `lastIndex`/`flags` value read from the
compiled RegExp is routed through `_wrapForHost` (property proxy) **before** it
reaches V8's native protocol, so native `ToPrimitive`/`ToString`/`ToLength`
dispatches the struct's coercion closures — same treatment Slice 2 applied to the
replaceValue via the `__is_data_struct` discriminator (runtime.ts:1809
`wrapCallable`). Audit the arg-wrapping at runtime.ts:10599-10621 and the
`flags`/`lastIndex` get/set host bindings (grep `str-set-lastindex`,
`RegExp_set_lastindex`, the #2671 lastIndex-as-externref treatment referenced in
Slice 2). The `@@split` splitter's `lastIndex` get/set protocol
(`str-set-lastindex-*`) needs the compiled RegExp's `lastIndex` to round-trip as
externref (mirror `.global`/`.unicode` retype from Slice 2, and the #2671
`lastIndex`).

### Cluster 3 — `SpeciesConstructor` for @@split

Files: `species-ctor{,-y,-err}`, `species-ctor-non-obj`, `species-non-ctor`,
`splitter-proto-from-ctor-realm`. §22.2.6.14 `[Symbol.split]`: `C = ?
SpeciesConstructor(rx, %RegExp%)` then `splitter = ? Construct(C, [rx,
newFlags])`. Our @@split delegates to V8's native `RegExp.prototype[Symbol.split]`
via `__regex_symbol_call`, so **V8 already runs SpeciesConstructor** — but on the
value it sees as `rx.constructor`. The failure is that a **user constructor**
(`class MyRegExp extends RegExp` or a `Symbol.species` getter returning a compiled
ctor) is a wasm closure/struct that V8's `Construct` can't invoke.

**Fix:** the compiled RegExp handed to V8 must expose `constructor` /
`Symbol.species` such that native `SpeciesConstructor` resolves to a
host-callable constructor bridge. When `rx[Symbol.species]` / `rx.constructor` is
a compiled class, wrap it via the callable-ctor host bridge (`_wrapCallableForHost`
/ the `@@species` handling at runtime.ts:4223, 4374, 4451-4454) so
`Construct(C, [rx, flags])` invokes the compiled constructor and returns a value
whose `exec`/`lastIndex` V8 can drive. The `-non-obj`/`-non-ctor` variants must
`TypeError` — ensure the bridge preserves the constructor-ness check (a
non-constructor species must throw, not silently pass). `splitter-proto-from-
ctor-realm` needs the constructed splitter's `[[Prototype]]` to come from the
ctor's realm — verify the bridge doesn't flatten it to the base %RegExp%.prototype.
This is the deepest cluster (user constructor through native split); may itself
split into a sub-slice.

### Cluster 4 — well-known-symbol method as a first-class value (`name.js`)

`RegExp.prototype[Symbol.replace]` accessed as a **value** (to read its `.name`),
not called. Codegen resolves the member to the protocol-id `i32.const 8`
(`_symbolIdToKeys` id 8 = `@@replace`, runtime.ts:4377), so
`verifyProperty(<the i32 8>, "name", …)` fails — the i32 is not the method
function object.

**Fix (codegen, distinct from the runtime clusters):** when a well-known-symbol
method (`RegExp.prototype[Symbol.replace]` etc.) is accessed as a **value** (not
in call position), the codegen must yield a first-class **function object** for
that method (with correct `.name` = `"[Symbol.replace]"`, `.length`), not the
bare protocol-id i32. Grep the member-access lowering that emits `i32.const 8` for
`obj[Symbol.replace]` (property-access.ts / the `_symbolIdToKeys` producer in
codegen) and split call-position (keep the `__regex_symbol_call` fast path) from
value-position (materialize a host function wrapper via a `__get_wks_method`-style
import that returns the native `RegExp.prototype[Symbol.replace]` with its real
`.name`). This is a separate feature ("well-known-symbol method as first-class
value") and could be its own issue if it doesn't fall out cheaply — scope it last.

### Ordering & risk

- Cluster 1 (throwing-getter bridge) is the highest-value and most reusable —
  do it first; it is genuinely senior (wasm-exn→host propagation).
- Cluster 2 (object-arg ToPrimitive) reuses Slice 2's `_wrapForHost` discipline —
  medium within this set.
- Cluster 3 (SpeciesConstructor) is the deepest; may sub-split.
- Cluster 4 is a codegen value-vs-call feature, orthogonal to 1-3.

Each cluster: verify **no regression** in the delegating corpus
(`String.prototype.{replace,replaceAll,split,match,matchAll,search}` +
`RegExp.prototype.{Symbol.match,Symbol.matchAll,Symbol.search}` — 459 files
dev-3051b already swept) and in `tests/issue-3051.test.ts`. Full `merge_group`
per cluster; standalone floor green (host-lane-gated).

## arch-3049 re-verification (2026-07-06) — CONFIRMED, with a line-drift caveat

Re-checked against current `main` @ 52937f5. **All four Slice-3+ cluster
mechanisms exist and the root-cause claims hold — BUT `runtime.ts` (now 14,913
lines) has advanced since 2026-07-05, so the cited line numbers are off by
~15–300 lines. Grep by SYMBOL.**

- `__regex_symbol_call` is at **`:10628`** (spec said 10587); the local
  `wrapCallable` data-struct guard is at **`:10659`** with the `__is_data_struct`
  gate at **`:10674–10682`** (Cluster 2). Note: the spec's "`wrapCallable` at
  runtime.ts:1809" is imprecise — `:1824` is a `wrapCallable?` _parameter_ of a
  different accessor-bridge fn; the actual RegExp guard is the local at `:10659`.
- `_wrapExecReturnForHost` at **`:2362`** (spec 2347); `_wrapForHost` at
  **`:5575`** (spec cited 5278 for its get-trap arm). `_PRIM_ABSENT` still exists
  (aliased to `_MISS`, `:2911`); the `WebAssembly.RuntimeError` swallow guards are
  at `:2956–2998`, `_PRIM_ABSENT` returns at `:3023/3034` (Cluster 1).
- `_symbolIdToKeys` at **`:4384`**; **id 8 = `@@replace` CONFIRMED exact**
  (Cluster 4 `name.js`). `[Symbol.species,"@@species"]` at `:4238`;
  species-bridge sites near `:4451/4466`.

No downgrade — the cluster designs (wasm-exn→host throwing-getter bridge,
object-arg `_wrapForHost` routing, SpeciesConstructor ctor bridge, WKS-method
value-vs-call) are correct. Flagged only for the line drift.

## Re-admission BLOCKED — g-match regression + redundant (dev-reclaim-2777, 2026-07-09)

**Do NOT remove the `hold` label on PR #2777. The PR is NOT re-admittable as-is.**

Re-validated PR #2777 after merging current `origin/main` (0cbd8a2, honest
baseline `oracle_version: 2`) into the branch — new tip `765b0847`.

**1. The cited merge_group test is a REAL regression, not a vacuity-unmask.**
`built-ins/RegExp/prototype/Symbol.match/g-match-no-coerce-lastindex.js`:
- Committed honest baseline (oracle_version 2, refreshed 2026-07-09 13:08):
  **status = pass, reached_test = true** on the host/gc lane. Main *honestly
  PASSES* it now — it is NOT an honest fail (the task/coordinator premise was
  wrong on this point).
- Local `runTest262File` reproduction (deterministic, 2 runs each):
  - main-HEAD (0cbd8a2): host lane **pass**, standalone **pass**
  - PR branch (765b0847): host lane **FAIL** ("This function should not be
    invoked."), standalone **pass**
- The PR flips g-match pass→fail on the host lane vs an honest-passing baseline
  = genuine regression. The forced-externref-return makes native @@match coerce
  `lastIndex` (invoking the `valueOf` the test asserts must NOT run) for a
  non-empty match.

**2. The PR is now REDUNDANT.** All 15 scenarios in the PR's own
`tests/issue-3051.test.ts` — including "exec override returning an accessor-only
object literal DIRECTLY is not nulled" — **PASS on main-HEAD with the PR change
absent** (`closureReturnsHostAccessorObject` not present). One of the 87 commits
landed since the 2026-07-06 park already fixes the #3051 accessor-only exec
marshalling via a more general mechanism. The PR's heuristic in
`src/codegen/closures.ts` is no longer needed and now only causes the g-match
regression.

**Recommendation:** rework or close #2777 as superseded. Hold left in place.
