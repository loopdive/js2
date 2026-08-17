---
id: 4546
title: "Bytecode interpreter performance program: profile the ~140× gap to QuickJS-on-Wasm, then close it (dispatch is NOT the differentiator — both sides pay it)"
status: ready
sprint: Backlog
created: 2026-08-17
updated: 2026-08-17
priority: medium
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: performance
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [1584, 1852, 2860, 2928, 4236, 4404]
# id 4546 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: sole open PR was 4639
# (ci/npm-compat-refresh, artifact-only), which adds no issue file.
---

# #4546 — Interpreter performance program

The self-hosted bytecode interpreter has always had a correctness program
(**#1584 — "Wasm-GC-native bytecode interpreter with Acorn for eval and dynamic
fallback"**, **#2928 — "Bytecode interpreter core + standalone new Function /
indirect eval"**) but never a performance one, even though
**#4236 — "exploration: QuickJS JSValue as the linear lane's BOXED tier…"**
explicitly says it should exist and cite its baseline. This is that issue.

## Two baselines — different measurements, do not quote as one number

| source | scenario | ours | QuickJS-NG | ratio |
| --- | --- | ---: | ---: | ---: |
| #4236 | 100k-iteration loop, parse+execute per call, Phase-1 provider | 1857 ms | 4.7 ms | ~400× |
| #4404 | prepared execution, M4 / Node 24.4.1 | 103.92 ms | 745 µs | ~140× |

Both say "one to two orders of magnitude". They are different workloads on
different machines and must not be collapsed into a single figure.

## The finding that sets the ceiling: dispatch is a wash

The QuickJS side of the #4404 table is the **Wasm artifact**, not a native
build — `website/public/benchmarks/results/runtime-eval-engines.json` records
`artifacts.quickjs.artifactBytes = 1016254` with a pinned sha256.

That matters more than it looks. Wasm cannot express computed goto, so a
bytecode interpreter compiled to Wasm loses threaded dispatch and falls back to
a `br_table` loop — and **clang loses it too** when compiling QuickJS's
interpreter to Wasm. Both sides pay the same dispatch tax.

So the usual "an interpreter in Wasm can never match a native one" argument
does **not** apply to this comparison. Dispatch is not the differentiator, and
the measured gap is therefore attributable to things we can actually change.
Parity is a legitimate target rather than a category error.

## Suspected decomposition — REASONED, NOT MEASURED. Profile before optimising.

Ranked by expected contribution. This ordering is an argument, not data; the
first deliverable is to replace it with a profile. Boxing-versus-lookup is
exactly the kind of split that surprises people.

1. **Value representation — expected dominant.** A dynamic number on WasmGC is
   a `$box_number` struct allocation; QuickJS NaN-boxes, so a double is an
   immediate with zero allocation. In a numeric loop that is one allocation per
   arithmetic result versus none, plus the resulting GC pressure.
2. **Property access.** `$Object` is an open hash map, so a read hashes a
   string key. QuickJS uses shapes plus interned atoms: a shape check, an
   index, and key comparison by pointer identity.
3. **Interpreter code quality.** Our VM is authored in the js2wasm-compilable
   TS subset and self-compiled; QuickJS's loop is C through clang. This term
   compounds — it multiplies every opcode — and improving it is also direct
   progress on the self-hosting-dogfood goal.
4. **Dispatch overhead.** Real, but per the finding above it is *shared* with
   the comparison target, so it bounds absolute throughput without explaining
   the gap. Superinstructions and quickening reduce dispatches per unit work.

## The lane asymmetry is load-bearing

**NaN boxing is available on linear memory and impossible on WasmGC.** Packing
a pointer into a double's payload requires the pointer to be an integer; a
WasmGC reference has no integer value and cannot be bit-manipulated. So:

- **Linear backend** — can adopt the same representation QuickJS uses, which is
  why parity is plausible there.
- **WasmGC backend** — cannot. The best available is the `i31ref` small-int arm
  (slice G3 of **#1852 — "Make dynamic-value representation explicitly
  per-backend (typed refs / i31ref on WasmGC; f64-value + i32-tag on linear)"**,
  specified but not landed) plus unboxed fast paths for accumulator and
  registers inside the VM. Doubles keep allocating.

A consequence to decide deliberately, not drift into: closing the gap properly
may mean the linear lane's interpreter and the WasmGC lane's interpreter differ
in value representation, i.e. two tuned VMs rather than one.

## Why this is worth doing at all

Under **#4404 — "QuickJS bytecode to Wasm tiering: call-boundary promotion
first, same-invocation OSR second"** the interpreter is the *cold* tier and
only has to bridge to promotion — an argument for NOT investing here.

The case that overrides it: **in standalone WasmGC there is no QuickJS at
all**, so the interpreter is the only dynamic tier and anything that cannot be
AOT-compiled stays in it permanently. That ties directly to **#2860 —
"Umbrella: close the standalone-vs-js-host test262 gap (~20,500 host-free,
honest metric #2879/#2360)"**. Scope the work by that justification: optimise
what standalone actually runs, not what a tiered host would promote away.

Note also that matching QuickJS on *speed* would not weaken
[ADR-0020](../../docs/adr/0020-linear-dynamic-tier-quickjs-jsvalue.md), whose
justification is **coverage** — builtins, RegExp, `eval`, conformance — not
throughput. The two arguments are independent and should not be traded against
each other.

## Acceptance criteria

- [ ] A reproducible profile attributing the measured gap across the four
      factors above, on a fixed corpus, with raw samples and artifact
      revisions recorded — replacing this issue's reasoned ranking with data.
- [ ] A committed benchmark lane so the gap is tracked over time rather than
      re-measured ad hoc, with both the ours/QuickJS ratio and absolute times.
- [ ] Each landed optimisation reports its own before/after on that lane,
      measured by the author against a base captured before the first edit.
- [ ] A stated, evidence-backed target: parity, or a named multiple, per lane —
      linear and WasmGC separately, since their ceilings differ.
- [ ] No correctness regression: the test262 eval-dependent buckets and the
      standalone interpreter suites hold or improve.

## Non-goals

- A JIT. Tiering to AOT-compiled Wasm is #4404's scope; this issue is about the
  interpreter as an interpreter.
- Replacing the front end. Swapping Acorn for QuickJS's parser is a separate,
  independently valuable change (it addresses parse/compile cost, which is a
  different row of the table than prepared execution).
