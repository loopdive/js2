---
id: 3468
title: "Standalone: method calls on function objects silently swallow assertions (assert.sameValue/throws never fire) — root cause is function-object own-property gap, NOT a catch_all swallow"
status: done
completed: 2026-07-24
spec: complete
assignee: ttraenkler/sendev-3468-f1
created: 2026-07-19
blocked_reason: "SUPERSEDED 2026-07-23 by stakeholder ruling (see '## STAKEHOLDER RULING' below): land F1 harness routing + HONEST floor de-inflation, routing the exposed failures to trackers by cluster. The prior 'do not rebaseline' stance was a PR-shepherd caution ABSENT a stakeholder decision; the stakeholder has now ruled to proceed with a truthful downward re-baseline (the tests were never really passing)."
priority: high
feasibility: hard
task_type: bug
area: codegen
goal: standalone
sprint: Backlog
horizon: l
related: [2860, 3417]
# (#3102) C-core keeps the bulk of its logic in the NEW leaf module
# src/codegen/closure-props.ts; these three touches are the unavoidable minimum:
# the three dead arms live in object-runtime.ts, the reserve/fill ctx flags in
# context/types.ts, and the finalize call in index.ts.
# (F1) declarations.ts carries the restored standalone top-level `F.<name> = …`
# keep-arm (the front-end routing for the assert-harness shape) — ~45 LOC.
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/declarations.ts
# (#3303) Ceiling for the stakeholder-ruled F1 de-inflation. DERIVED, not
# round: 3,637 measured wasm-change regressions (merge_group run 30043224652,
# vs standalone baseline dbc0162 @2026-07-23T20:20Z, oracle v9=v9) + 13
# (measured pass→compile_timeout flake rows this run — each can complete on
# the re-run and convert into a counted regression; conversion bound = all 13)
# + 25 (ORACLE_REBASE_DRIFT_TOLERANCE, scripts/diff-test262.ts — the repo's
# codified bound for unavoidable main-side baseline drift during a
# re-baseline window) = 3,675. Hard-fails above the ceiling (#3303).
regressions-allow:
  count: 3675
  reason: "#3468 F1 stakeholder-ruled assert-harness de-inflation: 3,637 measured vacuous-pass→honest-fail flips (97.5% assertion-time throws; incl. 4 latent #3559 CEs, stakeholder-signed-off) + 13 measured timeout-flake conversion bound + 25 codified drift tolerance"
---

# #3468 — Standalone method-dispatch "exception swallow" (root-caused)

> **F1 LANDED (#3523, 2026-07-24)** — standalone honest floor 27,557 (was 31,188
> inflated); 3,545 vacuous passes now honest + tracker-routed; 4 CEs tracked in
> #3559; classifier fold cured the false-oob ratchet trip. Remaining
> C-complete/reflection routing is future scope. Issue closed `done`.

> **Folds under #2860** (standalone↔host gap umbrella); cross-refs #3417
> (oracle-v8 reclassification). Origin: the Cluster C / C1 finding in the
> host↔standalone parity investigation (`/workspace/.tmp/parity-findings.md`).

## STAKEHOLDER RULING (2026-07-23) — PROCEED with honest de-inflation

**The user (stakeholder the floor-rebaseline gate defers to) ruled: land F1 +
honest floor de-inflation.** This SUPERSEDES the "do not rebaseline / explicitly
rejected" language in the PR-shepherd resolution below — that stance was correct
*absent a stakeholder decision*; the decision is now made. Execution conditions
(non-negotiable, they are what make this honest de-inflation and NOT the
banked-regression path the older note rejected):

1. **Route the exposed vacuous-pass→real-fail tests to TRACKERS by signature
   cluster** (#3178 iterables, #3442/#2865 async continuation, #1781 module-init
   throw, #3443 illegal_cast, #2903/#3390 promise; file new issues only for
   genuinely unowned clusters). Cohort-level, not per-test. This is the condition
   that distinguishes truthful de-inflation from hiding.
