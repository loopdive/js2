---
id: 3559
title: "Nested-lifted-fn call from a method-call-arg callback bakes the DECLARING fctx's local index (invalid Wasm) — #2043-class cross-fctx capture hole in call-identifier.ts"
status: ready
created: 2026-07-23
priority: high
feasibility: hard
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: m
related: [3468, 2043, 1177, 2029]
---

# #3559 — callback cross-fctx capture: `local.get cap.outerLocalIdx` escapes its fctx

## Symptom (measured, merge_group run 30043224652 / PR #3523)

Exactly **4 test262 files** flip pass→`compile_error` under `--target
standalone` once #3468 F1's keep-arm retains top-level `F.<name> = …` writes:

- `test/language/statements/const/function-local-closure-get-before-initialization.js`
- `test/language/statements/let/function-local-closure-get-before-initialization.js`
- `test/language/statements/let/function-local-closure-set-before-initialization.js`
- `test/language/statements/using/function-local-closure-get-before-initialization.js`

Error: `Binary emit error: RangeError: Codegen error: local index out of range
— 18 (valid: [0, 2)) at function '__cb_0'` (the #2043 late-import index-shift
class message, but the mechanism here is a CROSS-FCTX capture, not an import
shift — see below).

These 4 are carried inside #3468's `regressions-allow` ceiling with explicit
stakeholder sign-off (2026-07-23); this issue is the routed fix.

## Root cause (fully traced, 2026-07-23)

Two corruptions in the emitted `__cb_0` (the `assert.throws` second-argument
callback), confirmed via emit-time dump:

```
;; failing __cb_0 — locals: [__tdz_box_x]; 1 param (captures externref)
local.get 2          ;; INVALID — this is the DECLARING (IIFE) fctx's local
                     ;; holding x's ref-cell box, not a cbFctx local
i32.const 1
struct.new $cell<i32> ;; fresh TDZ flag box ("treat as initialized")
local.tee 1          ;; __tdz_box_x (cbFctx-local — this part is correct)
call 2097330         ;; STABLE_FUNC_BASE+178 — minted but NEVER PUSHED
drop
```

**Corruption 1 — the culprit line.** In
`src/codegen/expressions/call-identifier.ts`, the direct-call path for a
lifted nested function (`f()` where `f` is a nested hoisted declaration that
captures outer bindings) prepends f's value captures at the call site. Its
fallback else-arm is:

```ts
fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
```

`cap.outerLocalIdx` is a local index in the **declaring** function's fctx (the
IIFE body). When the call site sits in a **different** fctx — here a
`compileArrowAsCallback`-compiled method-call-argument callback (`cbFctx`) —
that index is foreign and either out of range (emit error, our case) or
silently reads the wrong slot.

The existing cross-fctx rescues do NOT cover this route:

- The **#2029 "family A"** arms rescue only names promoted to
  `ctx.capturedBoxGlobals` / `ctx.capturedGlobals` by the accessor-capture
  pass (object-literal accessor bodies). A method-call-arg callback gets no
  such promotion, so the lookup falls through to the else-arm.
- The naive fix (`fctx.localMap.get(cap.name) ?? cap.outerLocalIdx`) was
  **tried as #1177 Stage 1 and REVERTED** — the in-code comment records it
  caused 100+ test262 regressions where the "wrong-slot" behavior was
  load-bearing (async-fn-body null-deref-throw tests). Any fix must not
  reintroduce that.

**Corruption 2 — never-pushed stable handle.** The callee funcIdx baked into
the call (`2097330 = STABLE_FUNC_BASE + 178`) is a handle that was
`mintDefinedFunc`-minted but never `pushDefinedFunc`-pushed — the lifted body
of the nested TDZ-capturing `f` was abandoned on this compile route (a
speculative-compile rollback that leaves `ctx.funcMap` poisoned, or a lifting
path that bails after minting). Even with corruption 1 fixed, the call target
must actually exist; diagnose whether fixing the capture sourcing also fixes
the lifting bail, or whether the mint-without-push needs its own guard
(cf. `check:speculative-rollback`).

## Why #3468 F1 exposes it (it is LATENT on main)

The trigger needs a nested TDZ-capturing function called from a
**method-call-argument callback**. Before F1, `assert.throws = function…` was
dropped at top level, so the `assert.throws(ReferenceError, function(){ f(); })`
call site compiled against an undefined member and the callback compiled on a
path that never prepended f's captures. With F1's keep-arm the statement is
retained, the harness member exists, and the callback path reaches the
cross-fctx else-arm. The hole itself predates F1 — any other route that calls
a TDZ-capturing nested fn from a callback fctx hits the same line.

