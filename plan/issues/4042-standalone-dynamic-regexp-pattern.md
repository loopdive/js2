---
id: 4042
title: "Standalone refuses a dynamic RegExp pattern — 'Unsupported dynamic regular expression pattern' plus the RegExp.prototype residual"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-mode
related: [1781, 4040, 4065]
assignee: ttraenkler/L-regexp
---

# Standalone refuses a dynamic RegExp pattern — 'Unsupported dynamic regular expression pattern' plus the RegExp.prototype residual

## Status 2026-08-02 — the CharacterEscape slice LANDED under #4065

Measured on a `--force`-refreshed standalone baseline (rows `07:26:36 →
07:37:16`, 48,619 rows, 0 bad JSON, 0 dup keys, 0 unopenable; official 43,505
run, goal scope 8,545 run — both reproducing published figures exactly).

**Funnel for this refusal string, per stage:**

| Stage | Count |
| --- | ---: |
| all-official non-pass carrying the refusal | **18** |
| goal-scope non-pass carrying it | **10** |
| of those, host=pass (reachable) | **10 / 10 (100 %)** |
| flipped by #4065 | **6 / 10** |

The issue's own caution — *"check whether the refusal is still load-bearing
before implementing anything"* — was right in spirit but the wrong way round:
the refusal **is** real (reproduced 0/10 on unmodified `main`, all 10 with
exactly this message), and what was over-broad was its **grammar**, not its
existence. `new RegExp("A"+"B")` works because that concat is
**constant-folded** by `staticConstStringValue` and never reaches the runtime
compiler at all; #4016's probe proved the *static* path, not the dynamic one.
A genuinely dynamic `\x41` was refused.

**Remaining residual (4 of the 10), each named rather than absorbed:**

- `S15.10.2.8_A3_T15` / `_T16` — 200 nested **capture groups**; needs SAVE-slot
  allocation in the runtime compiler.
- `S15.10.4.1_A8_T2` — unanchored alternation plus an empty character class.
- `annexB/.../RegExp-control-escape-russian-letter` — needs **quantifiers**
  (it constructs `\c*`), not the `\c` fallback, which is implemented.

The `~35 (area) built-ins/RegExp/prototype` line below is a **different cut**
from the 18/10 above (an area count, not a mechanism count) and is not
reconciled with it.

## Problem

**~35 goal-scope host-pass ∧ standalone-fail files** (part of #4040). Signature:

```
 10  TypeError: Unsupported dynamic regular expression pattern
 35  (area) built-ins/RegExp/prototype
```

The standalone RegExp backend handles statically-known patterns but refuses one
built at run time.

## ⚠ This is NOT the search-value refusal — that one is fixed

**#4016 landed (PR #3996, merged `68d74d66d`, +35 goal-scope flips)** and covered
`String.prototype.{search,match,split,…}` falling through to the spec's `ToString`
path. Its proof that a runtime-built pattern *can* work is directly relevant here:
a standalone probe of `new RegExp("A"+"B").exec("ssABB")` returns `["AB"]` at
index 2 — **the backend has supported runtime-string patterns since #2161**.

So "dynamic pattern" refusals may be over-broad in the same way #4016's gate was:
the compiler treating *"not a statically-known backend RegExp"* as *"needs a JS
host"*. **Check whether the refusal is still load-bearing before implementing
anything** — it may be removable, as #4016's partly was.

Related landed/known: #1474 (RegExp standalone, `done` but still cited 43× in
goal scope — see the regression note in #4040), #1539, #682 dual RegExp backend.

## ⚠ Sizing

Two cuts already measured on the adjacent cluster, **stated separately and never
summed**: the search-value refusal was ~98 all-official / 51 goal-scope by two
independent methods. Expect the same divergence here; report both.