2. **The honest floor number is MEASURED, never the stale 3,608.** That figure is
   from the 2026-07-20 merge_group run — F3 (#3501 deferTopLevelInit) has since
   changed exactly the module-init-throw surface those failures live on. The real
   number comes from the F1 PR's own merge_group park delta on current main.
3. **Re-baseline downward to the measured honest number**, with the justification
   recorded in the PR body + this issue. The floor edit is revert-forward
   reversible; what must be exactly right is the ACCOUNTING (measured number +
   real tracker routing), not the mechanics.

## STATUS (historical): root-caused, was BLOCKED ON A SCOPING + FLOOR-REBASELINE DECISION — now RULED, see above

The bug is confirmed and multiply-reproduced. **But the root cause is NOT what
the parity investigation hypothesised, and the real fix is a substantial
feature, not a targeted exception-wiring change.** This issue therefore needs a
scoping decision (which approach) and a stakeholder floor-rebaseline decision
(the fix changes the standalone floor) before implementation. No PR is open;
no red regression test is committed (it cannot merge until the floor is
re-baselined).

## Confirmed symptom (real test262 pipeline)

Under `--target standalone` with the **exact** test262-worker compile options
(`allowJs:true, skipSemanticDiagnostics:true`, JS source, `(start)`-init model),
the test262 `assert` harness silently no-ops:

| Probe | Expected | Standalone actual |
| --- | --- | --- |
| `assert.sameValue(1, 2, "m")` | THROW `Test262Error` | **no throw** (vacuous pass) |
| `assert.throws(TypeError, ()=>{})` | THROW | **no throw** (vacuous pass) |
| `assert.sameValue(2, 2)` | no throw | no throw (correct) |

`assert` is a function object; `assert.sameValue`/`assert.throws`/`_isSameValue`
are properties assigned to it. Because those properties are **dropped**, the
call resolves to `undefined` and the assertion's `throw` never executes → the
test is scored a **VACUOUS PASS**.

## Root cause (corrected — this overturns the investigation's hypothesis)

**Function objects (closures) cannot carry own properties under `--target
standalone`.** Assigning a property to a callable value is dropped, and reading
it back yields `undefined`, so a "method" call on a function object never
invokes anything.

Decisive, unconfounded evidence (probes in the worktree `.tmp/`):

- `f.m = fn` then `f.m()` where `f` is a function -> returns **undefined**, not
  the method's value. Distinctive-return probe: method returns `777`, call site
  reads `0` (undefined). Plain-object control `o.m = fn; o.m()` correctly reads
  `777`.
- Side-effect probe: a global written **inside** the method stays at its initial
  value -> **the method body never executes**. The `throw` is never reached
  because the call never happens.
- `f.x = 5; return f.x` on a function object -> **NaN** (undefined). Plain-object
  control returns `5`.
- **The generated WAT contains ZERO `try`/`catch`/`catch_all`.** There is no
  exception being caught and dropped. The investigation's hypothesis — "the
  method-dispatch export wrapper in `closure-exports.ts` saves/restores
  `__current_this` around `call_ref` with no `catch_all`, so add one + rethrow"
  — is **wrong**: no exception ever propagates out of the (never-invoked)
  method, so a `catch_all`+rethrow there would be a **no-op**. Do NOT implement
  that fix.
- The investigation's "`assert._isSameValue("a","b")` returns false correctly,
  so the comparison works" claim was a **false positive**: an un-invoked method
  returns `undefined`, which is falsy, so `... ? 1 : 0` yields `0` — the same as
  a real `false`. A distinctive-value re-test shows `_isSameValue` is **not**
  invoked either.

### Why `__extern_method_call` returns undefined on a function receiver

`a.m(args)` on an `any`-typed receiver lowers to
`__extern_method_call(recv, "m", args)` (`src/codegen/object-runtime.ts` ~3979).
Its dispatch is `ref.test $Object(recv)` -> on match, resolve via `__extern_get`
+ `__apply_closure`; **else return `ref.null.extern` (undefined)**. A closure is
NOT a `$Object`, so the `ref.test` fails and the whole call returns undefined.
Symmetrically, `__extern_get`/`__extern_set` (~1409) gate on `ref.test $Object`
and miss on closures, so both property read and write on a function value are
no-ops.

### What already works (bounds the fix)

- **`.prototype`** assignment/read persists through `new` — there is a dedicated
  prototype slot, not general own-property storage.
- **Class static methods** (`class C { static m() {} }; C.m()`) work — but via
  **compile-time** resolution (static members become module globals +
  tag-dispatch, `src/codegen/class-bodies.ts:800/1450`,
  `class-member-keys.ts`), NOT a runtime callable-carries-properties
  representation.
- There is **no general runtime mechanism** for "a callable value carries
  arbitrary own properties." That is exactly what is missing.

## Candidate approaches (for the scoping decision)

**A. Compile-time function-object property tracking (targeted, mirrors class
statics).** Track properties assigned to module-level function *declarations*
(`assert.sameValue = fn`) into a compile-time map, and statically resolve
`X.prop(...)` / `X.prop` where `X` is such a declaration to a direct call/read.
- Covers the dominant case: the test262 `assert` harness is a module-level
  `function assert(){}` with statically-named method assignments and statically-
  named call sites — all resolvable at compile time.
- Does NOT cover dynamically-aliased function objects (`const g = assert; g.x`)
  or property access on function *values* flowing through `any`.
- Effort: **medium**. Risk: **moderate** (new static-resolution path; must not
  regress the existing `__extern_method_call` dynamic path).

**B. Runtime callable-`$Object` representation (general).** Box a
property-carrying function into a callable `$Object` (internal callable slot) so
`__extern_get`/`_set`/`__extern_method_call` work uniformly and dispatch invokes
through the slot.
- Fully general. Touches value representation, closure classification, `typeof`,
  and call lowering. Effort: **large**. Risk: **high** (broad-impact; validate
  on `merge_group`).

**C. Closure-identity-keyed side property table (general, less invasive to value
rep).** Keep closures as-is; give `__extern_set`/`_get`/`__extern_method_call` a
fallback that stores/looks up properties in a runtime identity-keyed map when the
receiver is a closure rather than a `$Object`.
- More general than A, less invasive than B. Needs closure identity + a global
  map + method-dispatch routing through it. Effort: **medium-high**. Risk:
  **medium**.

**Recommendation:** this is architect-spec territory. Approach **A** is the most
tractable path to unblocking the test262 `assert` harness (the dominant value);
**C** is the general fallback if aliased function objects matter. Route through
`/architect-spec` before implementation.

## Floor / #2860 metric impact (corrected narrative)

The parity finding framed this as a **pure pass->fail lowering** ("~thousands of
vacuous passes become correct fails, lowering the floor to truth"). That is only
partly right — making assert methods callable is a **feature**, so the net floor
direction is **mixed**, not purely down:

- **should-FAIL tests** currently vacuous-pass -> will correctly **FAIL**
  (pass->fail; the "lowering"). This is the dominant flip and the reason the
  standalone-floor regression gate WILL trip on `merge_group`.
- **should-PASS tests** currently vacuous-pass -> still pass (now genuinely; no
  flip).
- Some tests failing **only** because an assert method wasn't callable may flip
  **fail->pass**.

Net is a truthful re-baseline, predominantly downward, but not one-directional.
The exact flip count must be **measured empirically on a representative subset
after the fix lands** (not computable a priori; do NOT run full test262 locally).
A **standalone-floor re-baseline** is required and gated on the stakeholder
decision (per the dispatching tech-lead's instruction: this fix must not
auto-land).

## Regression guard (to add WITH the fix, once floor is re-baselined)

A focused vitest under `tests/` asserting that on `--target standalone`:
- `assert.sameValue(1, 2)` **throws** (scores fail), and
- `assert.throws(TypeError, () => {})` **throws** (scores fail).

Not committed yet — it is a red test until the fix lands, and it cannot merge
before the floor re-baseline.

## Bug 2 (separate, smaller, optional): top-level `throw` statement dropped

Independent of the above: a `throw` statement at module top level is silently
elided from the standalone `(start)`/init body. `throw 42;` as the sole
top-level statement compiles to an empty ~5.6 KB module with **no `(start)`
section**. Verified it is **throw-only**, not whole-init DCE: `var g = 0;
function set(){ g = 7; } set(); throw 42;` runs the side effect (`g === 7`) but
still does not throw. Low test262 value (few tests end in a bare top-level
throw); offer as an optional standalone-correctness win, separate PR.

## Repro probes (durable)

In the worktree `.tmp/`: `repro.mjs`, `probe2.mjs`-`probe8.mjs`, `caseA.wat`,
`C_tail.wat`. All use `compile(src, { target: "standalone", ... })` and
`WebAssembly.instantiate`.

## Implementation Plan

> Recommendation: **Approach C** (runtime closure-identity side property table),
> phased **C-core → C-complete**. NOT A, NOT B. Verified against `origin/main`.

### Recommendation & why (C over A/B)

The three terminal dispatch helpers **already receive the closure receiver** as
an externref and simply bail in their "not a `$Object`" arm:

| Op | route | terminal helper (object-runtime.ts) | dead arm today |
| --- | --- | --- | --- |
| `f.p = v` | `__set_member_p` | `__extern_set` | non-`$Object` arm → `return` (no-op) |
| `f.p` | `__get_member_p` | `__extern_get` | miss arm → undefined |
| `f.m()` | `__call_m_m_0` | `__extern_method_call` | else → `ref.null.extern` |

**C fills those three currently-dead arms for concrete capturing-closure
subtypes.** The `$Object` fast-path is untouched. Shared noncapturing wrapper
structs — including the test262 `assert` harness receiver — deliberately remain
outside this first rollout; the exact merge-group measurement below explains
why. The slice fixes real programs with aliased capturing receivers and reuses
the existing `$Object` prop machinery for per-closure own props.

### Phasing
- **C-core (this PR):** wire the 3 helpers + side table for capturing closures.
- **C-core rollout (blocked):** expand to shared noncapturing wrappers only after
  the assertion failures exposed by the merge-group measurement are fixed.
- **C-complete (follow-on):** route reflection (`in` / `delete` / ownKeys /
  `getOwnPropertyDescriptor`) through the same prop-bag.
- **A (optional):** compile-time fast-path for statically-named accesses.

### Changes — C-core (as implemented)

**1. Runtime structure** — struct
`$ClosurePropEntry { next: (mut ref null $ClosurePropEntry); key: eqref; bag: externref }`
+ module global `$__closure_prop_head : (mut ref null $ClosurePropEntry)` init
`ref.null`. Registered in `ensureObjectRuntime`'s type section, gated on
`ctx.standalone` (host/gc uses `env::__extern_*` imports → never touches these →
byte-identical). Linked list: prepend O(1), lookup = walk with `ref.eq`.

**2. Reserved-then-filled helpers** (mirror `reserveApplyClosure`/
`fillApplyClosure` — reserve funcIdx w/ `unreachable` stub at object-runtime-emit
time so the `__extern_*` bodies bake a stable `call <idx>`; fill at FINALIZE once
the captured-closure subtype set is complete; the late-import shifter keeps
`funcMap` + baked calls in sync). Guarded on the
`ctx.closurePropHelpersReserved` flag so a fill never runs without a reserve.
- `__is_closure_prop_carrier(externref)->i32` — `ref.test` chain over concrete
  closure structs whose source closure captured one or more lexical bindings.
- `__closure_bag_lookup(externref recv)->externref` — walk head; `ref.eq(key,
  recv-as-eqref)` → `bag`; miss → `ref.null.extern` (read; never creates).
- `__closure_bag_ensure(externref recv)->externref` — as lookup; on miss
  `bag=__new_plain_object()`, prepend entry, `global.set head`, return bag.
- `__closure_prop_get(obj,key)->externref` / `__closure_prop_set(obj,key,val)->()`
  — thin wrappers that self-call `__extern_get`/`__extern_set` on the bag.

> **Deviation from the sketch (WHY):** the spec sketched "3 helpers, inline the
> arm bodies." But the `set`/`get` arms need to self-call `__extern_set`/
> `__extern_get` on the bag, and a func's own funcIdx is **not** in `funcMap`
> while its body is being built (`registerNative` mints at registration time,
> after the body array is constructed). Routing the self-call through two extra
> reserved-and-filled wrappers (`__closure_prop_get`/`_set`, filled at FINALIZE
> when both `__extern_get`/`_set` funcIdxs ARE in `funcMap`) is the clean fix and
> avoids touching the registration of the two hottest object-runtime funcs.
> `__extern_method_call`'s else-arm is inlined directly (its deps — `extern_get`,
> `apply_closure` (reserved), `__nullish_to_null` — are all live at build time).

Receiver→eqref for `ref.eq`: `any.convert_extern` → `ref.cast EQ_HEAP_TYPE(-19)`.
Closures are eq-structs and `__is_closure_prop_carrier` guards every call, so
the cast is always safe.

**3–5. The three arms** now route their non-`$Object`/miss/else branch through
the helpers (`__closure_prop_set` / `__closure_prop_get` / inline closure mirror
guarded by `__is_closure_prop_carrier`). `.name`/`.length` `bfnGetMetaIdx`
meta-arm stays FIRST in `__extern_get`, so builtin metadata still answers before
the side-table fallback. `.prototype`/`.constructor`/`.__proto__` are
special-cased upstream and never reach these helpers.

**6. Finalize wiring** — `fillClosurePropHelpers(ctx)` next to `fillApplyClosure`
in `index.ts`.

### Floor interaction — exact measurement
The original all-closure rollout flipped vacuous standalone passes to truthful
failures and breached the standalone floor. The PR-shepherd measurement below
found 3,608 stable regressions, so no rebaseline or verdict exception is
permitted. This PR retains only the captured-closure boundary; #3468 stays
blocked for the shared-wrapper/harness rollout until the exposed semantics are
fixed.

### Test plan (vitest, target "standalone")
- Own-prop round-trip on a capturing arrow: `(memo as any).cache=5; ===5`.
- Method call + side effect: `(fn as any).m=()=>777; (fn as any).m()===777`.
- Aliasing/identity: `const g=fn; (g as any).x=5; (fn as any).x===5`.
- Distinct instances don't cross-talk; builtin `.name`/`.length` not shadowed.
- A shared noncapturing wrapper's custom property remains outside the rollout.

## C-core IMPLEMENTATION FINDING (2026-07-19) — runtime done, ROUTING GAP blocks the harness

C-core was implemented (`src/codegen/closure-props.ts` + the three arms in
`object-runtime.ts` + finalize wiring in `index.ts`) and the **runtime substrate
is verified correct** — but through the DYNAMIC member path only. A decisive gap
was found that **overturns the spec's "blast radius ≈ 0 / routing already works"
premise**:

**Verified working (dynamic path — a receiver flowing through an `any`-typed
local, e.g. `const g = fn`):**
- own-prop round-trip `(g as any).cache = 5; (g as any).cache` → `5`
- method call `(g as any).m = () => 777; (g as any).m()` → `777` (+ side effects run)
- identity `const g = fn; (g as any).x = 5; (fn as any).x` → `5` (`ref.eq` identity holds)
- distinct closures isolated → `11`, not `22`
- host/gc mode byte-identical (nothing emitted there); `--target standalone` only

**The gap — function-DECLARATION member ops bypass the dynamic path entirely:**
`assert.sameValue = fn`, `assert.sameValue`, `assert.sameValue(1,2)` (a bare
function-declaration receiver, which is EXACTLY the test262 `assert` harness
shape) are lowered STATICALLY against the closure-wrapper struct — WAT-confirmed:
the **write emits no runtime op** (silently dropped) and the **read resolves to
undefined** (`ref.cast (ref <wrapper>)` then no field). The real harness WAT
contains **zero** `__extern_*` / `__set_member` / `__closure_prop_*` calls, so the
filled arms are **unreachable for the harness**.

**Consequence: C-core as scoped yields floor delta ≈ 0.** The motivating vacuous
passes do NOT flip, because the assert harness never reaches the fixed arms. The
architect's "WAT-confirmed routes to `__extern_set`" held only for the local-alias
case, not the function-declaration case.

**To actually fix the harness** the front-end member dispatch must route a
function/closure receiver's NON-builtin member get/set/call to the dynamic path
(`__get_member`/`__set_member`/`__extern_method_call` → the C-core arms). Decision
points: `compilePropertyAccess` (`src/codegen/property-access.ts`) for reads; the
member-assignment lowering for writes; the method-call lowering for calls.
Exclusions to avoid regressions: `.name`/`.length`/`.call`/`.apply`/`.bind`/
`.prototype`/`.constructor`, class statics, and any statically-known member. This
is **A/front-end-routing territory** (deferred by this task's "C-core only"
scope) and its blast radius is NOT ≈0 — it changes how every function-value
member access lowers, so it needs full test262, not a canary. **Scope decision
pending with the tech-lead/stakeholder.** #3468 stays `blocked`.

## MEASUREMENT (2026-07-19) — routing is correct but BLOCKED by a pre-existing string-codegen bug

Ran a strided standalone before(`origin/main`)/after(branch) subset (730 files,
assert-heavy). Result — DO NOT read the raw flip count as the floor delta:

| | before(main) | after(branch) |
|---|---|---|
| pass | 446 | 55 |
| fail | 179 | 570 |
| compile_error | 26 | 26 |

- `pass → fail`: **391** · `pass → compile_error`: **0** · `fail → pass`: 0 ·
  `compile_error` unchanged (26 = 26, so #3468 adds ZERO new js2wasm CEs).

**The 391 `pass→fail` are NOT the intended floor-lowering.** Sampling them shows
they fail with a **WebAssembly.instantiate CompileError** (invalid Wasm), not an
assertion throw: `call[0] expected type (ref null 6=$AnyString), found externref`
in a harness closure. The routing makes the test262 harness (`sta.js`+`assert.js`)
COMPILE its `assert`/`assert.sameValue` function bodies — and those bodies hit a
**pre-existing standalone codegen bug** that produces invalid Wasm.

**Root cause (minimal, PRE-EXISTING, independent of #3468):** a function
EXPRESSION whose externref param is reassigned to a native-string literal in one
branch and then string-concatenated:
```js
const f = function (msg) { if (msg === undefined) { msg = ''; } else { msg += ' '; } msg += 'x'; return msg; };
```
compiled `--target standalone` produces invalid Wasm (`__str_concat` called with
an externref where `(ref null $AnyString)` is expected) on **BOTH origin/main and
this branch** — no expando, no routing, no C-core involved. `assert.sameValue`'s
message-building (`if (message === undefined) { message = ''; } else { message += ' '; }
message += 'Expected…'`) is exactly this shape. A plain function DECLARATION with
the same body is VALID — the bug is specific to function EXPRESSIONS / closures.

**Implication:** #3468's C-core + routing are correct for their scope, but the
routing cannot be net-positive until this pre-existing string-codegen bug is
fixed — otherwise the harness compiles (correct) → hits the string bug → invalid
Wasm → ~391 assert-using tests flip from vacuous-pass to fail-to-instantiate (a
regression, not the truthful correction). The string bug is a SEPARATE issue
(function-expression externref-param reassign-to-native-string type unification),
a prerequisite for landing #3468's routing. #3468 stays `blocked`; PR held; not
merged.

## F1 IMPLEMENTATION (2026-07-23, per the stakeholder ruling) — harness routing landed in this PR

Branch `issue-3468-f1-harness-routing` (agent `ttraenkler/sendev-3468-f1`).
Two changes, both standalone-gated (host/GC byte-identical):

1. **Carrier widening** (`src/codegen/closure-props.ts`,
   `fillClosurePropHelpers`): `__is_closure_prop_carrier`'s `ref.test` chain now
   covers the full closure BASE-wrapper set via
   `collectClosureBaseWrapperTypeIdxs` — the same classifier as
   `__is_closure`/`__typeof_function`. A base-root test matches every capturing
   subtype instance, so this strictly subsumes the #3418 capturing-only set and
   additionally admits shared noncapturing wrappers (the `function assert(){}`
   harness receiver). WHY not a union with the `hasCaptures` subtype list: every
   entry in `closureInfoByTypeIdx` walks to its root inside
   `collectClosureBaseWrapperTypeIdxs`, so the base set covers all subtypes by
   construction. The `hasCaptures` metadata itself is KEPT (an IR-lane consumer
   landed on it since the narrowing: `src/ir/integration.ts` sets
   `hasCaptures: true` on canonical capture subtypes) — a straight revert of
   `81b02624a` would have broken that; this PR is a re-application, not a revert.
2. **Front-end routing restore** (`src/codegen/declarations.ts`): the standalone
   top-level `F.<name> = …` keep-arm (dropped by `81b02624a`) is restored so the
   harness shape (`assert.sameValue = function(){…}`) stays in `__module_init`
   and reaches the ordinary `__extern_set` write-arm → side table. Reads/calls
   already routed dynamically from function bodies (and `__module_init` IS a
   function body).

**Deviation from the pre-narrowing original — `.prototype` is now EXCLUDED from
the keep-arm.** The #2660 S2 arm was UNSCOPED when the original measured run
happened (it consumed every top-level fnctor-prototype write first); it has
since gained the RECONSTRUCT-gate, so a non-reconstruct fnctor's
`F.prototype = …` now falls through. Admitting it into the side-table bag would
create a second, S3-invisible prototype storage with divergent identity —
`issue-2660-s2`'s "S2 off" guard test catches exactly this (verified: it fails
without the exclusion, passes with it). `.prototype` stays owned end-to-end by
S2/S3.

**Local verification (measured, this branch):** 14/14 in
`tests/issue-3468-closure-own-props.test.ts` — including the NEW regression
guards `assert.sameValue(1,2)` THROWS and `assert.throws(TypeError, ()=>{})`
THROWS under `--target standalone` (the vacuous-pass correction), plus
exclusions (class statics, `.call`/`.apply`) and the flipped noncapturing
round-trip. Adjacent surfaces: `issue-3418` (7/7), `issue-3536` (per-file
pass), `issue-3537` (11/11), `issue-3472`, `issue-2660-s2` (11/11),
`issue-1896`, `issue-2671-promise-capability` — 82/82 across the 8 suites.
A control run with `src/` flipped to `origin/main` showed the 8 failures seen
in a wider sweep (`illegal-cast-closures-585`, `issue-1712-capture-closure-
dispatch`, `issue-2660-s3` STRUCT-BINDING guard) fail IDENTICALLY on main —
pre-existing local-environment failures, not introduced by this PR.

**Floor accounting (per the ruling):** the PR is expected to auto-park in the
merge_group on the standalone floor gates; the park's regressed-test delta is
the honest number. The floor mechanism is the COMMITTED file
`benchmarks/results/test262-standalone-highwater.json` (read by
`scripts/check-standalone-highwater.mjs`; `--update` only ratchets UP, so the
intentional downward re-seed is an in-PR edit of that file) — no GitHub
Actions variable involved. The measured delta, tracker routing, and the
re-baseline edit are recorded below once the merge_group run completes.

## F1 MEASUREMENT (2026-07-23, merge_group run 30043224652) — the honest numbers

PR #3523 parked as designed; the ONLY failed step was **"Standalone regression
guard (#1897)"**. Measured (run-log-authoritative, reproduced exactly by a
local rediff of the run's merged JSONL vs the dbc0162 baseline):

- **Honest floor: host_free_pass = 27,557 / 48,088 full corpus** (official
  scope 27,093 / 43,106). Baseline was 31,188 → delta −3,631.
- Guard-exact: **3,637 wasm-change regressions, 18 improvements, net −3,619**;
  13 pass→compile_timeout flake rows excluded by the guard.
- **The #2097 high-water floor PASSED**: 27,557 vs mark 25,453 (floor 25,403),
  **+2,104 headroom** — the mark never ratcheted up with recent standalone
  gains, so NO highwater reseed is needed. The de-inflation lands entirely via
  the #1897/#3303 rebase-mode path.
- Host lane: catastrophic guard PASS (7 raw drift regressions) — corpus-scale
  confirmation of host byte-neutrality.

**Split of the 3,637** (= 3,633 fail + 4 compile_error):
- 3,545 (97.5%) assertion-time `Test262Error` throws — the designed
  vacuous→honest-fail flips. Cohorts: 2,328 value/behavior mismatches
  (assertions now compare real values), 1,016 expected-throw-NOT-thrown
  (assert.throws fires; builtin lacks the spec validation throw — Temporal
  480, annexB 96, TypedArray 83…), 137 async continuation, 31 promise, 45
  misc.
- 75 missing-capability TypeErrors ("X is not yet callable as a value" 32,
  property-on-null 33, …).
- 17 trap-category rows, only 11 REAL traps (7 null_deref, 4 illegal_cast —
  both categories SHRANK overall: 295→287, 397→376). The ratchet's oob 39→43
  "+4" was 100% classifier misclassification (assertion TEXT containing "out
  of bounds"), fixed by the v10 classifyError reorder in this PR — post-fix
  all four trap categories shrink vs baseline, so no trap-growth-allow is
  needed.
- 4 compile_error — the #2043-class latent bug exposed by the keep-arm
  (**#3559**): `local index out of range at '__cb_0'`. Root-caused to
  `call-identifier.ts`'s nested-lifted-fn call-site else-arm baking
  `local.get cap.outerLocalIdx` (the DECLARING fctx's index) when called from
  a method-call-arg callback (cbFctx) — the #2029 cross-fctx rescue covers
  only accessor-promoted globals, and the naive #1177 localMap-first fix was
  reverted for causing 100+ regressions. Minimal repro: retained
  `assert.throws = fn` × IIFE with TDZ-referencing inner fn + callback; the 4
  tests are let/const/using `function-local-closure-{get,set}-before-
  initialization.js`. Carried inside the allowance with explicit stakeholder
  sign-off; fix tracked separately.

**Tracker routing (cohort-level, per the ruling):**
- **#2860** (standalone↔host umbrella, established home of the routed
  de-masked census): the 3,454 demasked semantic-gap rows (2,328 mismatch +
  1,016 missing-throw + 45 misc + 33 property-on-null + 32
  builtin-as-value). Temporal (820 rows) is the proposals-scope subcluster.
- **#3442/#2865**: 137 async-continuation rows.
- **#2903/#3390**: 31 promise rows.
- **#3443**: 4 illegal_cast traps (flatMap/flat/sort poisoned-input callbacks).
- **#1781**: 7 null_deref traps (module-init + bind/callback dispatch).
- **#3178** (iterables): no separate standalone cohort — iterable failures
  surface inside the async-continuation texts routed above.
- **#3559** (new, filed with this PR): the #2043-class callback cross-fctx
  capture bug (the 4 CEs) — full root cause + inlined minimal repro in
  `plan/issues/3559-callback-cross-fctx-capture-local-index.md`; carried
  inside the allowance with explicit stakeholder sign-off (2026-07-23).

## PR-shepherd resolution (2026-07-20) — land captured-closure substrate; keep harness rollout blocked

The string-codegen prerequisite above landed on current `main` as #3472, so the
held PR was re-measured from its own latest `merge_group` run
(`29749566966`, merge SHA `ea8d3e523cbbb667cf0df30494bd0caa46fdc2e0`)
against the exact standalone baseline commit
`55e90a8441c27438823144c54d869928d6114b8e`.

The result disproves the remaining premise that the top-level harness routing
can be part of a normal conformance-preserving PR:

- 3,608 stable pass→non-pass regressions with changed Wasm (compile-timeout
  noise excluded), versus 18 improvements;
- 3,540 of those are `wasm exception during module init` after the test body was
  previously reached — the test262 assertions are now executing and exposing
  existing semantic mismatches;
- both baseline and candidate use `oracle_version: 8`; this is not oracle drift;
- the absolute host-free floor also falls to 25,048, 405 below the committed
  25,453 high-water mark.

Those failures cannot be erased honestly inside a closure-property routing
change: doing so requires fixing the exposed language/runtime semantics. A
baseline edit, verdict exception, or swallowed assertion would weaken the
oracle and is explicitly rejected.

Therefore PR #3418 is narrowed to the first principled **captured-closure
substrate** slice:

- route only concrete closure subtypes with captured lexical bindings through
  the dynamic runtime side table; shared noncapturing wrappers remain on their
  current behavior;
- keep seven executed round-trip, invocation, side-effect, identity, isolation,
  metadata, and noncapturing-boundary tests;
- remove the top-level `FunctionDeclaration` statement-retention arm and its
  harness tests from this PR;
- keep this issue `blocked` for a future staged harness rollout after the
  exposed failures are fixed, with no floor rebaseline.
