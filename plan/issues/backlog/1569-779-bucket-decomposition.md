---
id: 1569
title: "#779 bucket decomposition — 2026-05-21"
parent: 779
status: analysis
created: 2026-05-21
baseline: "benchmarks/results/test262-current.jsonl (21.5.2026 00:24)"
---

# #779 Bucket Decomposition — 2026-05-21

Baseline: `test262-current.jsonl` 21.5.2026 00:24. Filtering `scope_official=true, status=fail, error_category=assertion_fail`.

Total `assertion_fail`: **8,844**.

## Top path-prefix concentrations (4-deep)

| Path | Count | Routed to |
|------|-------|-----------|
| `language/statements/class/dstr` | 372 | #1543/#1551/#1553 — see B2 |
| `language/statements/class/elements` | 362 | #1456 — see B3 |
| `language/expressions/class/dstr` | 355 | see B2 |
| `language/expressions/class/elements` | 317 | see B3 |
| `language/statements/for-of/dstr` | 252 | #1396/#1454/#1468 |
| `language/expressions/assignment/dstr` | 138 | #1431 (in-review) |
| `language/expressions/object/dstr` | 132 | residual after #1450/#1451 |
| `annexB/language/eval-code/direct` | 104 | #1518 (in-review) |
| `built-ins/Array/prototype/{filter,every,some,forEach,map,reduceRight,...}` | 948 | #1461 — see B1 |
| `language/expressions/async-generator/dstr` | 88 | #1543 residual |
| `built-ins/String/prototype/split` | 78 | **NEW B5** |

## Cluster table (root-cause groupings)

| # | Cluster | Count | Sample error | Likely source location | Sub-issue |
|---|---------|-------|--------------|------------------------|-----------|
| B1 | `Array.prototype.*` array-like receiver assertion mismatch | 948 | `assert.sameValue(arguments.length, N); assert.sameValue(arguments[K], ...)` | `src/codegen/builtins/array.ts` — callbacks invoked with wrong `arguments` shape on array-like (non-Array) receivers | **#1461** (already filed, in-review) |
| B2 | `class/dstr` method/gen/async-gen/private dstr — residual after #1543/#1544 | 727 | `returned 2 — assert #1` various | `src/codegen/literals.ts` binding-element + class-method tramp builder; per name-prefix breakdown shows `gen-meth` (158), `async-gen` (125), `private-meth` (102), `private-gen` (86), `async-private` (86), `meth-static` (85) | **NEW: #779a** — class-method-dstr unified residual (also covers method tramps for gen/private) |
| B3 | `class/elements` "multiple definitions" / "after-same-line" / "new-sc-line" — class-body parser-loss | 679 | `verifyProperty(C.prototype, "m", { enumerable: false, configurable: true, ... })` | Class-element parser path drops/reorders consecutive definitions; `src/codegen/index.ts` class-body emission. Names `after-same-line` (90), `multiple-stacked-definitions` (79), `multiple-definitions-rs` (54), `new-sc-line` (46), `wrapped-in-sc` (22) all point to **same-line / semicolon-handling** in class body | **NEW: #779b** — class-body multi-definition same-line parsing |
| B4 | `Object.defineProperty` + `defineProperties` descriptor fidelity residuals | 847 | `verifyProperty(...)` fails — descriptor flags wrong | `src/codegen/builtins/object.ts` defineProperty/defineProperties; descriptor `enumerable`/`configurable`/`writable` default propagation | **#1460** (already filed, in-review) |
| B5 | `String.prototype.split` constructor identity | 78 | `assert.sameValue(__split.constructor, Array, ...)` | `split` returns an array whose `.constructor` is not `Array` — array prototype chain not wired for builtin-returned arrays | **NEW: #779c** — split result `.constructor === Array` |
| B6 | `for-of/dstr` array-elem/obj-prop/array-rest/obj-rest residuals | 252 | various | already routed to #1396/#1454/#1468 | (existing) |
| B7 | `language/expressions/object/dstr` (non-method) residuals | 132 | dstr default-init / rest semantics in plain object literals | `src/codegen/expressions/destructuring.ts` | **NEW: #779d** — object-literal dstr (non-method) residuals |
| B8 | `annexB/language/eval-code/direct` (128) — `verifyProperty` annex-B var-hoisting through eval | 128 | annex-B var bindings should mirror to global, descriptor flags differ | `src/codegen/eval.ts` annex-B hoisting | **#1518** (already filed) |
| B9 | `arguments-object` mapped-arguments residuals | 161 | argument sync mismatch | `src/codegen/expressions/arguments.ts` | post-#849; **NEW: #779e** as small residual sub-issue |
| B10 | `language/statements/for/dstr` (60) | 60 | C-style for-loop destructuring init | dstr-binding helper plumbing in for-init | covered by #1553 (in-progress) |
| B11 | `built-ins/RegExp` host-wrapper / protocol residuals | ~167 | various | runtime host wrappers / RegExp built-ins | **#1002** (already filed) |

## Recommended sub-issues (priority order)

| Priority | Sub-issue | Title | Est. FAIL reduction | File(s) to fix |
|----------|-----------|-------|---------------------|----------------|
| 1 | **#779b** | `class/elements` same-line / semicolon multi-definition parsing | ~290 (after-same-line + multiple-stacked + multiple-definitions-rs + new-sc-line + wrapped-in-sc) | class-body parser / `src/codegen/index.ts` class-element pipeline |
| 2 | **#779a** | `class/dstr` method-tramp residual (gen / async-gen / private / static) | ~600 (727 total minus the ~127 already in async-gen plain-meth handled by #1543) | `src/codegen/literals.ts` binding-element + tramp builder for `__obj_meth_tramp_*` |
| 3 | **#779c** | `String.prototype.split` result `.constructor` not `Array` | ~78 | `src/codegen/builtins/string.ts` (split returns proto-chain-broken array) — likely a single one-line fix |
| 4 | **#779d** | Object-literal dstr (non-method, non-class) default/rest residuals | ~132 | `src/codegen/expressions/destructuring.ts` |
| 5 | **#779e** | `arguments` object mapped/length sync residual after #849 | ~60 (subset of 161 that aren't covered by trailing-comma / strict-mapping path) | `src/codegen/expressions/arguments.ts` |
| 6 | (verify) | `built-ins/Array/prototype/sort` residual (#1461 didn't include sort) | ~25 | `src/codegen/builtins/array.ts` sort |

**Total addressable via new sub-issues: ~1,185 fails** (~13% of the 8,844 umbrella).

## Notes on the long tail

- After #1461 lands, the **948-strong Array.prototype.* cluster** should
  collapse drastically — the assertion patterns all share `arguments[K]`
  shape mismatch.
- The **class/elements 679 cluster** is the single largest **unrouted** sub-bucket
  and is high-priority: 5+ name-prefix groups (`after-same-line`,
  `multiple-stacked-definitions`, `multiple-definitions-rs`, `new-sc-line`,
  `wrapped-in-sc`) all suggest a single class-body parsing/lowering bug
  where consecutive class members on the same line or separated by `;`
  are silently dropped or re-ordered. Worth ≥290 fails for a likely
  **single-file fix**.
- `language/statements/for/dstr` (60) and remaining `for-of/dstr` (252) are
  already routed to #1553 / #1396 / #1454 / #1468.

## Action

File the four new sub-issues (#779a–#779e in priority order) and let
PO triage. The class-elements bug (#779b) is the highest-value single
fix in the entire #779 umbrella.
