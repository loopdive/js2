---
id: 4227
title: "js-host: reflection over a constructed instance sees ONLY the sidecar expando — for-in/Object.keys/`in` miss every ctor field (drift since 2026-08-06)"
status: ready
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: runtime
es_edition: 5
language_feature: objects
goal: core-semantics
related: [4194, 3920, 4010]
origin: "#4194 re-measurement 2026-08-08 — the write-half slice (PR #4232) measured both lanes and found the HOST lane had drifted the opposite way; filed separately because #4194 closes with that PR and a finding inside a status:done file is invisible to dispatch"
---

# #4227 — js-host reflection over constructed instances shows the sidecar and nothing else

## Problem

On the #4194 fixture — a function-constructor instance with ctor fields
`type`/`start` plus a later dynamic `n.name = "f"` on an `any`-typed
receiver — the js-host lane answers reflection from the SIDECAR ONLY:

| surface | js-host 2026-08-06 (#4194's table) | **js-host 2026-08-08** | native |
| --- | ---: | ---: | ---: |
| `for (p in n)` bitmask (type=1, start=10, name=100) | 111 | **100** | 111 |
| `Object.keys(n).length` | 2 | **0** | 3 |
| `("type" in n)·1 + ("name" in n)·10` | 11 | **10** | 11 |
| direct reads (type/name/start) | 111 | 111 | 111 |

So the host lane DRIFTED between 2026-08-06 and 2026-08-08: it used to
enumerate the ctor fields (and miss the expando in `Object.keys`); now it
enumerates ONLY the sidecar expando (`name`) and misses every struct-backed
field on all three surfaces. Values are fine — this is purely the reflective
name surface. Standalone moved the opposite direction over the same window
(0 → struct-backed keys visible, via GitHub PRs #4219/#4229), so the two
lanes now miss COMPLEMENTARY halves — worst case for cross-lane differential
work, since host is the usual oracle lane.

## Repro

`.tmp/probe-4194b.mjs` idiom (restated in #4194's Status section): compile
the fixture with default (js-host) target, `buildImports` +
`imports.setExports`, call the six probe exports. Native oracle via
`data:` import of the same source. Measured on main @ bc78a2515.

## Suspect window

Whatever changed host-lane enumeration between 2026-08-06 and 2026-08-08 —
the #3920 chain (PRs #4219/#4229) is the obvious candidate window since it
rebuilt the enumeration name-list machinery, but that work was
standalone-directed; a host-side regression from it was never measured. Git
bisect over the fixture is cheap (~10 s per point, no acorn compile needed).

## Acceptance criteria

- [ ] The fixture answers for-in 111, `Object.keys(n).length ≥ 2` (3 with the
      expando), `in` 11 on js-host — i.e. struct-backed fields enumerate
      again, without losing the sidecar key that works today.
- [ ] Standalone answers unchanged (the #4194 unit suite stays green).
- [ ] Builtin receivers unchanged in both lanes (the #4071 rule: name lists
      never sourced from carrier internals).
