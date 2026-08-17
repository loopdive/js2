---
id: 4547
title: "Swap the eval front end: QuickJS compile-only parse/bytecode in place of Acorn, translated to our register ISA (targets the ~79× parse/compile row, not execution)"
status: ready
sprint: Backlog
created: 2026-08-17
updated: 2026-08-17
priority: medium
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
task_type: performance
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [1584, 2928, 3756, 4404, 4546]
# id 4547 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: sole open PR was 4639
# (ci/npm-compat-refresh, artifact-only), which adds no issue file.
---

# #4547 — Swap the eval front end to QuickJS's parser/compiler

## The row this targets

From #4404's baseline (M4 / Node 24.4.1), parse+compile per call:

| ours (Acorn + our compiler) | QuickJS-NG | ratio |
| ---: | ---: | ---: |
| 93.64 ms | 1.19 ms | ~79× |

**Be precise about what this does and does not fix.** It addresses the
parse/compile row only. Prepared execution — 103.92 ms vs 745 µs, ~140× — is
untouched by this change and is #4546's scope. A reader who conflates the two
will expect an end-to-end win this cannot deliver.

The parse cost is real beyond eval, though: see **#3756 — "acorn parse
superlinear scaling"**.

## Scope

Use QuickJS-NG's **compile-only** evaluation mode as the eval front end, and
translate its bytecode into our register+accumulator ISA (ADR-0019), keeping
our VM and our runtime. This is deliberately the smallest high-value slice of
the larger idea: front end swapped, execution tier unchanged.

- The engine exposes no ESTree-style parse result; its usable boundary is the
  compiled function/bytecode object. #4404's Phase 0 already specifies the
  `qjs_compile` / `qjs_free_compiled` shim work and should be shared, not
  duplicated.
- Stack-based bytecode → register+accumulator is a known, mechanical
  transformation over a bounded opcode set.
- A **parse+compile-only build** of the engine is the size question: dropping
  the interpreter, builtins and RegExp engine should be far smaller than the
  ~1 MB full artifact. The feature-subset build machinery from #4236 exists;
  this must be measured, not assumed, because the WasmGC lane carries no engine
  today and this would be new weight.

## Risks to design against

- **The bytecode format is an unstable internal.** Same discipline as #4541's
  ABI stamp, with a larger surface: pin, version, stamp, fail loudly. #4404
  states the rule — every cache entry and translator result records the exact
  engine revision and bytecode-metadata ABI version.
- **We inherit its semantic model** — scope handling, TDZ, var hoisting,
  closure capture via var_refs. Mostly a benefit (spec-correct and
  battle-tested), but a real integration cost wherever ours differs.
- **Two front ends** (Acorn-based and engine-based) is a maintenance question,
  not a steady state. Decide up front whether this converges on one.

## Acceptance criteria

- [ ] Dynamic source compiles through the engine's compile-only mode and
      executes on our VM, with the parse/compile row re-measured on the same
      corpus and container as the baseline.
- [ ] Syntax errors, directives, strictness, closures and eval declaration
      behaviour match the existing path — asserted, not assumed.
- [ ] The parse+compile-only artifact size is measured and reported against the
      full artifact and against Acorn-compiled-by-us, per lane.
- [ ] Bytecode-ABI version is stamped and checked; a mismatch fails loudly.
- [ ] No regression in the test262 eval-dependent buckets.

## Non-goals

- Execution speed (#4546) and AOT tiering (#4404, #4548).
- Replacing the runtime. Values stay ours; this changes only what produces the
  bytecode.
