---
id: 2768
title: "bare-var receiver recovery: per-type externref→ref recovery hardening + safelist expansion (follow-on of #2767's Date-only gate)"
status: wont-fix
sprint: 75
priority: medium
assignee: ttraenkler/agent-a7e5749647e8f1219
created: 2026-06-28
updated: 2026-07-03
resolution: wont-fix
resolution_reason: "Safelist expansion strictly regresses for every candidate type with zero wins (deterministic repro of #2228). Date (#2767) worked only because it was dynamic-fails+nominal-works; every other candidate is dynamic-works+nominal-incomplete, so substituting strictly loses. Standalone gaps are orthogonal (belong to #2151 family / super-call lowering / DataView ToIndex coercion). See Investigation (2026-07-03)."
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: methods, dynamic-dispatch, type-flow, property-access
goal: spec-completeness
related: [2767, 2151, 1888]
predecessor: 2767
horizon: m
---

# #2768 — bare-`var` receiver recovery: per-type hardening + safelist expansion

Follow-on of **#2767**. #2767 added `resolveAssignedNominalType` (recover the
nominal type a bare-`var`/`let` identifier holds when the TS checker reports
evolving-`any`) and substitutes it at the **call** dispatch hub so `var d; d =
new Date(0); d.toISOString()` dispatches.

#2767's first cut substituted for ANY recovered nominal and **failed the
`merge_group` test262 gate** — substituting `receiverType` across the ~10
nominal dispatch gates regressed 6 NON-Date receivers whose externref→ref
value-recovery is unguarded or whose native dispatch is partial. #2767 was
therefore narrowed to a **`SAFE_BARE_VAR_RECOVERY_NOMINALS` safelist (Date
only)** (`src/codegen/expressions/calls.ts`). This issue tracks **expanding that
safelist one type at a time**, each gated behind a full-CI / `merge_group`
validation, by first hardening that type's recovery path.

## The exact per-type recovery bugs (from #2228's merge_group delta)

Each is a bare-`var` (or recovered) nominal receiver routed into a dispatch path
that misbehaves. Fix the path, add the type to the safelist, validate via
`merge_group`:

| type                                | test262 evidence                                                                                      | failure                                                 | fix needed                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Promise**                         | `built-ins/Promise/prototype/finally/{rejected,resolved}-observable-then-calls-PromiseResolve.js`     | `illegal_cast` in the recovered closure (`__closure_0`) | guard the externref→ref recovery (`ref.test` before `ref.cast`) on the Promise/thenable path                                  |
| **RegExp**                          | `language/literals/regexp/y-assertion-start.js` (`re.test`)                                           | wrong value (returns truthy `1` not `true`)             | harden bare-var RegExp `.test`/method dispatch + boolean boxing                                                               |
| **SharedArrayBuffer / ArrayBuffer** | `built-ins/SharedArrayBuffer/prototype/grow/this-is-not-resizable-arraybuffer-object.js`              | `.grow()` skips the spec TypeError                      | brand-check the recovered buffer receiver                                                                                     |
| **super-spread**                    | `language/expressions/super/call-spread-obj-spread-order.js`                                          | `wasm_compile` (invalid Wasm)                           | the recovered super/closure receiver path emits invalid Wasm — needs the super-call lowering to tolerate the substituted type |
| **DisposableStack**                 | `built-ins/DisposableStack/prototype/dispose/throws-error-as-is-if-only-one-error-during-disposal.js` | `assertion_fail`                                        | recovered dispatch path partial                                                                                               |

## Also folded in: property reads/writes (was the original #2768 scope)

Property **reads** (`d.field`) and **writes** (`d.x = …`) on a bare-`var`
receiver compute their OWN `receiverType` in `property-access.ts`
(`compilePropertyAccess`, the `objType = getTypeAtLocation(...)` site) — separate
from the call hub. Struct-field reads/writes ALREADY work (runtime value
recovery), so there is no Date-shaped win there; the divergent cases are
builtin property reads keyed on the static nominal symbol (`Map.size`,
`Set.size`, `ArrayBuffer.byteLength`, …). When a type is hardened + safelisted
above, also route the same `resolveAssignedNominalType` recovery through the
property read/write `objType` resolution, gated on the SAME safelist. (The same
unguarded-recovery regression risk applies — never substitute a non-safelisted
type.)

## Acceptance criteria

- For each type added to `SAFE_BARE_VAR_RECOVERY_NOMINALS`: its recovery path is
  guarded/correct, the cited test262 file(s) pass, and a full `merge_group` run
  shows net ≥ 0 with no new regression bucket.
- `resolveAssignedNominalType`'s var/let-only + all-assignments-agree + safelist
  guards remain intact.
- The shared helper may be hoisted to `shared.ts` so both the call hub and the
  property read/write paths import it (`calls.ts` imports from
  `property-access.ts`, so it cannot live in either without a cycle).

## Notes

- Do NOT remove any type from the safelist without a regression.
- Broad-impact (substituted `receiverType` flows into ~10 gates) → every safelist
  addition validates on full CI / `merge_group`, never a scoped sweep.