## Minimal repro (standalone; CE on the F1 branch, OK without the keep-arm)

```ts
import { compile } from "../src/index.ts";
const src = `
function Test262Error(m){ this.message = m; }
function assert(b, m){ if (b !== true) throw new Test262Error(m); }
assert.throws = function(err, cb){ try { cb(); } catch(e){ return; } throw new Test262Error("no throw"); };
(function() {
  function f() { return x + 1; }
  assert.throws(ReferenceError, function() { f(); });
  const x = 1;
}());
`;
const r = await compile(src, { target: "standalone", allowJs: true, fileName: "m.ts", skipSemanticDiagnostics: true });
// r.success === false; errors: "local index out of range … at '__cb_0'"
```

Shrink results (each single removal makes it compile): remove the TDZ (`const
x` after use) → OK; unwrap the IIFE → OK; make `assert.throws` a plain
function `assertThrows(…)` (no property carrier) → OK.

## Fix directions (in preference order)

1. **Extend the #2029 promotion to the callback route**: when
   `compileArrowAsCallback` compiles a body whose call graph reaches a nested
   lifted fn with captures not sourceable in cbFctx, promote those captures to
   the shared box-global mechanism (`ctx.capturedBoxGlobals`) exactly as the
   accessor-capture pass does. Preserves the #1177-revert constraint (owner-
   fctx behavior unchanged; the promotion arms are already localMap-absence-
   guarded).
2. **Refuse loudly instead of emitting garbage**: if promotion is infeasible,
   the else-arm must detect `cap.outerLocalIdx` ∉ current fctx and fail the
   compile with a diagnostic (or reject the callback path so the arg lowers
   via the closure path) — a correct CE beats invalid Wasm, and the closure
   path may simply work.
3. Whatever the fix, add the 4 test262 files as a vitest guard and re-shrink
   #3468's `regressions-allow` accounting in the next measurement window.

## Verification plan

