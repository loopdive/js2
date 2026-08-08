---
id: 4226
title: "Compile-time evaluation levers for the dynamic-property / eval residue: per-shape specialization of generic copy loops, finite key-set resolution, Tier-0 splice widening inside the static-certainty table"
status: backlog
sprint: Backlog
created: 2026-08-08
updated: 2026-08-08
priority: low
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: codegen
language_feature: eval
goal: runtime-eval
related: [1163, 1769, 2552, 2923, 2928, 2929, 3927, 4042, 4071, 4098, 4194]
# id 4226 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-08 (gh CLI unavailable in the authoring sandbox, so the built-in
# open-PR scan degraded). The equivalent scan was performed manually through
# the GitHub MCP: the only open PR at reservation time was #4231
# (branch issue-4225-cold-tail-fold-follow-up), which adds no new issue id.
---

# #4226 — Compile-time evaluation levers for the dynamic-property / eval residue

## Framing

The #4194 instance-expando substrate makes dynamic property writes **sound** in
standalone mode: statically invisible writes land in an identity-keyed side bag
(slow path), while #3927's shape analysis promotes statically provable writes
to real struct fields (fast path). This issue tracks the third tool in that
family: **compile-time evaluation** — partially evaluating code whose inputs
are provably static so the bag is never needed at all.

The compiler already does this twice, which is the proof of concept:

- **Tier 0 eval splicing (#1163/#2923/#1102)** *is* compile-time evaluation of
  `eval` — the first Futamura projection done by hand. It covers ~92 % of
  test262 eval call-sites and never touches acorn, the interpreter, or the
  expando substrate.
- **#3927's receiver-flow pass** *is* abstract interpretation of member
  writes — it grew a struct field for acorn's literal `n.name = f` write
  before any bag existed.

The residue that neither covers today falls into three candidate levers.

## L1 — per-shape specialization of generic copy loops (provider unit)

The motivating shape is acorn's `copyNode`:

```js
for (var prop in node) { newNode[prop] = node[prop]; }
```

After #4194 this is *correct* via the bag, but every copied expando pays the
bag's O(n) list walk, and every copied declared field pays the `__extern_set`
name-ladder dispatch. A partial evaluator that knows the closed set of `Node`
shapes could specialize this loop per shape into straight-line
`struct.get`/`struct.set` pairs — no dispatch, no bag.

**Why the provider unit is the right first target:** the runtime-eval provider
(`build-runtime-eval-provider.mjs`) is compiled as a **sealed whole program**.
Its `Node` structs never escape to user code — interpreted programs see
`JSValue`s, not provider-internal structs (#2928's carrier ABI). So the
closed-world premise that is generally unprovable *is* provable there, modulo
one check: no acorn plugin registration and no reflective write into `Node`
from inside the provider itself. That check is a whole-unit escape analysis
over one fixed source bundle, not a general program analysis.

**Soundness condition (load-bearing):** the specialization is only valid where
the key universe of the enumerated object is closed. The analysis must degrade
to the bag path — never to dropping keys — whenever closure cannot be proven.
A specialized copy that misses one runtime-added key silently reintroduces the
exact blank-node defect #4194 just fixed, with much harder attribution.

## L2 — finite key-set resolution for computed writes

`obj[k] = v` where `k`'s value set is finite and statically enumerable (const
strings, literal unions, keys of a closed for-in per L1) can lower to the same
per-name arms `__extern_set` already builds, or directly to `struct.set` when
receiver shape + key are both resolved. This is a value-set analysis on string
locals — bounded scope, no general string abstraction: bail on anything except
provably-finite sets. Overlap warning: #3927 owns the receiver-shape half;
this lever only adds the key half and must feed #3927's existing machinery
rather than grow a parallel one.

## L3 — Tier-0 splice widening, strictly inside the static-certainty table

The 24 annexB `skip-early-err` files had **literal** eval sources yet routed to
the runtime lane, because the splicer refuses Annex-B function-in-block shapes.
Some of today's other splice-bails may be similarly widenable. The governing
rule is the decision table in #2929's EvalDeclarationInstantiation spec (§3):
**emit-throw / splice when the outcome is statically certain; bail to the
provider when it depends on runtime environment state; never splice-and-ignore.**

⚠ **The −1180 fence stands.** Reconstructing B.3.3 binding semantics in AOT
code was tried (#1769) and reverted at −1180 (#2552). Runtime-state-dependent
semantics (global extensibility, live descriptor state, B.3.3
cancellation-vs-update against runtime scopes) stay routed — #2929's C+D slice
deliberately moved cases *out* of the splice for this reason, and that
direction is correct. L3 is only for shapes where a proof of static certainty
exists; every widening PR must name its proof and carry the declare-arguments
matrix + issue-2923 canaries as controls.

## Non-goals

- Replacing the bag. It is the soundness floor; all three levers are
  optimizations that shrink its traffic.
- General string/value abstract domains, speculative shape guards with deopt,
  or a JIT. AOT proofs only.
- Widening `Object.keys` semantics anywhere (#4071's −5 stands).
- Anything host-lane: all levers are standalone/wasi codegen.

## Acceptance criteria

- [ ] L1: `copyNode`-shaped loops in the provider unit compile to specialized
      copies; provider parse canaries (#4194 §e2) and the annexB eval-code
      population show **zero verdict changes**; measured provider runtime
      improvement on a parse-heavy eval workload (name the benchmark in the
      PR; the #2928 30 s per-test budget is the ceiling that matters).
- [ ] L1 soundness: a probe adding a runtime expando to a Node inside the
      provider (plugin-style) either fails the closure proof at compile time
      (specialization skipped, bag used) or round-trips correctly. No key ever
      dropped.
- [ ] L2: a fixed corpus of finite-key computed writes lowers without
      `__extern_set` dispatch (inspect WAT); infinite/unknown key sets
      provably untouched.
- [ ] L3: each widened shape lands as its own PR with its certainty proof and
      the named controls green; no runtime-state-dependent shape widened.
- [ ] Host lane byte-identical throughout (equivalence suite).

## Sequencing

After #4194 merges (the bag must exist as the fallback these levers degrade
to). L1 first (biggest measured win, cleanest closure proof), L2 second
(feeds #3927), L3 opportunistic per-shape. Each lever is independently
landable; none blocks conformance work — this is a performance/architecture
issue, not a test-flip issue, and should be prioritized accordingly.
