---
id: 3111
title: "Decompose the five call-shape god functions (#742 residue) into per-family probe modules"
status: ready
sprint: current
created: 2026-07-09
updated: 2026-07-18
priority: medium
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
related: [742, 1172, 3102, 3105, 3112, 3399, 3400]
supersedes_own_framing: true
---

# #3111 — Decompose the five call-shape god functions

> **RE-SCOPED 2026-07-18 (Fable architecture audit, #3399).** The original
> target — `compileCallExpression`, then a single 12,210-LOC function — was
> **decomposed by #742 (done)**: it is now **1,684 LOC** and `calls.ts` shed
> ~10,500 LOC (18,474 → 7,898). But #742 split the mega-function by _call
> shape_ into five sibling files, each of which now hosts a **1,800–3,100-LOC
> god function** of its own. The god function fractured into five smaller
> gods. **This issue is retargeted onto those five.** The original phasing
> (probe contract, tail-first peel, byte-identity per slice) is sound and
> carried forward; only the anchors change. Prior framing preserved in
> "History" below.

## Problem (measured on `origin/main` @ 2026-07-18)

#742's call-shape split produced five receiver/namespace dispatch cascades,
each a string-matched if-cascade keyed on the receiver symbol / builtin
namespace / method name — the same shape the original god function had, just
partitioned:

| Function                     | File                                   | LOC   | Dispatches on (sample arms)                                       |
| ---------------------------- | -------------------------------------- | ----- | ----------------------------------------------------------------- |
| `compileReceiverMethodCall`  | `expressions/call-receiver-method.ts`  | 3,102 | `recvSym`: TextEncoder/TextDecoder/Uint8Array/DataView/… + method |
| `compileBuiltinStaticCall`   | `expressions/call-builtin-static.ts`   | 3,054 | namespace: Math/Atomics/BigInt/Number/String/Date/escape/…        |
| `compileIdentifierCall`      | `expressions/call-identifier.ts`       | 2,106 | bare fn name: readFileSync/writeFileSync/isNaN/parseInt/…         |
| `compileNamespaceStaticCall` | `expressions/call-namespace-static.ts` | 1,930 | namespace: Symbol/ArrayBuffer/Reflect/…                           |
| `compileTailDispatch`        | `expressions/call-tail-dispatch.ts`    | 1,793 | closure / IIFE / return-position tail-call lowering               |

Each arm mixes a syntactic predicate (`recvSym === "DataView"`), argument
compilation, late-import registration, and body emission — so every new
builtin lands another arm and the files keep growing. These five functions
are the densest remaining pocket of >300-LOC functions (#3399 §2) and the
top merge-conflict surface among dev agents.

## Why still `feasibility: hard`

Same reason as the original: arms share **mutable local state accumulated
earlier in the function** (resolved receiver info, arg-count locals, memoized
type lookups) and interleave `fctx.body` emission with predicate evaluation
(a predicate that compiles a sub-expression to _inspect_ it has already
emitted code). A naive per-arm extraction breaks those data flows. Needs a
design pass (fable) then mechanical execution — but the surface is now 5 ×
~2.5k-LOC functions instead of 1 × 12k, so it is materially more tractable
than the pre-#742 state.

## Target structure

```
src/codegen/expressions/
  call-receiver-method.ts   — dispatcher: ordered tryCompileXxx(...) probes
  call-builtin-static.ts    — dispatcher
  call-identifier.ts        — dispatcher
  call-namespace-static.ts  — dispatcher
  call-tail-dispatch.ts     — dispatcher
  call-shapes/
    receiver-textcodec.ts   (TextEncoder/TextDecoder/Uint8Array hex/base64)
    receiver-dataview.ts    (DataView get/set family)
    static-math.ts          (Math.* — several arms already delegate)
    static-number.ts        (Number.* statics)
    static-string.ts        (String.* statics)
    static-date.ts          (Date.* statics)
    static-bigint-atomics.ts
    namespace-symbol.ts     (Symbol.for/keyFor/…)
    namespace-arraybuffer.ts
    tail-closure.ts / tail-iife.ts
    …
```

Contract per shape (unchanged from original): `tryCompileXxxCall(ctx, fctx,
expr, shared): InnerResult | NOT_THIS_SHAPE`, with the hard rule **a probe
that declines MUST NOT have emitted into `fctx.body`** (predicate/emit
separation). The `shared` parameter carries the formerly-function-local state
as a typed `CallSiteInfo` object built once at the top of each dispatcher —
mirror the `ObjectCoreShared` bag pattern #3108 uses for object-runtime.

## Phasing (each phase independently mergeable + identity-proven)

Do the five files **independently and in size order** (smallest first, to
prove the pattern cheaply): `call-tail-dispatch.ts` → `call-namespace-static.ts`
→ `call-identifier.ts` → `call-builtin-static.ts` → `call-receiver-method.ts`.
Within each file:

- **Phase 0 — corpus + baseline.** Extend the `prove-emit-identity` corpus
  (`scripts/emit-identity-corpus/`, the extra root the tool already walks —
  same one #3108 slice 0 uses) with ~5–8 tiny probes per file, one per arm
  family (enumerate by reading the cascade top-down: the `=== "Name"` string
  matches are the family boundaries — see the grep in the table above).
  `node scripts/prove-emit-identity.mjs baseline`.
- **Phase 1 — peel from the TAIL.** The last arms in each cascade (fallback
  paths) have the fewest state dependencies (everything before declined).
  Extract bottom-up into `call-shapes/<family>.ts`; the dispatcher calls the
  probe. `prove-emit-identity check` → **IDENTICAL** per arm.
- **Phase 2 — peel self-contained heads.** Arms that already start with a
  cheap syntactic predicate and locally compute everything (e.g. `Math.*`,
  which several arms already delegate to `compileMathCall`) move next.
- **Phase 3 — shared-state extraction.** Introduce `CallSiteInfo` for the
  remaining entangled middle; move state reads onto it one field at a time.
- **Phase 4 — enforce.** The per-function ceiling (**#3400 / R-FUNC**) banks
  each shrink automatically and blocks regrowth — this issue is a primary
  consumer of #3400. Land #3400 (roadmap phase E0) FIRST so every slice here
  ratchets down.

Any arm that cannot be extracted without changing emission order gets LEFT IN
PLACE and documented — partial completion is acceptable; the
dispatcher-with-probe-modules shape is the goal, not 100% extraction.

## Coordination / blocked-on (#3399 §5 E7)

- **`call-tail-dispatch.ts` is adjacent to the async/generator rewrite**
  (#3386–#3391, #2662): tail-call lowering in return position touches the
  same closure/return machinery. **Do that file LAST and only after those
  land**, or coordinate ranges with their owner. The other four files are
  independent of async work.
- Low conflict risk against #3108 (different files) but re-merge `origin/main`
  before enqueue as usual.
- Re-anchor by symbol, not line — every arm line number will drift as slices
  land.

## Safety story

`prove-emit-identity` per extracted arm, over the extended corpus, all
targets (gc / standalone / wasi). Additionally scoped vitest: `tests/` has
extensive per-builtin call tests (`tests/issue-*`, Math/Number/String/Date/
DataView suites). Risk concentrates in Phase 3; Phases 0–2 are provable
motion. If any phase can't prove identity, it stops there and re-plans —
earlier phases still deliver value.

## Estimated LOC delta

Net ≈ 0 (motion) minus the duplicated throw-guard/arg-coercion scaffolds each
file re-emits (folds into #3105 builders / #3182 S1 shared throw template) ≈
**−400 to −800** across the five files. Each dispatcher target: < 400 LOC.

## Acceptance criteria

1. IDENTICAL identity proof per extraction commit (extended corpus, full
   gc/standalone/wasi matrix).
2. Each of the five dispatcher functions < 800 LOC (stretch: < 400); no
   remaining call-shape function > 1,500 LOC.
3. Probe contract documented + enforced (decline ⇒ no emission) — add a debug
   assertion on `fctx.body.length` around probes in dev builds.
4. Extracted families ratchet-banked by #3400 (R-FUNC); no regrowth.
5. No test262 regression on any shard.

## History (superseded framing, 2026-07-09)

The original issue targeted `compileCallExpression` as a single 12,210-LOC
function (`calls.ts:4190–16400`) — "the largest function in the codebase and
growing fast (calls.ts 15,292 → 17,246 in 12 days)." **#742 (done)**
decomposed it to 1,684 LOC by splitting on call shape into the five sibling
files this issue now targets. The probe-contract design, tail-first peel
order, `CallSiteInfo` shared-state extraction, and byte-identity-per-slice
safety story are carried forward verbatim — only the target functions moved
from one to five. Original `related`: [1172, 3102, 3105, 3112].
</content>
