---
id: 5161
title: "nativeStrings and fast host configs throw on new Error(msg, {cause}) — opaque-struct ToPrimitive at the constructor boundary"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: low
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [5159, 3481]
---

# Two host configs still throw where the default host now succeeds

Measured during #5159 (PR #5169) via file-copy A/B — **pre-existing**,
identical before and after that fix:

| host config | `new Error("m", {cause: c})` |
| --- | --- |
| default | works (fixed by #5169: `e.cause === c`) |
| `nativeStrings` | **TypeError: Cannot convert object to primitive value** |
| `fast` | **TypeError: Cannot convert object to primitive value** |

Same defect class as #3481 cause-2 (fixed for the default host in PR #5161's
`_errorMessageToString`): a WasmGC struct crosses the host boundary opaquely
and V8's own coercion cannot introspect it. In these two configs the throw
happens before #5159's `__error_install_cause` companion can run, so the whole
construction fails rather than merely dropping `cause`.

Start by measuring WHICH boundary throws in each config (the ctor's message
slot, the options slot, or the companion import) — the two configs may differ.
The #3481 cause-2 record (`plan/issues/3481-bigint-symbol-coercion-value-rep.md`)
and the #5159 resolution record document the walker rules
(`_hostToPrimitive` "found nothing" sentinels, the refused-NUMBER rule) any fix
must not violate.

## Acceptance criteria

- `new Error("m", {cause: c}).cause === c` in `nativeStrings` and `fast`
  configs; the #5159 (30) and #3481 cause-2 (37) suites stay green.
- Byte-identity for option-less Error constructions in all configs.
- A/B with base at first edit; pinned tests red on base; equivalence clean.
