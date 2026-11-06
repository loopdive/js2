---
id: 7168
title: "Optimized exception code traps `unreachable` on Node 22: Binaryen types a try_table `(result (ref extern))`, which V8 12.4 mis-executes"
status: done
sprint: current
created: 2026-10-26
updated: 2026-10-26
completed: 2026-10-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: correctness
parent: 6979
related: [6899, 2787]
---

# #7168 — Optimized exception code traps `unreachable` on Node 22 (V8 12.4)

## Problem

On Node 22 (V8 12.4), native-first `try { throw new Error(..) } catch {}`
traps `RuntimeError: unreachable` inside `__module_init` after `optimize: true`
(wasm-opt `-O3`). It happens in every lane: gc native-first, `--target
standalone` and `--target wasi`. Without `-O3` the same programs run correctly.
Node 22 is a supported engine (`package.json` `engines`: `node >=20`; Node 20
has no `try_table` at all), so optimized output must run there.

Affected corpus programs: `control/07-try-catch`, `builtins/10-error-classes`,
`builtins/09-async-await`. Smallest reproducer:

```js
try { throw new Error("boom"); } catch (e) { console.log("caught"); }
```

Found while looking at PR #6899's diff-test with the host-assisted pin
removed. CI does not see it: CI runs Node 24/25, where these bytes run
correctly, and the optimize gate passes there on base. This does not unblock
#6899; its CI failure is the delta gate.

## Root cause

Two pieces combine:

1. **Binaryen `remove-unused-brs`** rewrites a `throw $tag X` that an
   enclosing `try_table (catch $tag $b)` in the same function catches into
   `br $b X`. When the try_table is the last child of `$b`, a later
   `remove-unused-brs` round (after `dce` removes the now-dead `br` that skipped
   the catch body) drops the branch so `X` falls through, and refinalize types
   the try_table with X's refined type: `try_table (result (ref extern))`.
   This is valid Wasm and semantically equal. Isolated in a 15-line WAT
   (`--dce --remove-unused-brs` alone reproduces it); the throw only becomes
   local after inlining (`__new_Error` returns `(ref extern)`), which is why
   `inlining-optimizing` is the first pass of `-O3` that shows it.
