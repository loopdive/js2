---
id: 4002
title: "Two quality gates false-fail locally because their default base is the FORK's diverged main — agents may 'fix' another agent's file to silence them"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
related: []
---

# Two quality gates false-fail locally because their default base is the FORK's diverged main — agents may 'fix' another agent's file to silence them

## Problem

In this checkout `origin` is the **fork** (`ttraenkler/js2`), whose `main` diverges
from `loopdive/js2`. Two `quality` gates default their comparison base to it and
therefore **false-fail locally on files the current branch never touched**:

| gate | phantom failure | correct invocation |
| --- | --- | --- |
| `check:issue-ids:against-main` | reported **6 id collisions** (#3973/#3974/#3977/#3980/#3982/#3983) | `GATE_BASE=upstream/main` |
| `check:oracle-ratchet` | reported net checker growth in `array-length-define.ts` and `unresolvable-assign.ts` — **two other agents' files** | `LOC_GATE_BASE=$(git merge-base upstream/main HEAD)` |

With the correct base, `check:oracle-ratchet` sees only the **2** src files the
branch actually changed.

## Why this is worse than noise

**An agent sees a gate blaming a file and "fixes" someone else's file to silence
it** — shipping a change nobody asked for, in a file it does not own, to satisfy a
gate that was never really failing. That is the real cost, and it is silent.

Three aggravating factors:

1. **The two gates need DIFFERENT env knobs** (`GATE_BASE` vs `LOC_GATE_BASE`),
   so learning one does not save you on the other.
2. **It passes in CI**, where `origin` *is* upstream — so it is invisible to
   anyone who does not work locally, and cannot be caught by a CI check.
3. It compounds the pre-existing fork/upstream id-collision problem: the 6
   "collisions" it reports are real divergence, but not this branch's fault, so
   the signal is neither cleanly true nor cleanly false.

## Fix options

- (a) Default both gates to `upstream/main` when `origin` is not the upstream
      repo — detect via `git remote get-url`, do not hardcode.
- (b) Unify on ONE env var name across every base-comparing gate.
- (c) Make each gate **print the base it used** on every run. This is the cheapest
      and independently worth doing: "print the provenance" turns a silent wrong
      answer into an obvious one.

Reported by `L-evalink` 2026-08-01 after it cost multiple CI cycles.
