---
id: 3885
title: "Bare compile() + buildImports silently returns wrong values for host-lane Object.* statics — invalidates any measurement taken through it"
status: ready
created: 2026-07-31
priority: high
feasibility: medium
task_type: infrastructure
area: testing
goal: es5
sprint: current
horizon: m
related: [3876, 3880]
---

# #3885 — bare `compile()` is not a valid instrument for host-lane `Object.*` statics

## Why this is filed as high priority

It does not crash, error, or return `undefined`. **It returns plausible wrong
values**, so a measurement taken through it looks like a finding. It has already
produced at least three confident wrong conclusions in a single session,
including **a defect report for a bug that does not exist** (retracted in #3876).

Most instrument failures in this project produce **false negatives** — a silent
zero, a green that means nothing, a count that hides a defect. This one produces
a **false positive**, which is the more expensive direction: a false negative
leaves you where you started, a false positive spends real implementation time,
and it arrives wearing the clothes of a finding.

## Reproduction

Bare `compile()` + `buildImports(result.imports, undefined, result.stringPool)`,
**host lane**, every case a plain spec truth:

| probe | expected | host |
| --- | ---: | ---: |
| `Object.keys({a:1,b:2}).length` | 2 | **0** |
| `const o={a:1,b:2}; Object.keys(o).length` | 2 | **0** |
| `Object.getOwnPropertyDescriptor({a:1},"a") !== undefined` | 1 | **0** |
| `const o={a:1}; Object.getOwnPropertyDescriptor(o,"a") !== undefined` | 1 | **0** |
| `const o={a:1}; gOPD(o,"a").value` | 1 | **-1** |
| `const o={a:1,b:2}; Object.getOwnPropertyNames(o).length` | 2 | **0** |
| `const o={a:1,b:2}; Object.values(o).length` | 2 | **0** |

**7/7 fail on host.** The identical probes are **correct in the standalone lane**
and **correct on host through `runTest262File`** — so this is the harness, not
the compiler.

## Scope is apparatus-dependent and NOT resolved — this is the important part

Two apparatuses disagree about which forms break:

- **This harness:** everything fails, inline *and* variable-bound receivers.
- **`dev-eslint-graph`'s bare-compile harness:** `Object.keys({a:1,b:2}).length`
  fails, but `var o={a:1,b:2}; Object.keys(o).length` **passes** — leading to a
  proposed narrower rule ("only an inline literal passed directly as an argument
  is affected; bind to a variable first").

That narrower rule **does not hold here**: `keys VAR`, `gOPD VAR`,
`getOwnPropertyNames VAR` and `values VAR` all fail. Since two bare-compile
setups disagree on scope, **any scope claim is itself unreliable**, and
"bind the literal to a variable" is not a safe workaround — it rescues one
apparatus and not the other.

**Therefore the mitigation must not be a scope rule. It must be a control.**

## Mitigation — the rule that actually works

For any `Object.*` / `Reflect.*` / prototype-reflection question:

1. Measure through **`runTest262File`**, in **both lanes**.
2. Include a **control** that must hold under any spec version — e.g.
   `Object.keys({a:1,b:2}).length === 2`.
3. **If the control fails, discard the run.** Do not read its result.
4. When reporting, state **harness, lane, and control outcome**. A measurement
   without a stated control is not evidence.

This is apparatus-independent: it does not require knowing *which* forms are
broken, only whether the instrument is working for this run.

## Wrong conclusions this harness has already produced

- **A phantom defect** — "inline object-literal argument to `gOPD` returns
  `undefined` on host" (#3876), asserted as *"a real host-lane defect, not a
  harness limitation"*, with an acceptance criterion attached. Does not
  reproduce under `runTest262File`. Retracted; the criterion is dropped.
- **"The host lane has per-route reflection bugs"** — withdrawn by its author.
- **"Same receiver-shape axis, inverted"** — withdrawn; there was no second
  defect for an axis to relate.

Note the aliasing defect in #3876 itself **survived** re-measurement under
`runTest262File` with four controls, on both lanes. The harness did not
invalidate everything — which is precisely why a blanket "distrust bare
compile" is the wrong lesson and a per-run control is the right one.

## Acceptance criteria

- Root cause identified: what `buildImports` fails to wire for host-lane
  `Object.*` statics, and why the standalone path is unaffected.
- Either bare `compile()` + `buildImports` produces correct host results for the
  7 reproduction rows above, **or** it fails loudly (throws / refuses to
  instantiate) rather than returning a plausible wrong value.
- The apparatus discrepancy is explained — why one bare-compile setup passes
  `keys VAR` and another fails it.
- A permanent test asserting the 7 rows on host, so the harness cannot silently
  regress into this state again.
- The control convention documented where probe authors will find it.
