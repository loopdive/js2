---
id: 4382
title: "Compiler-derived capability manifest and per-program explain workflow"
status: backlog
sprint: Backlog
created: 2026-08-12
updated: 2026-08-20
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: compiler, cli, docs
language_feature: compiler-capabilities
es_edition: multi
goal: developer-experience
depends_on: [3526, 3678]
related: [1590, 2135, 2634, 3518, 3519, 3681, 4567]
origin: "2026-08-12 compiler architecture and user-trust review"
---
# #4382 — Compiler-derived capability manifest and per-program explain workflow

## Objective

Make every compilation answer two questions from the compiler's actual plan:

1. What execution substrate does this program require for the selected target?
2. Why did each relevant source feature receive that classification?

The public result uses a small, stable vocabulary:

- `host-free-wasm` — the selected program can execute without host-provided
  JavaScript capabilities.
- `declared-host-capability` — compilation succeeds with an explicit, minimal
  set of typed host capabilities.
- `runtime-provider` — compilation requires a named in-repository runtime
  provider, including the runtime-evaluation provider when applicable.
- `unsupported` — the requested target cannot compile the construct and emits
  a stable source-located diagnostic.
- `unknown` — the compiler has not projected an internal decision into the
  public schema. Unknown is visible and fails any completeness claim.

These statuses describe placement and capability requirements. They are not
claims of ECMAScript conformance or semantic correctness.

## Problem

The compiler already knows much of this information, but it is distributed
among selector predicates, IR preparation, runtime-feature planning, import
collection, target legality, fallback telemetry, and documentation tables.
That fragmentation creates three trust problems:

- a successful build does not provide one deterministic explanation of the
  selected execution path, providers, and host requirements;
- website and release capability tables can drift from production compiler
  decisions;
- an absent entry is ambiguous between unsupported, unmeasured, unprojected,
  and accidentally omitted.

## Architecture

### One compiler-owned decision record

Consume the capability predicates from #2135 and the frozen
`IntrinsicId -> RuntimeFeature -> HostCapability` contract from #3526. Do not
create another hand-maintained support table. For each relevant source site,
record:

- stable feature and decision IDs;
- selected target/backend and public status;
- source range and stable diagnostic code from #3678 when rejected;
- required runtime providers and host capabilities;
- concise explanation and actionable hint where one exists;
- provenance identifying the selector, verifier, provider, or legality rule
  that made the decision.

The report is deterministic, versioned, serializable, and embedded in or
adjacent to the compile result. Backend emission may consume this frozen plan;
it may not revise the public classification after artifacts have started.

### Node API projection

Project Node builtin decisions from “Make `node:*` builtin support
member-explicit, provider-explicit, and fail-closed” (#4567); do not infer them
from the broad recognized-module list or emitted import-name patterns. For each
used `node:*` member, report:

- canonical module and real export name;
- source import form and location;
- selected typed interface plus runtime provider, if any;
- target-lane result and transitive host/WASI capabilities;
- unsupported or unknown reason with the stable diagnostic and remediation.

Namespace/default imports and dynamic member reads must retain unresolved
members as visible `unknown` rows. A report cannot claim a whole module is
supported merely because one export has a provider.

### Repository-wide projections

Generate machine-readable release and website artifacts from the same registry.
Every documented row must be one of the explicit statuses above and link to
measured evidence where available. A detector miss or missing projection is
`unknown`, never an implicit success. Generated artifacts include schema,
compiler version, target, denominator, and provenance so comparisons across
releases remain meaningful.

### Per-program CLI workflow

Expose the shared analysis through a coherent command surface:

```text
js2wasm build app.ts --target standalone
js2wasm run app.ts --target standalone
js2wasm explain app.ts --target standalone
js2wasm explain app.ts --target standalone --json
```

`build`, `run`, and `explain` must consume the same frozen decision record.
`run` may orchestrate an existing supported runtime, but it must not silently
change the target, add a JavaScript engine, or select capabilities different
from `build`. Preserve the current positional invocation during migration and
document its replacement rather than breaking existing automation abruptly.

## Landing sequence

1. Define the versioned decision/report schema and compiler API after #3526's
   manifest boundary is available.
2. Project stable diagnostics from #3678 and add deterministic text/JSON
   `explain` output.
3. Make release artifacts, documentation, and website capability tables
   generated consumers with staleness checks.
4. Add `build` and `run` subcommands as thin consumers of the same analysis and
   compilation pipeline; retain compatibility aliases for the current CLI.

## Acceptance criteria

- [ ] One versioned compiler-owned schema represents target, backend, source
      decisions, providers, host capabilities, diagnostics, and provenance.
- [ ] The report is derived from #2135/#3526 production decisions; no parallel
      support matrix or emitted-import name heuristic becomes authoritative.
- [ ] Every used `node:*` member projects the module, member, import form,
      provider, target availability, transitive capabilities, and precise
      unsupported/unknown reason from “Make `node:*` builtin support
      member-explicit, provider-explicit, and fail-closed” (#4567).
- [ ] Focused fixtures cover host-free Wasm, declared host capability,
      runtime-evaluation provider, unsupported source, and deliberately
      unprojected/unknown source for every supported target mode.
- [ ] `js2wasm explain` has stable human-readable and JSON output with source
      locations, codes, reasons, providers, capabilities, and rewrite hints.
- [ ] Repeated builds and reordered internal maps produce byte-identical JSON;
      schema or semantic changes require an explicit version change.
- [ ] `build`, `run`, and `explain` agree on the selected target and capability
      set. `run` cannot add a hidden engine/provider or choose another lane.
- [ ] Website/docs/release tables are generated from the compiler artifact and
      fail a staleness check when production decisions change.
- [ ] Summary counts always state denominators and expose `unknown`; statement
      or feature detection is never described as proof of correctness or
      conformance.
- [ ] Existing Test262, differential, standalone, import-leak, and artifact
      validity gates remain authoritative for semantic and target correctness.

## Out of scope

- Narrowing the supported language to make the report look complete.
- Adding a general embedded JavaScript engine as an implicit fallback.
- Treating source-feature occurrence, statement coverage, or successful
  compilation as a conformance claim.
- Copying dynamic JavaScript values across a new boundary solely for reporting
  or CLI convenience.