- The minimal repro compiles and instantiates; `assert.throws(ReferenceError,
…)` fires correctly (the TDZ read throws).
- The 4 test262 files flip compile_error→pass (or at minimum →honest fail).
- No regressions in: `tests/issue-1712-capture-closure-dispatch.test.ts`,
  `tests/illegal-cast-closures-585.test.ts` (pre-existing local failures
  noted in #3468 — control against origin/main), the #1177/#2029 test
  families, and the async-fn null-deref tests the #1177 revert protected.

## Re-measured on current `main` (2026-07-31) — two corrections to this issue

Reproduced 4/4 named files via `runTest262File(abs, cat, 60000)` and
`(…, "standalone")` on the same file.

### Correction 1 — it is NOT standalone-only, and it is NOT latent

The `## Symptom` section scopes this to `--target standalone`, and
`## Why #3468 F1 exposes it` calls it **latent on main**. Both are now false:
#3468 landed 2026-07-24, and all four files fail on **both** lanes on current
`main`:

```
host:       local index out of range — 21 (valid: [0, 2)) at '__cb_0'
standalone: local index out of range — 18 (valid: [0, 2)) at '__cb_0'
```

(`…-set-before-initialization.js` reports `valid: [0, 3)`.) So this is a live
default-lane compile failure, not a standalone-only one gated behind a branch.
The differing index (21 vs 18) is the two lanes' differing local counts, not two
defects.

### Correction 2 — "method-call-arg" is NOT a necessary ingredient

The title attributes this to a **method-call-arg** callback. Variable isolation
says otherwise. Minimal repro is 8 lines (`.tmp/probe-3559-min.js`):

```js
(function () {
  function f() {
    return x + 1;
  }
  assert.throws(ReferenceError, function () {
    f();
  });
  let x;
})();
```

Variants, all through the real runner, both lanes:

| variant                                  | result                      | conclusion                                |
| ---------------------------------------- | --------------------------- | ----------------------------------------- |
| v1 — callback passed to a **plain** call | **still CE (21/18)**        | method call **NOT** necessary             |
| v2 — `var x` instead of TDZ `let x`      | compiles; assertion fails   | TDZ `let` **IS** necessary                |
| v3 — callback does **not** call `f`      | **pass**                    | calling nested `f` **IS** necessary       |
| v4 — no IIFE, top level                  | compiles; different failure | enclosing function scope **IS** necessary |

**Necessary ingredient set:** an enclosing function scope, containing a TDZ
`let`, a hoisted nested function reading that binding, and a callback that calls
that nested function. The callee being a _method_ is incidental — v1 reproduces
with a plain function call.

That matters for the fix: anything keyed on the method-call argument path
(`call-identifier.ts`'s method-call-arg handling) would fix the four named files
while leaving the plain-call form broken — the same partial-fix shape that has
cost several rounds elsewhere.

### Instrument note

A bare `compile(src, { allowJs: true })` repro of this shape does **not**
reproduce — it fails earlier on a TypeScript `'x' is possibly 'undefined'`
diagnostic, and an object-literal stand-in for the `assert` harness compiles
cleanly. Use `runTest262File` on a test262-shaped file; the harness assembly and
compiler options are load-bearing here.

## Re-read of `## Root cause` against the corrected trigger (2026-07-31)

**The traced mechanism SURVIVES correction 2.** The root cause names the defect
as _"the call site sits in a **different** fctx"_ and cites the method-call-arg
callback only as the observed instance. My v1 (plain call) is a different route
into the same else-arm, so the mechanism is right and only the
`## Why #3468 F1 exposes it` narrative is over-narrow. **Fix on the cross-fctx
condition, not on the method-call-argument path.**

### The safety unlock for corruption 1

The blocker on record is that `localMap.get(cap.name) ?? cap.outerLocalIdx` was
tried as #1177 Stage 1 and reverted for 100+ regressions where the wrong-slot
read was load-bearing. That revert is about **owner-fctx** behaviour: the naive
form substituted a different index even when the name _was_ a local here. The
two #2029 rescues already in the else-chain avoid it by guarding on
`fctx.localMap.get(cap.name) === undefined`.

A stricter gate is available and is what the fix should use:

> Fire only when the name is absent from `fctx.localMap` **and**
> `cap.outerLocalIdx` is out of range for this fctx's locals — i.e. only when
> the current emission is **invalid Wasm**.

> ⚠️ **SUPERSEDED — see `## Correction 3` at the bottom of this file before you
> implement this.** The safety argument below is correct but the prescription is
> not: this gate is regression-safe and **insufficient**. It provably cannot fire
> on the valid-Wasm/wrong-value form of this defect, which is measured on `main`
> in correction 3. Implementing it yields four green files, a red kill-switch,
> and a silent miscompile still in the tree.

**No passing test can depend on invalid Wasm**, because a module that fails to
emit never runs. So a change gated on "the bytes we emit today are invalid"
cannot reintroduce the #1177 regressions, whose load-bearing behaviour was a
_valid_ module reading a wrong slot. `getLocalType(fctx, cap.outerLocalIdx)`
(already used ~line 1917) is the range probe.

### Blocker — corruption 1 alone will NOT green the four files

`## Root cause` corruption 2 records that the callee funcIdx baked into the call
(`STABLE_FUNC_BASE + 178`) was `mintDefinedFunc`-minted but never
`pushDefinedFunc`-pushed: the lifted body of the TDZ-capturing `f` was abandoned
on this route. Fixing the capture sourcing therefore changes the _error_, not the
outcome — the call target still does not exist. Both corruptions must land
together, and whether they share a cause (a lifting bail that both abandons the
body and leaves the capture unresolvable) is **not yet established**.

### Acceptance for whoever implements

- The four named files pass **and v1 (plain call, `.tmp/v1-plaincall.js`)
  passes** — a fix keyed on the method-call-arg path would green the four and
  leave v1 broken while looking like success.
- Both lanes, since this is a live **default-lane** failure (correction 1).
- **Kill-switch seen to fail**: revert and confirm the `local index out of range`
  returns on both lanes.
- Re-run the #1177/#2029 families and the async-fn null-deref tests the #1177
  revert protected. The invalid-Wasm gate above is the argument that they are
  safe; it still has to be demonstrated, not asserted.

## Correction 3 — REBUTTAL of the "invalid-Wasm gate" above. Do not implement it as written (2026-07-31, from PR #3687 carry-over)

**Read this before acting on `### The safety unlock for corruption 1`.** That
section prescribes:

> Fire only when the name is absent from `fctx.localMap` **and**
> `cap.outerLocalIdx` is out of range for this fctx's locals — i.e. only when
> the current emission is **invalid Wasm**.

**Implementing that gate as the fix ships a guard that fails open.** It cannot
fire on the worst form of this defect, because that form emits valid Wasm by
construction.

### Be precise about what is wrong with it

The safety *argument* is **correct**, and saying otherwise would be the wrong
correction. "No passing test can depend on invalid Wasm" is true, and it does
establish what it claims: a change gated on out-of-range **cannot reintroduce
the #1177 regressions**. That deduction holds.

What is false is the **prescription** built on top of it — *"a stricter gate is
available and is what the fix should use."* Regression-safety is not
sufficiency. The gate is safe **and** inadequate at the same time, and those are
not in tension.

That combination is what makes it dangerous rather than merely wrong. It reads
as proof because it *is* proof — of the narrow property it states, and not of
the property an implementer will actually rely on it for. An implementer
inheriting it as "the safety guarantee for this fix" gets:

- the four named files green,
- v1 (plain call) green,
- a kill-switch that dutifully goes red,
- and a **silent wrong-value miscompile still in the tree**, now with a passing
  test suite asserting the fix works.

A guard that provably cannot fire on the case that matters is worse than no
guard, because the green is load-bearing evidence for the wrong conclusion.

### The concrete case the gate does not fire on

Valid module. Instantiates. Runs. Returns the wrong number. `cap.outerLocalIdx`
is **in range** — so the proposed gate is silent, by design.

### Measured on current `main` (`e4187572`), JS-host lane, no TDZ, no callback

```js
export function test() {
  var acc = 100;
  function bump(v) {
    return acc + v;
  }
  function inner(n) {
    if (n === 0) return acc;
    acc = bump(n - 1);
    return inner(n - 1);
  }
  function outer() {
    return inner(3);
  }
  return outer();
}
```

| engine                     | result  |
| -------------------------- | ------- |
| Node                       | **103** |
| js2wasm on `main` (gc/host)| **3**   |

It compiles, `WebAssembly.instantiate` succeeds, and it runs — it just produces
a wrong number. Isolation (each single removal makes it correct again):

| variant                                                      | result             |
| ------------------------------------------------------------ | ------------------ |
| baseline above                                                | **3** (wrong)      |
| remove `outer()`; `return inner(3)` directly from `test`      | 103 (correct)      |
| add a tagged template (`tag\`${n-1}\`` instead of `bump(...)`)| 3 (same wrong)     |

So the **necessary ingredient is the sibling-nested-function caller** (`outer`
calling `inner`), i.e. the call site emitting `inner`'s capture-prepend sits in
a *lifted* fctx. TDZ, `let`, callbacks and method calls are all **unnecessary**
— this is a third route into the same `local.get cap.outerLocalIdx` else-arm,
strictly wider than v1.

### Why this changes the fix

`outer`'s frame has enough locals that the declaring frame's slot index is
**accidentally in range**, so it reads a live-but-unrelated local instead of
trapping the emitter. A fix gated on "out of range" would green the four named
files **and v1**, and leave this silent miscompile in place — the same
partial-fix shape correction 2 warns about, one level further out.

The gate therefore has to be "the index does not denote **this** binding in
**this** fctx", not "the index is out of range". That is strictly harder, and it
is where the #1177 revert constraint actually bites. A candidate exists on the
closed PR #3687's branch `codex/1400-eslint-e2e`
(`561c933af16651e49f50556b8128967892ce529e`): the `captureLocalIndex` helper in
`src/codegen/expressions/call-identifier.ts`, which resolves in-range collisions
by **type agreement** —

> prefer the current frame's name binding only when the declaring-frame slot's
> type does **not** match `cap.valType` and the name-mapped slot's type does

— plus an unconditional name-mapped path for `__cb_*` frames (host callbacks
have their own frame by construction and their capture prologue has already
re-materialized every value under its lexical name). The mirror of the same fix
for the tagged-template capture-prepend is in `src/codegen/string-ops.ts` on
that branch. Read them before designing from scratch; they are **not** proven
against the #1177 families, and type agreement is a weaker discriminator than
binding identity, so treat them as a starting point rather than a fix.

### Additional acceptance criterion

- The 14-line repro above returns **103**, not 3, on the JS-host lane — a
  wrong-**value** criterion, not a compiles/validates one. A fix that only
  restores emission validity does not satisfy this.
