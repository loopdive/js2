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

## ROUTING MAP for the next-window selector-precision pickup (grounded 2026-07-12)

**READ THIS FIRST when resuming the #3143 selector-precision track.** Each
remaining divergence class below is a from-ast throw the static selector
doesn't mirror; fix it EITHER by making it lowerable (option a, shrinks the
fallback bucket too — preferred) OR by selector-rejecting the shape (option b,
byte-inert, needs receiver/operand TYPE info in `select.ts` which today it
lacks — see the `TypeMap`/`resolveHostGlobal` seam in
`IrSelectionOptions`). Verify EVERY slice with IR-vs-legacy runtime parity +
byte-diff proof (legacy is the proven oracle — see `.tmp` probes' method);
a wrong claim is a HARD TRAP under IR-first, not a silent demote.

**CRITICAL corpus insight:** the DENSE post-claim divergence corpus is the
**equivalence suite**, NOT test262. test262 functions overwhelmingly reject at
the SELECTOR (`body-shape-rejected`/`external-call`), so the post-claim meter
is sparse there (the first census found only the TypedArray-store class over
154 test262 files). Point the meter at equivalence: set
`JS2WASM_IR_POSTCLAIM_LOG=<path>` during a `tests/equivalence/` run (or feed the
equivalence source corpus to `ir-postclaim-meter.mts`). That is where the
#3143 A/B measured its 50+ divergences.

| # | class (from-ast throw) | size | the work |
| - | ---------------------- | ---- | -------- |
| 1 | string wasm:js-string methods — `.charCodeAt`, `.substring` (`method call .X(...) on string not in slice 4`) | **M-L** | NOT in `STRING_METHOD_TABLE`; they lower via `wasm:js-string.substring` / `.charCodeAt` BUILTINS (i32 index args, `ref_extern` result), NOT the env `string_<method>` family the IR table + `stringMethodPlan` use. Needs a NEW resolver-plan variant that (a) targets the js-string import via **`ctx.jsStringImports.get(name)`** — the collision-safe map legacy uses on purpose (#1072: a bare `funcMap.get("substring")` resolve would be hijacked by a user function named `substring`); (b) handles funcIdx-shift (re-resolve by name post-late-import, like `resolveFunc`'s helper arm); (c) i32 arg rep (from-ast already truncates f64→i32 when `indexArgRep==="i32"`); (d) `ref_extern`→`IrType.string` result; (e) **charCodeAt's i32→f64 + out-of-range→NaN** semantics (legacy does this "inline" in `string-ops.ts` ~:2225 — match it exactly). Native mode uses `__str_substring` (already resolvable) — `substring` clamp/swap semantics verified matching JS via legacy oracle. Do `substring` first (string→string, no NaN); `charCodeAt` second. |
| 2 | string relational `<` / `>` / `<=` / `>=` (`string operator '<' not in slice 1`) | **M-L** | Legacy is mode-split: host `wasm:js-string` compare vs native `__str_compare` (`binary-ops.ts` ~:3790), WITH mixed-operand `ToNumber` (§7.2.15 string-vs-number) + NaN-incomparable handling. Faithful lowering must replicate both arms. Alternatively option (b): selector-reject when either operand's `TypeMap` type is string. |
| 3 | unary `+` coercion on non-number (`unary '+' expects number`) | **M** | `+s` is `ToNumber(s)` — a host call (host mode) / native `__str_to_number` path. Mode-dependent. Option (b) reject needs operand type. |
| 4 | element store on a TypedArray view (`element store on a TypedArray view not in IR scope`) | **defer** | Already a documented **#2856-C2 residual** (per-view ToUint8/clamp conversions stay legacy). Only class the test262 sample surfaced (`examples/native-messaging/nm_js2wasm_node_fs.ts`). Low frequency; leave last. |

Recommended order: **1-substring → 1-charCodeAt → 3-unary+ → 2-relational**
(ascending real risk; string methods are the highest-frequency class per the
#3143 diagnosis). Each is one PR, ratchet `body-shape`/post-claim via
`check:ir-fallbacks --update-on-decrease`, land green, next.

## Files

- `scripts/ir-postclaim-meter.mts` (new) — the census script.
- `src/compiler.ts` — env-gated JSONL sink (byte-inert).
