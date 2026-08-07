---
id: 4197
title: "runtime-eval consumer mode: a function DECLARATION used as a descriptor get/set is a broken callable — accessor reads answer null/0 on EVERY carrier; caps ~119 propertyHelper accessor files (standalone)"
status: ready
sprint: current
created: 2026-08-07
updated: 2026-08-07
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, standalone, runtime-eval
language_feature: property-descriptors, functions
goal: runtime-eval
related: [4159, 2928, 4180, 4176, 3251]
origin: "W15 descriptor-family residue analysis, 2026-08-07 — probe chain .tmp/p13..p21 in worktree agent-a29d9657414900b64"
---

# #4197 — consumer-mode function-declaration getters are broken callables

## Summary (all measured, standalone, current main + #4159)

In **runtime-eval consumer mode** (`ctx.runtimeEvalGlobalFunctionBindings` — the
mode any module enters when it captures a builtin, e.g.
`var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);`),
a **function declaration** referenced as a descriptor `get`/`set` produces a
broken callable:

```js
var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
function getFunc() { return 12; }
getFunc();                                              // 12  ✓ direct call fine
var b = [10, 20, 30];
Object.defineProperty(b, "1", { get: getFunc });        // define lands (gOPD sees it)
b[1];                                                   // null ❌ (12 expected)
var o = {};
Object.defineProperty(o, "p", { get: getFunc });
o.p;                                                    // 0    ❌ (12 expected) — PLAIN OBJECT too
```

Controls in the same poisoned module (all pass): a **data** define reads back
(77), a **function-expression** getter works (`var g = function(){return 99}` →
99), and the define/read machinery itself is healthy — the identical program
without the bind-capture line passes everywhere.

## Why this is the single largest descriptor-family lever

test262's `harness/propertyHelper.js` opens with primordial captures
(`Function.prototype.call.bind(Object.prototype.hasOwnProperty)` et al.), so
**every `includes: [propertyHelper.js]` test compiles in consumer mode**, and
the deprecated-helper tests spell their getters as function declarations
(`function getFunc() {...}` + `{ get: getFunc }` — the `15.2.3.6-4-2xx`
pattern). Measured against the post-#4155+#4159 residue of the 558-file
descriptor lever: **373 residue → 172 are propertyHelper-including (all
consumer-mode) → 119 of those carry accessor descriptors.** This is the
mechanism W5's census surfaced as the `accessed !== true` / `Expected obj[N]
... actually null` / `to be writable, but was not` buckets.

## Evidence chain (probes preserved in worktree `agent-a29d9657414900b64/.tmp/`)

- `p13.js` — minimal real-propertyHelper repro (`verifyEqualTo` reads null).
- `p14.js` — the reader is NOT the harness function: the author's own untyped
  helper in the same module also reads null once propertyHelper is included.
- `p15/p16/p17/p18.js` — bisection: `var __defineProperty = Object.defineProperty`
  and `var __gOPD = Object.getOwnPropertyDescriptor` are harmless; the
  `Function.prototype.call.bind(...)` capture alone flips the module
  (p18 22.7 MB WAT vs p15 1.1 MB — the consumer machinery).
- `p19.js` — with the capture: `gOPD=present` (define stored), `direct=null`,
  `helper=null` (both read lanes miss), bound capture itself works.
- WAT analysis (`.tmp/w15-callmap.py` on `.tmp/p18.wat`): `__module_init` calls
  `__defineProperty_accessor` (the generic native — receiver widened in
  consumer mode); its `vecOverlayArm` delegation and the `__extern_get_idx`
  overlay prologue (`global.get 1174` matching `__vec_dp_accessor`'s
  `global.set 1174`) are BOTH present and consistent — the store/read plumbing
  is correct, which localises the defect to the **callable value** captured in
  the descriptor.
- `p20.js` / `p21.js` — the discriminating pair: function-expression getter
  works, function-declaration getter fails, on array AND plain-object
  receivers.

## Root-cause hypothesis (verified to the boundary, not past it)

Consumer mode compiles global function declarations as **mutable global
function bindings** (`runtimeEvalGlobalFunctionBindings` — see
`src/codegen/context/types.ts` ~L1986). Reading such a declaration as a VALUE
inside a descriptor literal captures something that `__call_accessor_get` /
`__call_accessor_set` cannot invoke (result: null / type-default 0). The
adjacent family is already on record: `dereferencing a null pointer in
__fnctor_Func_new()` for `<Builtin>.bind(null)` (#4196 census), and L2's
`## RESIDUAL BLOCKER` note in
`plan/issues/3251-array-descriptor-overlay-substrate.md` (consumer-mode
mixed-type-ternary miscompile capping `verifyProperty`). Lane A (runtime-eval
goal) owns this seam per `plan/method/lane-partition.md`.

