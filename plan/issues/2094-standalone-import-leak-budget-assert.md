---
id: 2094
title: "standalone import-leak budget + emit-time import-section assert (post-link scan, structured CE)"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
priority: high
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: compiler
language_feature: compiler-internals
goal: host-independence
related: [2073, 2075, 2089]
origin: "2026-06-11 analysis program (report 06 §4); stub 08-C9"
---

# #2094 — nothing scans the finished binary for leaked env imports

## Problem

Host imports leak past the strict `addImport` gate into standalone
binaries (instantiation failures #2073/#2075) via gate bypasses and stale
funcMap indices; nothing inspects the finished binary's import section.

## Root cause

`src/codegen/registry/imports.ts:34-46` gate is bypassable — its own
comment documents the stale-index hazard.

## Plan

(1) Post-link import-section scan under `--target standalone`: any
non-allowlisted `env` import → structured compile error naming the import
and the producing site. (2) Playground-corpus leak-budget test cloned from
tests/host-import-allowlist-budget.test.ts, baseline ratcheting down.
Leak counts feed the #2089 dashboard (class h).

## Acceptance criteria

- The #2073/#2075 repro classes produce CEs (or compile clean post-fix),
  never instantiation failures
- Leak-budget test in CI with committed baseline

## Dupe check

The #1888 refuse-loudly invariant covers addImport-time; emit-time
verification unfiled. New (analysis program).
