---
id: 3983
title: Descriptor attributes are not consulted on the ordinary write path (standalone)
status: in-progress
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
assignee: ttraenkler/sendev-descwrite
goal: standalone-gap
created: 2026-08-01
---

# Descriptor attributes are not consulted on the ordinary write path

## Problem

In the standalone (no-JS-host) lane, property descriptor attributes **are** stored and
reflected correctly by `Object.getOwnPropertyDescriptor`, and **configurability is**
enforced when a property is redefined via `Object.defineProperty`. But the attributes are
**not consulted on the ordinary write path** (`obj.p = v`, `obj.p op= v`):

- writing to a `writable: false` data property does not throw in strict mode;
- writing to an accessor with no setter (`{ get, set: undefined }`) does not throw in
  strict mode;
- in **sloppy** mode, writing to a `writable: false` property traps with a raw
  `WebAssembly.Exception` rather than being silently ignored — this is **not** a catchable
  `TypeError` and can take out files that never asserted anything about descriptors, so its
  blast radius exceeds the gated family below.

## Gated population (measured, not forecast)

Derived deterministically from `.test262-cache/test262-standalone-current.jsonl`
(instrument check: 43,106 official rows / 25,460 pass / 59.1%):

- ES5-tagged + untagged goal scope: 8,545 run / 6,004 pass / 2,541 fail (70.3%)
- `Expected a TypeError to be thrown but no exception was thrown` signature: **158**
- descriptor-enforcement family within that signature: **117** files, of which **48 live
  outside `built-ins/Object/`** (an area-scoped census under-counts by 40%).

117 is a **gate**, not a flip forecast. Flip ratio to be measured by paired A/B.

## Boundaries

- Array `length` routing gap (`maybeEmitVecLengthDefine` / `compileObjectDefineProperties`)
  is owned by `g-arraylen` — out of scope here.
- #3661 (wrongly-TRUE attributes) is owned by `ttraenkler/dev-es5-descriptors`; its
  standalone-scope population (11 files) is **disjoint** from this one.

## Investigation log

(in progress)