## Acceptance criteria

- `p21.js` shape passes: function-declaration getter invoked on array and
  plain-object receivers in a consumer-mode module.
- The `15.2.3.6-4-2xx` accessor family moves on the 558-file descriptor lever
  (expect on the order of +50..119; re-census, don't assume).

> **Sizing caveat — re-measure the +50..119 AFTER #4163 lands (tech-lead
> directive, 2026-08-07).** Until the runner seam fix merges, the in-process
> `tests/test262-runner.ts` omits the `js2wasm:runtime-eval` namespace that
> `scripts/test262-worker.mjs` supplies, and the link error OVERWRITES the real
> per-file signature — for precisely the consumer-mode modules this estimate
> covers. The figure above was measured through W5's instantiate-hook shim
> (`.tmp/w5-child.mts`), which papers over that seam; an unshimmed re-measure,
> or any measure across the #4163 boundary, can move for reasons unrelated to
> a fix. Sequence this issue after #4163, and validate the instrument
> two-sided before quoting a delta (see
> `.claude/memory/reference_standalone_eval_instrument_reports_unmeasured_failures.md`).
- Non-consumer modules byte-identical.
- Secondary (same census, smaller): consumer-mode boolean results surface as
  `1`/`0` instead of `true`/`false` (`captureWorks=1` in p19), which fails
  `assert.sameValue(x, true)` — verify whether fixing the callable also fixes
  this or file separately.

## Implementation Plan

*(architect, 2026-08-07 — every file:line below verified on `origin/main` at spec time)*

### Root cause (confirmed — consistent with all of p13–p21, no contradiction found)

The declaration/expression contrast is a **value-representation split created by
consumer-mode live-binding seeding**, and the break is in the **method-call
dispatcher**, not the descriptor store (matching the WAT finding):

1. **Why a DECLARATION is a different value.** In consumer mode
   (`ctx.runtimeEvalGlobalFunctionBindings = true`,
   `src/codegen/index.ts:6008`), `registerReassignedFunctionGlobals` adds every
   eval-visible top-level function-declaration name to
   `ctx.liveFuncBindingGlobals` (`index.ts:6043-6049` — the
   `Function.prototype.call.bind(<non-string-literal>)` capture sets
   `hasUnknownDynamicSource = true` at `index.ts:5975`, so **all** declarations
   qualify). Each gets a mutable `externref` global (`index.ts:6053-6068`).
   `__module_init` seeds that global with the function's closure **wrapped in
   the cross-module AOT-callable carrier** —
   `emitRuntimeEvalAotCallableAdapter` at
   `src/codegen/declarations.ts:2579-2581`. The identifier read-path
   (`src/codegen/expressions/identifiers.ts:1165-1171`) then reads the raw
   global. So `{ get: getFunc }` stores a **`$RuntimeEvalAotCallable` carrier
   struct** (`src/codegen/runtime-eval-callable.ts:380-421`; fields:
   0=`code` funcref, 1=`get` funcref, 2=`target` externref, 3/4=brands;
   **`superTypeIdx: -1`**, line 402 — deliberately outside the closure wrapper
   hierarchy).

2. **Why an EXPRESSION works.** `var g = function(){...}` is not in
   `liveFuncBindingGlobals` (that set only holds function-declaration names);
   its widened externref global holds the **raw closure struct**, which the
   ordinary dispatch ladder recognizes.

3. **Where the carrier dies.** The accessor read arm calls
   `__call_accessor_get(recv, getter)` (`src/codegen/object-runtime.ts:1795`),
   which is filled as a thin forward to `__call_fn_method_0`
   (`src/codegen/accessor-driver.ts:257-280`). `__call_fn_method_N`
   (`emitClosureMethodCallExportN`, `src/codegen/closure-exports.ts:671`) has
   **zero knowledge of the carrier** (grep confirms: no
   `runtimeEvalAotCallableCarrier` reference anywhere in closure-exports.ts).
   Its funcref extraction (`buildFuncrefExtraction`, closure-exports.ts:590)
   ref-tests the closure wrapper ROOT + per-shape ladder; the carrier
   (supertype-less, field 0 typed `(ref $RuntimeEvalAotCallableCode)`, not
   `funcref`) matches nothing → `funcLocal` stays null → dispatch falls through
   to the `ref.null.extern` default (closure-exports.ts:772). Result: getter
   "returns" null → `b[1] === null` on the array lane, `0` after numeric unbox
   on the typed-struct lane. Exactly p20/p21.

