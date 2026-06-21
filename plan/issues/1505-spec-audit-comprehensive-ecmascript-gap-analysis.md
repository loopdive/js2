---
id: 1505
title: "spec audit: comprehensive ECMAScript implementation gap analysis"
status: ready
created: 2026-05-20
updated: 2026-06-19
priority: high
feasibility: medium
reasoning_effort: max
task_type: research
area: codegen
goal: spec-completeness
sprint: Backlog
---
# #1505 - Comprehensive ECMAScript Implementation Gap Analysis

## Problem

The compiler has grown organically and while test262 coverage has improved sprint-by-sprint, there is no comprehensive systematic review of the compiler against the ECMAScript spec. Individual issues address specific failures as they surface, but there may be whole spec sections or cross-cutting concerns that are systematically mis-implemented or missing.

This issue asks an architect to do a top-down review: read the ECMAScript spec sections that are relevant to a TypeScript-to-WasmGC AOT compiler, compare against the current implementation, and surface the biggest gaps that are NOT already tracked.

## What we already know is broken

Currently tracked (do NOT re-surface these unless there's a new angle):
- #1460 Object.defineProperty descriptor fidelity
- #1466 Proxy/Reflect trap fidelity
- #1439-1445 String/RegExp prototype method gaps
- #1450-1456 Class/destructuring/for-loop semantics
- #1461-1468 Array, Object, Function, Iterator, Promise gaps
- #1470-1504 Host-independence, WASI, Node.js, browser support

## Scope for this audit

Focus on spec areas most likely to have **silent correctness gaps** (wrong output, not compiler crash):

### §6-§9 Language basics
- Abstract operations: ToObject, ToPrimitive, ToPropertyKey, ToString, ToNumber, ToInt32, ToUint32 — are all paths covered including edge cases (Symbol keys, -0, ±Infinity, NaN, BigInt)?
- Property descriptors: OrdinaryGetOwnProperty, OrdinaryDefineOwnProperty, OrdinaryGet, OrdinarySet — is the full algorithm implemented or just the fast path?
- Prototype chain: [[GetPrototypeOf]], [[SetPrototypeOf]], HasProperty — are inherited property lookups correct?

### §10-§15 Core language
- Function objects: [[Call]], [[Construct]], length, name, arguments, caller property semantics
- Scope: var hoisting, let/const TDZ, catch binding, eval scope (skip eval, it's wont-fix)
- Generator: GeneratorStart, GeneratorResume, GeneratorYield — especially .return() and .throw() paths
- Async: PromiseCapability, PerformPromiseThen, async function resume after await
- Class: static initialization blocks, private brand checks, [[HomeObject]] super calls

### §19-§28 Built-ins
- Array: negative indices, holes (sparse arrays), species constructor, Array.from on iterables
- Object: Object.assign, Object.keys/values/entries ordering, Object.freeze/seal
- String: Unicode surrogate pair handling, RegExp-delegating methods
- Number: Number.isFinite/isNaN vs global isFinite/isNaN, toPrecision/toFixed edge cases
- Symbol: well-known symbols actually wired to correct spec operations
- Error: stack property, cause option, AggregateError iterations property
- WeakRef/FinalizationRegistry: can we stub these properly?
- Atomics/SharedArrayBuffer: out of scope — wont-fix

### Cross-cutting concerns
- **toString/valueOf interplay**: when does `[Symbol.toPrimitive]` take priority?
- **Realm isolation**: all built-ins use the right realm's %Array.prototype% etc
- **[[Species]]**: Array, Promise, RegExp — is species lookup implemented?
- **Numeric separators, optional chaining edge cases**: any AOT surprises?

## Acceptance criteria

1. Architect produces a **ranked list of gaps** not already in the issue tracker, with:
   - Spec section reference
   - Current behavior vs spec behavior
   - Estimated test262 impact (number of failing tests)
   - Implementation difficulty (low/medium/hard)
2. Top 10 gaps each get a stub issue filed at `plan/issues/sprints/52/NNNN-*.md`
3. The analysis document is written to `plan/agent-context/spec-audit-1505.md`

## Notes

- Do NOT run test262 locally — use the existing failure data in `benchmarks/results/test262-current.jsonl` and `benchmarks/results/test262-report.json`
- Cross-reference against existing issues in `plan/issues/sprints/52/` to avoid duplicates
- Prioritize by test262 impact × implementation feasibility

## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).
