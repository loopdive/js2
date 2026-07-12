---
id: 3153
title: "IR post-claim divergence meter — empirical census of the #3143 IR-first flip's throw-site set"
status: done
assignee: ttraenkler/fable-irfb
completed: 2026-07-12
sprint: current
created: 2026-07-12
updated: 2026-07-12
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: tooling
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2855
related: [3143, 3144, 2949]
loc-budget-allow:
  - src/compiler.ts
---

# #3153 — IR post-claim divergence meter

Tooling slice for the #3143 IR-first-default flip. The flip's CI A/B diverged
(50+ equivalence regressions) because the STATIC selector
(`planIrCompilation`) claims functions the `from-ast` builder cannot lower, so
it throws **post-claim**. Under the overlay that throw is caught and the legacy
body is used (silent metered demote); under IR-first the skipped slot turns it
into a hard `unreachable`/compile error. The set of throw-message **classes** is
exactly the selector-precision work list (fix (A) in
`plan/issues/3143-ir-first-default-flip.md`).

This slice makes that set **measurable empirically** instead of by grep:

- **`scripts/ir-postclaim-meter.mts`** — compiles a broad corpus (stride sample
  of test262 + all example/playground `.ts`) with `experimentalIR: true` and
  buckets every `irPostClaimError` by the SAME normalized message class the
  `check:ir-fallbacks` post-claim gate uses. Output: a frequency-ranked
  histogram (count + example file/func) + raw JSONL for follow-up slicing.
  `STRIDE` env controls sample density (default 15; use a COARSE stride like
  300–500 to keep the box responsive — a dense sample fans out heavy parallel
  compiles). NON-GATING (a census).
- **Env-gated JSONL sink** (`src/compiler.ts`, `JS2WASM_IR_POSTCLAIM_LOG=<path>`)
  — appends one JSONL record per post-claim demotion during ANY compile, so a
  whole test-suite run doubles as a throw-site census. Byte-inert: no fs touch
  when the env var is unset; node-only (guarded `process.getBuiltinModule`),
  never a static browser-bundle dep.

## Findings (first census, 2026-07-12)

Coarse test262 + full-examples sample: the test262 corpus is **sparse** for
post-claim demotions (whole-function claiming is rare there — most functions
reject at the SELECTOR, i.e. `body-shape-rejected`/`external-call`, not
post-claim). The dense-claiming divergence corpus is the equivalence suite
(where the #3143 A/B measured its 50+), matching that diagnosis's explicit
enumeration:

**Ranked remaining post-claim divergence classes** (confirmed live via probe):

1. `.charCodeAt(...)` / `.substring(...)` on string — the wasm:js-string method
   family. NOT in `STRING_METHOD_TABLE`; the env `string_<method>` family the
   IR uses does not include them (they lower via `wasm:js-string.substring`/
   `.charCodeAt` builtins with i32 args + `ref_extern` results — a NEW resolver
   plan variant, and a bare-name resolve collision the `string_*` family was
   designed to avoid, #1072). **M-L slice, host-runtime surface.**
2. `string operator '<' / '>' / '<=' / '>='` — string relational. Legacy is
   mode-split (host js-string compare vs native `__str_compare`) with
   mixed-operand ToNumber + NaN handling. **M-L slice.**
3. `unary '+' expects number` — string→number ToNumber coercion. Mode-dependent
   host call. **M slice.**
4. `element store on a TypedArray view` — the only class the test262 sample
   surfaced (`nm_js2wasm_node_fs.ts`). Per-view ToUint8/clamp conversions stay
   legacy (already a documented #2856-C2 residual). **Defer.**

**Retired by #3144** (this track's first landed slice): accessor-has-no-field,
ternary string-vs-string, call-arg class-subtype, static-receiver
unknown-identifier — all made LOWERABLE.

## Conclusion / routing

None of the remaining top classes is a 30-min byte-inert win — each needs real
resolver-plan or ToNumber infra (or selector type-resolution for the fix-(B)
reject direction). They are legitimately-sized M-L slices, best scheduled at a
fresh budget window. The meter is the prioritiser: re-run
`STRIDE=300 npx tsx scripts/ir-postclaim-meter.mts .` on the equivalence corpus
(or set `JS2WASM_IR_POSTCLAIM_LOG` during an equivalence run) to rank by real
frequency before picking the next slice.

## Files

- `scripts/ir-postclaim-meter.mts` (new) — the census script.
- `src/compiler.ts` — env-gated JSONL sink (byte-inert).