4. **The proof the fix pattern already exists.** `__apply_closure` has a
   carrier front-guard (`src/codegen/object-runtime.ts:5480-5534`: ref.test
   carrier → brand-check fields 3/4 → `call_ref` field 0
   `code(self, recv, argc, arg0..arg7)`), which is why the bound capture and
   direct calls work in the same module. `__call_fn_method_N` simply never got
   the same guard. `typeof getFunc === "function"` works because
   `closure-classifier.ts:75-76` includes the carrier in the callable set —
   the value is classified callable but is not invocable via method dispatch.

### Changes

**File: `src/codegen/closure-exports.ts`** (subsystem module — clears the
driver/barrel ratchet concern)

- Function `emitClosureMethodCallExportN` (line ~671). After the
  closure→anyref conversion (`body` built at ~750-753, `anyLocal` set)
  and **before** the `__current_this` install (~756-759), emit a carrier
  front-guard, gated on `ctx.runtimeEvalAotCallableCarrier !== undefined`
  (undefined in every non-consumer module ⇒ byte-identical there, satisfying
  the acceptance criterion):

```wasm
;; carrier front-guard (mirror object-runtime.ts:5482-5533)
local.get $anyLocal
ref.test $RuntimeEvalAotCallable
if
  ;; brand check: field 3 == BRAND_A && field 4 == BRAND_B
  local.get $anyLocal  ref.cast $carrier  struct.get 3
  i32.const RUNTIME_EVAL_AOT_CALLABLE_BRAND_A  i32.eq
  local.get $anyLocal  ref.cast $carrier  struct.get 4
  i32.const RUNTIME_EVAL_AOT_CALLABLE_BRAND_B  i32.eq
  i32.and
  if
    ;; code(self, recv=thisVal, argc, arg0..arg7)
    local.get $anyLocal  ref.cast $carrier
    local.get 0                       ;; thisVal → receiver
    i32.const min(arity, 8)           ;; argc (see note)
    local.get 2 .. local.get arity+1  ;; declared args (≤8)
    ref.null.extern × (8 − min(arity,8))
    local.get $anyLocal  ref.cast $carrier  struct.get 0
    call_ref $RuntimeEvalAotCallableCode
    return
  end
end
```

  - **Placement before the `__current_this` install is load-bearing**: the
    carrier's `code` trampoline binds the receiver explicitly (it re-enters
    `__apply_closure` with `target, receiver, args` —
    `runtime-eval-callable.ts:84-90`), so no `__current_this` save/restore
    bookkeeping is needed, and an early `return` cannot leave a stale
    `__current_this`.
  - **argc note**: `i32.const arity` is correct for both accessor drivers
    (getter arity 0, setter arity 1) and is the simple choice. Slightly
    better: `__argc` global if ≥ 0 else `arity` (the argc global is already
    ensured at closure-exports.ts:740). Either is acceptable; do not block on
    this.
  - Import `RUNTIME_EVAL_AOT_CALLABLE_BRAND_A/B` from
    `./runtime-eval-boundary.js` (as object-runtime.ts does at line 132).
  - **Ordering is safe**: `emitClosureMethodCallExportN` runs in finalize
    (`index.ts:4262-4271`), long after `__module_init` pass-1 seeding created
    the carrier via `emitRuntimeEvalAotCallableAdapter` →
    `ensureRuntimeEvalAotCallableTrampoline`. In consumer mode the carrier
    context field is always set by then. The guard only reads struct fields —
    no funcIdx dependency, so late index shifts don't touch it.

- **While there, check `emitClosureCallExportN`** (`__call_fn_<N>`, the
  this-less twin in the same file): same extraction ladder, same gap.
  Unverified whether any consumer-mode path reaches a carrier through it —
  direct calls go through the live-binding arm
  (`src/codegen/expressions/call-identifier.ts:975`) and dynamic applies
  through `__apply_closure`, both of which work per p19. Adding the identical
  guard there is cheap and symmetric; skip only if it destabilizes.

### What NOT to do

