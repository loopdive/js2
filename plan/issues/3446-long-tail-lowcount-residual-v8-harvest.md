---
id: 3446
title: "long-tail low-count residual (v8 harvest): array-too-large, float-unrepresentable, runtime max-call-stack, timeouts"
status: ready
created: 2026-07-19
priority: low
task_type: bug
area: test262-conformance
goal: standalone-mode
model: fable
sprint: current
related: [1781, 3417, 1171, 301, 2669]
---

# #3446 — long-tail low-count residual (v8 harvest, 2026-07-19)

## Summary

Catch-all for the remaining distinct sub-50 signatures from the 2026-07-19
both-lane harvest that don't warrant a dedicated issue (each tiny, several
one-off), so nothing is left uncaptured. Prior specific trackers (#301
float-unrepresentable, #1171 timeout-non-determinism) are `status: done`.

## Signatures captured

| signature | default | standalone | prior tracker |
| --- | ---: | ---: | --- |
| `requested new array is too large` (Array length edge, e.g. S15.4.2.2) | 4 | 4 | #2669 (destructuring-adjacent, ready) |
| `float unrepresentable in integer range` (numeric coercion / obj-rest setter) | — | 5 | #301 (done) |
| `Maximum call stack size exceeded` (runtime, tagged-template / generator TCO) | 3 | 2 | #1607 (done, compiler-side) |
| `timeout (Ns)` incl. strict-rerun | ~141 | ~12 | #1171 (done) — largely infra/load flake, not codegen |

## Notes / sample paths

- **array-too-large**: `built-ins/Array/length/S15.4.2.2_A2.1_T1.js` — huge
  requested array length should throw `RangeError`, not trap; a length-bounds
  guard gap.
- **float-unrepresentable**: `language/statements/for-await-of/async-gen-decl-dstr-obj-rest-to-property-with-setter.js`
  — an `f64→i32` truncation on an out-of-range value; add the range check.
- **runtime max-call-stack**: `language/expressions/tagged-template/tco-call.js`
  — proper-tail-call not applied at runtime for tagged-template calls.
- **timeout**: dominated by destructuring iterator-error tests
  (`ary-init-iter-get-err-*`). Per project memory (`pass→compile_timeout = load
  flake`), most default-lane timeouts are contended-pool nondeterminism (#1171),
  not genuine infinite loops — but the recurring `ary-init-iter-get-err` cluster
  is worth a spot-check for a real non-terminating iterator drain.

## Priority

Low — small counts, several are flake or spec-edge. Filed for completeness so the
harvest coverage audit shows zero uncaptured signatures.

## Implementation Plan (architect, 2026-07-19 — per-signature, smallest-first)

### array-too-large (4+4) — CONFIRMED repro, representation fix

Reproduced `built-ins/Array/length/S15.4.2.2_A2.1_T1.js` standalone:
`requested new array is too large` at `__module_init`. Key nuance: the
`new Array(n)` lowering ALREADY has the spec §23.1.1.1 RangeError guard
(`src/codegen/expressions/new-indexed.ts:614-652` — non-integer / <0 / ≥2^32 →
throw). The failing case is a **spec-VALID** length (`new Array(4294967295)`):
the guard passes, then `array.new_default` (new-indexed.ts:~660) **eagerly
allocates** 2^32−1 elements and the engine traps at its own GC-array limit.
Per spec this must create length=4294967295 **without allocating** (sparse).
- Fix: after the guard, branch on a threshold (e.g. len > 2^24): large lengths
  route to the sparse/holes carrier — the machinery already exists in
  `src/codegen/array-holes.ts` / `src/runtime/array-proto-sparse.ts` — storing
  `length` (vec field 0) decoupled from a small (empty) backing store. Reads
  fall through the existing hole path; a genuine element write at a huge index
  stays on the sparse sidecar.
- Test: `new Array(4294967295).length === 4294967295`; `new Array(2**32)`
  still throws RangeError. Both lanes.

### float-unrepresentable (5, standalone) — truncation-site audit

`f64 → i32` via raw `i32.trunc_f64_*` traps on out-of-range/NaN;
the codebase standard is the non-trapping `i32.trunc_sat_f64_s`
(`src/codegen/type-coercion.ts:375-466` uses sat consistently). The sample
(`for-await-of/async-gen-decl-dstr-obj-rest-to-property-with-setter.js`)
indicates one residual NON-sat truncation on the obj-rest → setter path.
- Fix: `grep -n '"i32.trunc_f64\|i64.trunc_f64' src/codegen/ src/ir/` (exact,
  non-`_sat` ops) and convert the argument/property-write sites to `trunc_sat`
  (+ range check → RangeError only where the spec demands ToUint32/ToIndex
  semantics). Audit is ~30 min; each hit is a one-op change.

### runtime max-call-stack (3+2) — tagged-template TCO
`tagged-template/tco-call.js`: proper-tail-call not applied when the tail call
is a tagged template. The TCO machinery is the `return_call`/`return_call_ref`
emission in return position (CLAUDE.md pattern); the tagged-template call path
evidently never reaches the return-position rewrite. Locate where return-position
calls get `return_call` (grep `return_call` in `src/codegen/`) and admit
`ts.isTaggedTemplateExpression` callees. LOW priority — do last, TCO edges are
regression-prone.

### timeouts (~141 default / ~12 standalone) — do NOT chase as codegen
Per memory (`feedback_regression_analysis`: pass→compile_timeout = load flake)
treat as infra noise EXCEPT the recurring `ary-init-iter-get-err-*` cluster:
spot-check ONE of those locally for a genuine non-terminating iterator drain
(bounded run with a small timeout). If it terminates locally → close as flake;
if it spins → file a dedicated issue with the trace (don't fix under this
umbrella).

### Sequencing
One PR per signature class (they touch disjoint files); array-too-large first
(confirmed repro + clear fix), then the trunc-sat audit, TCO last.