2. **V8 12.4 mis-decodes a `try_table` block type written with the ref prefix**
   (`0x63`/`0x64`). Codegen already avoids the shape
   ([#4620](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4620-sloppy-this-boxing-arguments-object)
   `named-this-call.ts`,
   [#5141](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5141-es2015-standalone-generators-wave1)
   `generators-native.ts`: empty try_tables, values parked in locals), but
   wasm-opt re-creates it.

Hand-built modules, one `try_table` each (from the PR #6929 review):

| block type | Node 20.20 (V8 11.3) | Node 22.22 (V8 12.4) | Node 23.11 (V8 12.9) | Node 24.22 (V8 13.6) | Node 25.9 (V8 14.1) |
| --- | --- | --- | --- | --- | --- |
| empty, `i32`, `externref`, `anyref` | CompileError (no try_table) | ok | ok | ok | ok |
| `(ref extern)`, `(ref any)` | CompileError | **unreachable** | ok | ok | ok |
| `(ref $S)`, `(ref null $S)` | CompileError | **unreachable**, or CompileError "block type index N is not a signature definition" | ok | ok | ok |
| multi-value `(i32 i64)`, `(i32 (ref $S))` | CompileError | ok | ok | ok | ok |

The bug is V8 12.4's alone. Multi-value block types are safe.

## Fix

`src/optimize.ts` + `src/optimize-try-table-shape.ts`, CLI path only:

1. After `wasm-opt -O<level>`, pre-scan the code section of the optimized
   binary. It looks for the try_table opcode `0x1f` followed by a ref
   block-type prefix `0x63`/`0x64`, then requires the following bytes to
   decode as a heap type and a catch vector:
   - the heap type is a one-byte abstract type, or a type index below the
     type-section bound
   - the catch vector has at most 64 clauses
   - each clause has kind 0–3, a tag index below imports + tags, and a label
     depth below 2^16

   A real ref-typed try_table always passes. On a miss nothing else runs and
   the bytes are unchanged. The pair-only scan of the first revision
   false-positived on `js/algorithms.ts` and on multi-MB modules.
2. On a hit, print the module (`wasm-opt out.wasm --print`) and rewrite each
   try_table whose single result is a ref type in the text. Labels are
   names, so no branch needs retargeting:

   ```
   (try_table $l? (result R) CATCHES BODY...)
   → (block $__js2_ttN (result R)
       (try_table CATCHES (br $__js2_ttN (block $l? (result R) BODY...)))
       (unreachable))
   ```

   Multi-value try_tables (printed `(type $N) (result ...)`) are left alone.
   A byte false positive with nothing to rewrite keeps the original bytes.
3. Re-assemble with no passes, but with the final StackIR stage `-O<level>`
   ends with (`--optimize-level=<level> --generate-stack-ir
   --optimize-stack-ir`). Add back custom sections the text dropped.
4. The print and re-assembly runs share the caller's remaining time budget
   when `timeoutMs` covers the whole call (as in the #6742 retry).
   - **Print or re-assembly fails or times out after a pre-scan hit:** ship
     the unoptimized input. The warning names the failed step, the cause and
     the budget that applied, and `timedOut` is set on a timeout, so the
     npm-compat ladder records a timeout. The structural scan has no known
     false positive, so a hit means the optimized bytes would trap on
     Node 22. Unoptimized costs size but is correct on every engine.

The in-process binaryen.js fallback is unchanged. binaryen.js 132 cannot read
js2wasm GC modules (`readBinary` throws), so a hook there could not be tested.

No codegen change, so unoptimized output is byte-identical in every lane.

Measured 2026-10-26 (Node 22.22.0, Binaryen 132). Sample: 17 corpus programs
(evenly spaced, including the three above) × 4 lanes, base vs. fix:

| lane | unoptimized identical | `-O3` identical | `-O3` changed |
| --- | --- | --- | --- |
| gc host-assisted | 17/17 | 17/17 | — |
| gc native-first | 17/17 | 14/17 | 07-try-catch +11 B, 10-error-classes +17 B, 09-async-await +87 B |
| standalone | 17/17 | 14/17 | +6 / +12 / +82 B |
| wasi | 17/17 | 14/17 | +6 / +12 / +74 B |

- All 9 changed binaries trapped (or failed to compile) on Node 22 before the fix.
- Without the StackIR flags on re-assembly the deltas were +28…+166 B.
  Those flags restore the StackIR stage only, not the rest of `-O3`'s
  final-stage passes.

Compile time, `website/playground/examples/dom/calendar.ts` with `optimize:
true` (no unsafe try_table, so only the byte scan runs), base and fix
interleaved 3×, median of 3 compiles each:

| lane | base | fix |
| --- | --- | --- |
| gc | 6304 / 5892 / 5213 ms | 6282 / 5962 / 5157 ms |
| standalone | 2871 / 2854 / 2755 ms | 2619 / 2616 / 2298 ms |

No measurable cost (shared box, load ≈ 6). Only modules that hit the
pre-scan pay for one print and one re-assembly.

Optimize gate (`scripts/diff-test-optimize-gate.ts`, host-assisted pin removed
locally): on Node 22 base has 3 regressions (`unreachable`) and the fix has 0
(114/120 match in both lanes). On Node 24 base already has 0. The six
non-matching programs fail the same way unoptimized:

- mismatch: `builtins/07-promise-basic`, `08-promise-chain`,
  `09-async-await`, `object/06-delete`
- runtime error: `builtins/14-spread-args`
- compile error: `generators/04-sent-values`

Pre-scan precision, measured 2026-10-26: 264 `-O3` modules (every playground
example and corpus program, gc native-first and standalone). The pair-only
scan hit 9, 3 of them false positives (`js/algorithms.ts`,
`builtins/17-regex-matchall` gc, `closures/04-shared-state` standalone). The
structural scan hits exactly the 6 true shapes: 0 false positives, 0 misses.
On a 4.4 MB js2wasm module it reports no hit, in 2.3 ms.

npm-compat standalone lanes (`generate-npm-compat-report.mjs --only
lodash-es,axios --lane standalone --no-write`), base vs fix, run once each:

| package | base | fix |
| --- | --- | --- |
| lodash-es | `-O4` on the first rung, 190.4 s, 6,788,684 → 5,436,209 B | `-O4` on the first rung, 184.5 s, 6,788,684 → 5,436,209 B (identical) |
| axios | compile-error, no optimizer run | same |

axios fails before optimization: an async generator has no host-free
lowering (#7010). This is pre-existing and unrelated.

probe/test reference: `tests/issue-7168-optimize-exceptions.test.ts`. It covers:

- the rewriter on the review's shapes module: nested try_tables, `br`/`br_if`
  to the try_table's own label, `catch_ref`/`catch_all_ref`, multi-value
  left alone, quoted names, and a data segment containing try_table text
- the pre-scan:
  - it hits a real ref-typed try_table
  - it ignores a safe one, the pair inside a data segment, and a pair whose
    next byte is no heap type
- the failure paths, with a fake `wasm-opt`:
  - a pre-scan hit whose print fails ships unoptimized with a warning; a
    false positive only costs size
  - a hit whose print times out ships unoptimized with `timedOut`
  - a confirmed shape whose re-assembly times out ships unoptimized, with
    `timedOut` set and the remaining budget in the message
- a shape assertion that works on any Node: no `try_table … (result (ref …`
  left in the `-O3` output of the 2 minimised and 3 corpus programs on gc
  native-first, standalone and wasi. Against the old `optimize.ts` it fails
  5/5.
- execution parity (`-O3` equals unoptimized), which only catches a
  regression on Node 22