- **Do NOT unwrap the carrier at descriptor-store time** (e.g. in
  object-ops.ts / the `__defineProperty_accessor` path). Unwrapping to the
  raw `target` closure breaks descriptor-field identity:
  `Object.getOwnPropertyDescriptor(o,"p").get === getFunc` must hold, and a
  later read of `getFunc` yields the carrier — identity would split.
  propertyHelper's `verifyProperty` compares descriptor fields.
- **Do NOT re-investigate the descriptor store** — refuted at WAT level
  (see evidence chain above; `vecOverlayArm` + flag-global indices consistent).
- **Do NOT route `fillAccessorDrivers` through `__apply_closure`** as the
  primary fix. It would work (apply has the carrier guard) but changes the
  emitted accessor drivers in EVERY standalone module, violating the
  non-consumer byte-identical criterion, and fixes only accessors — the
  dispatcher guard also covers `__call_reviver` / `__call_to_json` /
  `__call_replacer` (accessor-driver.ts:309-386) and any method dispatch of a
  carrier-valued property for free.

### Invariants that must survive

1. **Eval rebinding of declarations still works**: the fix reads the carrier
   at INVOKE time from the stored descriptor value; it does not touch the
   live-binding global machinery. A declaration reassigned AFTER the
   descriptor is installed correctly keeps invoking the value captured at
   define time (ES: the descriptor captured the value), while direct calls of
   the name observe the rebound global — both unchanged.
2. **Nested-carrier no-double-wrap** (`runtime-eval-callable.ts:281-310`):
   the guard only reads the carrier; it never re-wraps. No interaction.
3. **Provider-interpreted callbacks** (`$RuntimeEvalInterpretedCallback`,
   distinct brands): the carrier's brand check keeps them out of this arm;
   they fall through to the existing ladder exactly as today. An
   interpreted-eval-defined getter is a SEPARATE (pre-existing) gap — out of
   scope, note it in the PR.
4. **Non-consumer byte-identity**: guard emission is conditional on
   `ctx.runtimeEvalAotCallableCarrier !== undefined`; that field is only ever
   set via `ensureRuntimeEvalAotCallableCarrierTypes`, reached only from
   consumer/provider-mode paths. Verify with an A/B compile of any
   non-consumer example.

### Edge cases to cover

- **Setter** as well as getter (`__call_accessor_set` → `__call_fn_method_1`,
  same gap, same guard fixes it).
- Accessor on **array** (vec overlay lane), **plain object** (typed-struct
  lane), and **function object** receivers.
- `Object.defineProperties` and `Object.create(proto, props)` descriptor
  paths — they funnel to the same store + the same `__call_accessor_get/set`
  invoke, so they should come for free; test anyway.
- Declaration **reassigned after install** (invariant 1 above).
- Arity > 8 method dispatchers (`__call_fn_method_6+`): carrier `code` takes
  8 args max — clamp to 8 (getter/setter never hit this; the truncation
  matches the existing `__apply_closure` carrier arm's 8-arg ceiling).

### Smallest repro (RED on origin/main)

`tests/issue-4197-consumer-mode-decl-getter.test.ts`, following the
compile-and-instantiate pattern of
`tests/issue-3420-standalone-array-own-property.test.ts` (which already uses
the exact `Function.prototype.call.bind` consumer trigger):

```ts
var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
function getFunc(): number { return 12; }
function setProbe(v: any): void { probeVal = v; }
var probeVal: any = 0;
export function test(): number {
  if (getFunc() !== 12) return 20;              // direct call (control)
  var b: any = [10, 20, 30];
  Object.defineProperty(b, "1", { get: getFunc });
  if (b[1] !== 12) return 21;                   // RED today: null
  var o: any = {};
  Object.defineProperty(o, "p", { get: getFunc, set: setProbe });
  if (o.p !== 12) return 22;                    // RED today: 0
  o.p = 7;
  if (probeVal !== 7) return 23;                // setter lane
  var g = function (): number { return 99; };   // expression control (green)
  var o2: any = {};
  Object.defineProperty(o2, "q", { get: g });
  if (o2.q !== 99) return 24;
  return 1;
}
```

Compile `target: "standalone"`, expect `importObject` `{}`, instantiate,
`test() === 1`. Plus an authoritative test262 case via `runTest262File`: any
`built-ins/Object/defineProperty/15.2.3.6-4-2xx` accessor file that includes
propertyHelper.js.

### Secondary (do not bundle)

The `captureWorks=1` boolean-representation symptom (Secondary bullet above)
is NOT addressed by this fix — the carrier guard changes only callable
dispatch. If it persists after this lands, file separately.