## Investigation (senior-dev, 2026-07-03) — measure-first result: safelist expansion has NO available win on current main

Reproduced the current gap before extending the pattern (as #2767 demanded).
Measured every candidate type's bare-`var` receiver behaviour on current
`upstream/main` (`0585f3179`) in BOTH host and standalone, via
`runTest262File` on the cited files and via `compileToWasm` micro-repros.
Temporarily expanded `SAFE_BARE_VAR_RECOVERY_NOMINALS` to
`{Date,RegExp,SharedArrayBuffer,ArrayBuffer,DisposableStack,Promise}` and to
`{Date,DataView}` and diffed. **All measurement code was reverted; no source
change is proposed by this section.**

### Finding 1 — the per-type safelist expansion yields regressions and ZERO wins

1. **Host dynamic path already dispatches these bare-`var` receivers correctly.**
   On current main (Date-only safelist), all six cited "regression" files PASS
   on host, and micro-repros confirm: `var re; re=/a/; re.test("a")` → `true`
   (boolean), `var s; s=new Set(); s.add(1); s.has(1)` → `true`,
   `var m; m=new Map(); m.set(1,2); m.size` → `1`,
   `var dv; dv=new DataView(new ArrayBuffer(8)); dv.setUint8(0,42); dv.getUint8(0)`
   → `42`, `var ta; ta=new Uint8Array(4); ta[0]=7; ta[0]` → `7`. So there is no
   host win to be had — the generic dynamic path is already complete for them.
2. **Adding the types to the safelist strictly regresses.** With all six
   safelisted, HOST flips pass→fail for RegExp (`y-assertion-start`),
   SharedArrayBuffer (`grow/this-is-not-resizable…`) and DisposableStack
   (`dispose/throws-error-as-is…`); STANDALONE flips pass→fail for
   DisposableStack. **Net improvements in either mode: zero.** This is the exact
   #2228 `merge_group` regression, reproduced deterministically: the recovered
   receiver is routed into a per-type nominal path that is _less_ complete than
   the dynamic path it replaces.
3. **The standalone failures are orthogonal to bare-`var` recovery.** RegExp
   `y-assertion` (sticky `lastIndex`), Promise `finally` (`compile_error`),
   SharedArrayBuffer `grow` (missing spec `TypeError`) and `super`-spread
   (invalid Wasm in super-call lowering) fail in standalone REGARDLESS of the
   safelist, and safelisting does not change their status (proven: standalone
   verdicts unchanged / DisposableStack worse). The gap is in the standalone
   builtin _method-dispatch substrate_ (#2151 family) and in super-call
   lowering — the externref→ref value-recovery is NOT the blocker.
4. **DataView** (the largest bucket, 43 files) already works bare-`var` in host
   AND standalone without being safelisted; safelisting it does not flip the
   failing DataView files (`toindex-bytelength`, `defined-byteoffset`) — those
   fail on constructor-arg `ToIndex` coercion, unrelated to receiver dispatch.

**Why Date (#2767) was different:** Date bare-`var` host dispatch _failed_ on the
dynamic path (`toISOString is not a function`) AND Date's nominal path was
complete — i.e. dynamic-fails + nominal-works, so substituting won. Every other
candidate is the mirror image (dynamic-works + nominal-incomplete), so
substituting strictly loses. The premise "harden recovery → add to safelist →
net-positive flip" does not hold for the remaining types on current main.

**Recommendation:** do NOT expand `SAFE_BARE_VAR_RECOVERY_NOMINALS`. Re-scope
#2768: either close `wont-fix` (no available win via the recovery/safelist
mechanism) or redirect the real standalone builtin-dispatch gaps to the #2151
value-rep substrate family and the super-call-lowering gap to its own issue. The
Date-only safelist should stay exactly as-is.

### Finding 2 (separate issue) — #2767's own unit tests regressed to invalid Wasm

`tests/issue-2767.test.ts` currently has 6/11 tests failing on `upstream/main`
with `Invalid Wasm binary`. Precise V8 error on the minimal repro
`var d; d=new Date(0); const s=d.toISOString(); return s[s.length-1]` (returned
as `any`): **`CompileError: f64.convert_i32_s[0] expected type i32, found
local.get of type externref`**. The `const d = …` and `getTime()` variants
compile fine — the fault is specific to _returning a dynamically-typed
string-index result as `any`_: bare-`var` recovery fixes the DISPATCH, but the
checker still types the call result `any`, so downstream string ops on that
`any` value hit a coercion bug that emits `f64.convert_i32_s` on an externref.

This is NOT a broad conformance regression — the actual Date/toISOString test262
cluster is 15/17 passing on host (the 2 failures, `-0-9`/`-0-10`, are
RangeError / multi-arg-constructor semantics, unrelated to bare-`var`). It
drifted silently because the required `quality` CI gate does not run
`issue-2767.test.ts`, and the test262 gate sees no Date regression. Should be
filed as its own `any`-context string-index-return coercion bug (an
`src/codegen/type-coercion.ts` fix), independent of the safelist mechanism.
