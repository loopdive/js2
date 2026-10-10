---
id: 6940
title: "for-statement body buffer is detached while the incrementor compiles — a string-constant import added there leaves the body's module-global indices stale (Octane box2d `b2BuoyancyController.Step` reads `__argc` as `$__hole`, invalid Wasm)"
status: ready
sprint: current
created: 2026-10-10
updated: 2026-10-10
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
language_feature: for-loop, compiler-internals
goal: compilable
related: [874, 1690, 2710, 1384, 2001]
assignee: "ttraenkler/claude-session-c-octane-loop-body-global-shift-20261010"
---

# #6940 — for-loop body misses the module-global index shift fired by its own incrementor

Found by the Octane triage for [#874](https://js2wasm.loopdive.com/dashboard/issue.html?slug=874-benchmark-compare-all-js-to)
(Session C, 2026-10-10, main `01e4888aae`). Octane `box2d.js` (+ `base.js`) on
the **gc host lane**: `compile()` says `success=true` (88 s), the binary is
rejected:

```
Compiling function #2223:"__closure_879" failed: extern.convert_any[0] expected type anyref, found global.get of type i32 @+662925
```

`__closure_879` is `w.prototype.Step` of `b2BuoyancyController` (box2d.js
line 308). The 8 failing sites are all the hole-aware f64→externref boxes
(`vec-f64-hole-coercion.ts::f64HoleToExternrefInstrs`) of `Y += D`,
`I.x += D*u.x`, … inside the inner `for (var I=…, z=L.GetFixtureList(); z; z=z.GetNext())`
loop. Each reads `global.get 13` (`__argc`, `(mut i32)`) where `$__hole`
sits at `global 14`. The other 4,773 `$__hole` reads in the module are correct.

**Standalone is NOT affected on current main** (box2d standalone: 325 s compile,
`WebAssembly.compile` VALID) — the trigger path (`tryEmitDeleteAwareDynamicGet`
→ host property-key string import) is gc-only. The brief's "both lanes" claim
for box2d did not reproduce; the standalone finding is compile time only (#6941).

## Mechanism (confirmed by instrumenting `holeSentinelInstrs` + `fixupModuleGlobalIndices`)

Trace (box2d, `JS2_HOLE_TRACE`): all 8 sites were emitted with index 1041
(correct at the time: `numImportGlobals` 1027 + module slot 14). While still
inside `__closure_879`, one `fixupModuleGlobalIndices(threshold 1027, +1)` ran and
`ctx.holeGlobalIdx` became 1042 — but **the 8 already-emitted `global.get`
objects stayed at 1041** (`MISSED has=1041 want=1042`). Its stack:

```
addStringConstantGlobals ← addStringConstantGlobal ← addHostStringConstantGlobal
← registerHostPropertyKey (host-property-key.ts:11) ← reserveMemberGetDispatch (member-get-dispatch.ts:427)
← tryEmitDeleteAwareDynamicGet (property-access.ts:3076) ← compilePropertyAccess
← compileAssignment ← compileForStatement (statements/loops.ts:889)      ;; <-- the INCREMENTOR compile
← compileLiftedClosureBody (closures.ts:3461)
```

`loops.ts:889` is `compileExpression(ctx, fctx, stmt.incrementor)`. For the
outer loop `for (var M=this.m_bodyList; M; M=M.nextBody)`, `M.nextBody` is the
first `nextBody` member read compiled in this module, so its host property-key
string import is minted right there and shifts every module global by +1.

Root cause, `src/codegen/statements/loops.ts::compileForStatement`:

```ts
compileLoopBodyWithShadows(ctx, fctx, stmt.statement);
const bodyInstrs = fctx.body;                 // L865 — loop body buffer
…
const incrInstrs: Instr[] = [];
ctx.liveBodies.add(incrInstrs);               // L878 (#1690 registered cond + incr …)
fctx.body = incrInstrs;                       // L879 — bodyInstrs is now DETACHED
if (stmt.incrementor) { … compileExpression(ctx, fctx, stmt.incrementor); }   // L889
…
fctx.body.push(blockLoop(loopBody));          // L925 — body re-attached only here
```

Between L879 and L925 `bodyInstrs` is reachable from none of the walker's roots
(`currentFunc.body` = incrInstrs, `savedBodies` holds the OUTER body,
`liveBodies` holds cond+incr, `funcStack`/`parentBodiesStack`/`mod.functions`
do not contain it). #1690 fixed the cond/incr buffers for the window the BODY
compiles; this is the mirror gap — the body buffer for the window the
INCREMENTOR compiles. `compileDoWhileStatement` (L1040–L1050) has the same
shape (body compiled, then `fctx.body = condInstrs` while the body is detached)
— suspected, not measured.

## Minimized repro (gc lane)

```js
// b2r4.js — node: run() === 8
var holes = [1, , 3];               // arms ctx.usesArrayHoles (hole-aware f64 -> externref boxing)
var junk = { a: 1 }; delete junk.a; // arms ctx.moduleUsesDelete (delete-aware dynamic member get)
function Ctl() { this.list = null; }
Ctl.prototype.Step = function () {
  var total = 0;
  for (var M = this.list; M; M = M.nextBody) {       // incrementor: first `nextBody` read in the module
    var L = M.body;
    for (var z = L.first; z; z = z.GetNext()) {
      var D = z.Area();
      total += D;                                    // hole-aware box of `total` → `global.get $__hole`
    }
  }
  return total;
};
export function run() {
  var c = new Ctl();
  var z2 = { Area: function () { return 3; }, GetNext: function () { return null; } };
  var z1 = { Area: function () { return 2; }, GetNext: function () { return z2; } };
  c.list = { body: { first: z1 }, nextBody: null };
  return c.Step() + holes.length;
}
```

`node --import tsx .tmp/min.mjs .tmp/b2r4.js gc` → the module **validates by
luck** and `run()` returns 8, but `wasm-dis` shows the defect: the hole
sentinel arm reads `(global.get $global$2)` — a `(mut externref)` global — while
`$__hole` is `$global$4 (struct.new_default $Hole)`. The instrumented compile
reports `MISSED site fn=__closure_2 has=13 want=15` at the `nextBody` fixup
(stack ends in `compileForStatement (loops.ts:889)`). Whether validation fails
depends only on the type of whichever global happens to sit at the stale index
(box2d: `__argc` i32 → invalid; here: externref → valid but wrong value if the
f64 ever carries `HOLE_F64_BITS`). Negative control: the same program on
`target: "standalone"` is VALID and no fixup fires (no host string imports).

## Implementation Plan

Lane: gc/host only is where it bites today, but the fix is in the shared
statement lowering and must be lane-neutral (it only changes walker
reachability, no emitted bytes).

1. **`src/codegen/statements/loops.ts::compileForStatement`** — keep the body
   buffer reachable for the incrementor window. Either
   (a) `ctx.liveBodies.add(bodyInstrs)` right after `const bodyInstrs = fctx.body`
   (L865) and `ctx.liveBodies.delete(bodyInstrs)` next to the existing
   cond/incr deletes after `fctx.body.push(blockLoop(loopBody))` (L943–944) —
   the #1690 idiom; or (b) replace the manual swap `fctx.body = incrInstrs`
   with `pushBody(fctx)` so the body lands in `savedBodies` (then `popBody`
   before assembly). (a) is the smaller diff and matches the surrounding code.
2. **`compileDoWhileStatement`** (L1040–L1050): same registration for
   `bodyInstrs` while `condInstrs` compiles. Add a do-while variant to the test
   (body with a hole-aware box, condition with a first-time dynamic member read).
3. **Semantics constraint.** No change to evaluation order or emitted
   instructions; ECMA-262 §14.7.4.3 ForBodyEvaluation (body → increment → test)
   stays exactly as lowered today. The fix is bookkeeping only.
4. **Regression tests** (`tests/issue-6940-for-body-global-shift.test.ts`,
   pattern of `tests/issue-1690.test.ts`): compile b2r4 via public `compile()`
   on gc with `emitWat: true`; assert `WebAssembly.compile` accepts AND that the
   `global.get` following every `i64.const 0x7ff00000deadc01e … i64.eq … if` arm
   names the `__hole` global (structural check — the validity check alone is
   luck-dependent, see above). Add: `run()` → 8 on gc; standalone VALID + 8
   (negative control); do-while twin.
5. **Acceptance check.** Octane box2d (+ base.js, same driver as #6939)
   compiles to a `WebAssembly.compile`-valid module on gc. (Runtime behaviour of
   the bench is #874's harness work, not this issue.)
6. **Hardening (optional, same PR or follow-up under #2710).** A debug assertion
   in `fixupModuleGlobalIndices` under an env flag: every `global.get/set` with
   `index >= threshold` created since the last fixup must be reachable — the
   `JS2_HOLE_TRACE` detector used here is the prototype. #2710 (late-bind
   indices) is the structural fix for the whole class; this issue is the
   point fix.

## Acceptance criteria

- b2r4 → hole arms read the `__hole` global (WAT check), valid, `run() === 8`
  on gc; standalone unchanged.
- box2d (+ base.js) → valid Wasm on gc.
- `tests/issue-1690.test.ts` still green; no test262 regression; equivalence
  gate green.

## Ownership note

Session A's WasmGC/shared area; implementation by Session C at the project
lead's direction. Exact touch points: `src/codegen/statements/loops.ts::
compileForStatement` (L865–L944: `liveBodies` registration of `bodyInstrs`) and
`::compileDoWhileStatement` (L1040–L1074). Read-only: `registry/imports.ts::
fixupModuleGlobalIndices` (walker roots, L560–L654), `context/bodies.ts`
(`pushBody`/`popBody`). No change to `array-holes.ts`, `member-get-dispatch.ts`,
`host-property-key.ts`.

## Overlap check (2026-10-10)

- `plan/issues`: #1690 (done) is the cond/incr half; #2710 (ready, unclaimed)
  is the late-binding umbrella — cite, don't block on it; #1384 the func-index
  twin. No issue names the body buffer.
- Open PRs: none modify `statements/loops.ts` (checked via `/pulls/N/files`).
- Claim ledger: no claim on this id.
