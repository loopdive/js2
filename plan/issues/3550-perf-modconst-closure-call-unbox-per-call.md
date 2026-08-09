---
id: 3550
title: "perf: module-const closure calls pay a per-call unbox + guarded cast after #3534 (+77% rel / ~0.74ns abs per call in hot loops) — cache or dual-store the precise ref for const bindings"
status: ready
sprint: Backlog
created: 2026-07-23
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: perf
area: codegen
language_feature: closures
goal: performance
related: [3534, 3547]
---

# #3550 — per-call unbox cost on module-const closure calls (the #3534 rep's known trade)

## Measured (2026-07-23, #3534 step-5 A/B; `.tmp/bench-3534-step5.mts` recipe in the owner's notes)

Median of 7 runs after warmup, gc/host lane, 5M-call hot loops. OLD =
pre-#3505 main (`4e870095`), NEW = post-#3505 (+#3547 branch — the stopgap
removal is byte-inert so the delta is entirely the #3534 representation):

| shape                                                              | OLD    | NEW         | delta                                           |
| ------------------------------------------------------------------ | ------ | ----------- | ----------------------------------------------- |
| `const add = (a,b)=>a+b` called 5M× from an exported fn            | 4.80ms | 8.36–8.52ms | **+77% rel, ~+0.74ns/call abs**                 |
| mutually-recursive `even`/`odd` (200k × depth 20)                  | 6.88ms | 9.05–9.68ms | **+32–41%**                                     |
| HOF: module-const closure passed as typed param, called 5M× inside | 3.43ms | 3.43–3.45ms | ~0 (param carries the precise ref — unaffected) |
| fn-DECLARATION control, same 5M loop                               | 4.66ms | 4.73–4.92ms | ~noise (direct calls — unaffected)              |

Cause: under the #3534 invariant the `$__mod_<name>` binding stays `externref`
for life; a call from any function OTHER than the declaring scope re-does
`global.get; any.convert_extern; ref.test; ref.cast` per call (the precise
LOCAL shortcut only exists inside the declaring function). Previously the
retro-narrowed global gave a raw precise `global.get` — fast but the source of
the #3533/#3534 invalid-Wasm/trap family, so simply reverting is not on the
table.

**Landing-page sidebar is unaffected**: fib/loop/string/array are all function
DECLARATIONS (direct calls). No committed benchmark exercises the regressed
shape; this is a latent cost for closure-call-bound user code.

## Fix directions (either preserves the never-narrow invariant)

1. **Per-function unbox caching (smaller):** for a `const` binding (immutable),
   the guarded-cast result is invariant — hoist it: first call in a function
   caches the cast result in a function-local; later calls `local.get` +
   null-check. Turns N unboxes into 1 per function activation.
2. **Dual-store for const closures (better):** alongside the externref
   `$__mod_<name>`, keep a SECOND precise-typed global `$__mod_<name>_ref`
   written once at the decl store; calls read the precise global directly
   (zero per-call cost), value-reads keep the externref one. `let` bindings
   stay on the guarded path (reassignable — and note #3546 must fix the
   let-reassign write path first so both stores stay in sync).

## Acceptance criteria

- `modconst_call_hot` within ~10% of the OLD 4.80ms figure; mutual-recursion
  shape similarly recovered.
- The #3534 invariants hold: no retro-narrow, #3534/#3533 guard tests +
  corpus (sha256s in #3534) stay green; zero invalid-Wasm signatures.
- A/B numbers re-measured with the same recipe and recorded here.
