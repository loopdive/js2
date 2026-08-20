---
id: 4572
title: "Implement a portable Node utility provider tranche"
status: backlog
created: 2026-08-20
updated: 2026-08-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime, linker, testing
language_feature: node-utility-modules
goal: npm-library-support
sprint: Backlog
depends_on: [4567]
horizon: l
es_edition: n/a
related: [1575, 1792, 1793, 3681]
origin: "2026-08-20 Node API compatibility and portability review"
---
# #4572 — Implement a portable Node utility provider tranche

## Objective

Provide the highest-demand deterministic Node utility APIs as portable,
link-on-use modules rather than opaque host objects. Start with
`node:assert`, `node:assert/strict`, `node:querystring`,
`node:string_decoder`, and a measured pure-computation subset of `node:util`.

## Scope selection

Before implementation, measure a pinned npm/package corpus and record:

- corpus revision and total package/file denominators;
- imports and observed member call sites per module;
- static versus dynamic member access;
- required language/runtime dependencies;
- whether each member is portable computation, scheduler-dependent, host
  capability-dependent, unsupported, or unknown.

The measured table selects the `node:util` members. It does not turn an
unobserved export into either “supported” or “unneeded.” Initial candidates
include `format`, `formatWithOptions`, `inspect`, `types` predicates, and
`promisify`; scheduler-dependent members must remain gated on the async runtime.

## Provider shape

- Each standard Node module remains a separate import/provider boundary.
- Only used members are linked.
- Shared byte/text codecs may be reused by Buffer, URL, and
  `node:string_decoder`, but the public API retains Node names and behavior.
- Export coverage is explicit in “Make `node:*` builtin support member-explicit,
  provider-explicit, and fail-closed” (#4567); module-object imports do not imply
  that every export works.

## Acceptance criteria

- [ ] Commit a reproducible usage artifact with corpus revision, per-module
      denominators, member counts, dynamic-access rows, and unknowns.
- [ ] Implement the selected `node:assert`/`node:assert/strict` assertions,
      querystring parse/stringify/escape operations, and incremental
      `StringDecoder.write`/`end` behavior.
- [ ] Select and implement the bounded `node:util` subset from measured demand;
      non-selected members receive explicit unsupported/unknown results.
- [ ] Differential fixtures cover values, coercion and error ordering, malformed
      encodings, split multibyte sequences, circular formatting inputs, and
      async callback behavior where selected.
- [ ] Results report per-member and per-target denominators and include positive
      controls for the JS-host, standalone/WASI, and linear lanes that claim
      support.
- [ ] Link tests prove that importing one module/member does not pull unrelated
      utility providers into the artifact.
- [ ] If the measured implementation exceeds one sprint, this issue records a
      dependency-ordered set of per-module child issues before code lands.

## Out of scope

- Claiming support for every export of `node:util`.
- Streams, readline, networking, diagnostics channels, or worker APIs.
- Host-object passthrough as a portable implementation.
