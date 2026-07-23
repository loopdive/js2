---
id: 3544
title: "standalone: dynamic `.call`/`.apply` on callable values silently answers undefined — gates the entire builtin receiver-validation cluster (~232 projected #3468-cliff tests)"
status: ready
created: 2026-07-23
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: function-call, call, apply, dynamic-dispatch
es_edition: es5
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [3468, 1596, 3140, 2984, 3537]
origin: "#3468 cliff clustering (fable-exposed, 2026-07-23): cluster 3 (builtin receiver-validation, 29/458 sampled ≈ 232 projected) concentration scoping — traced to ONE dispatch arm, not 232 per-builtin gaps"
---

# #3544 — dynamic `.call`/`.apply` on callables answers undefined (standalone)

## Traced mechanism (WAT-verified 2026-07-23, exact chain)

`var s = String.prototype.slice; s.call(undefined, 0)` compiles to:

1. `__call_m_call_2(s, thisArg, box(0))` — builds key `"call"` + an `$ObjVec`
   argvec `[thisArg, arg0]` — then
2. `__extern_method_call(s, "call", argvec)` (`src/codegen/object-runtime.ts`
   ~4055). Receiver `s` is a **builtin proto-method closure** (a funcref-wrapper
   struct minted by `ensureStandaloneNativeMethodClosure`,
   `src/codegen/native-proto.ts` ~417 — `$__proto_method_<brand>_slice`), which
   is neither `$Object` nor `$Vec` nor a CAPTURING closure, so the else-arm
   chain (vec → closure-prop-carrier) falls through to **`ref.null.extern` —
   silent undefined. The call never dispatches.**

Probe matrix (r=1 threw ✓spec / r=3 silent no-throw ✗):
`String.slice/concat .call(undefined)` ✗ · `Uint8Array.filter.call({})` ✗ ·
`ArrayBuffer.slice.call({})` ✗ · `Promise.resolve.call(undefined)` ✗ ·
`Date.setTime.call({})` ✓ (Date routes elsewhere — statically resolved).

## Why ONE fix covers the cluster

The minted closures ALREADY have TypeError-bearing bodies: wired members carry
real receiver checks, un-wired members carry the #2984 refusal body
(`"<Builtin>.prototype.<m> is not yet implemented in --target standalone"` — a
REAL catchable TypeError). The cluster-3 tests assert only the CONSTRUCTOR
(`assert.throws(TypeError, () => m.call(badReceiver))`), so **dispatching the
call is sufficient to flip them — wired or refusal alike**. The gap is purely
the `.call`/`.apply` routing arm in `__extern_method_call`, not 232 per-builtin
receiver checks. (Harness `assert.throws` ctor-identity for a thrown TypeError
verified working — probe3, 2026-07-23.)

## Fix sketch (slice 1: `.call`)

In `__extern_method_call`'s else-arm chain (COMPOSED like #3537 — do not edit
closure-props.ts): a new leading arm
`if (name == "call" && __is_callable(recv)) → __dispatch_fn_call(recv, argvec)`:
- `__is_callable` — the #3140 `buildClosureRefTestArms` callable-gate
  classification already enumerates every funcref-wrapper struct (it powers
  `__bind_dyn`); reuse it.
- `__dispatch_fn_call(recv, argvec)` — thisArg = argvec[0], rest = argvec[1..]
  re-pushed into a fresh `$ObjVec`, then `__apply_closure(recv, thisArg, rest)`.
  Native-string compare for the `"call"` key via the `fillBuiltinFnMeta`
  classify pattern (same as #3537's "length" refusal).
- Arm ORDER: before the closure-prop-carrier arm (a capturing closure's
  `f.call(x)` must invoke `f`, not consult its expando bag; an own expando
  literally named "call" is pathological and broken today anyway).
- `.apply` = follow-on slice (needs array-arg spreading; check what the
  DONE #1596 static path already has as helpers).

## ⚠ Measured-floor HAZARD — must be quantified before PR (do NOT skip)

Dispatching makes the #2984 **refusal-stub bodies reachable**: today
`m.call(x)` on an un-wired member silently answers undefined; after the fix it
THROWS the refusal TypeError. That is spec-directionally better (fail-loud) and
flips the cluster-3 assert.throws tests green, but any today-passing standalone
test that *tolerates* the silent undefined would flip pass→fail at module init.
The #2984 comment explicitly measured this class of regression once before
(`hasOwnProperty.call` idioms rely on the null-return fall-through of
`emitReflectiveNativeProtoClosureCall` — note that is a DIFFERENT, static
route; verify it stays untouched). Validation protocol (the #3537 template):
1. stride-8 floor run (main vs main+fix) — regressions MUST be ~0; every
   regression individually triaged (a refusal-throw regression means the
   member needs a real wired body or the arm needs a narrower gate);
2. re-run the 458 #3468-cliff sample on routing-harness ± fix — report
   measured flips ONLY (coordinator directive: a sibling agent's 29% signature
   share measured 2/198 — size on flips, never share);
3. `hasOwnProperty.call` / `propertyIsEnumerable.call` harness idioms explicitly
   re-tested.

## Measurement infrastructure (reusable, in the fable-exposed worktree)

`/workspace/.claude/worktrees/agent-a5ae601287feed137/.tmp/m3468/`:
`driver.mts` (CI-exact worker-pool runner), `extract.mts` (deferTopLevelInit
payload extractor), `measure-all.sh` (4-phase template), bundles under
`bundles/{main2,fix,harness2,harnessfix}`, sample lists
(`sample-stride8.txt`, `regressed.txt`), and branch `tmp-harness2` /
`tmp-harnessfix` (origin/main ± routing-revert cherry-pick 5a71adf7c4eee3 +
compat shim) for cliff re-measurement.
