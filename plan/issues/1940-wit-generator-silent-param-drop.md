---
id: 1940
title: "WIT generator: unmappable params are silently dropped — emitted WIT arity disagrees with the core function"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: tooling
language_feature: compiler-internals
goal: correctness
---
# #1940 — WIT generator: never silently drop params

## Problem

`functionToWit` skips any parameter whose type can't be mapped to WIT
(`src/wit-generator.ts:401-406`), emitting a WIT signature whose **arity
disagrees with the core function** — a consumer binding against the WIT
will mis-call the export. Related silent mappings:

- `any` maps to `string` (`wit-generator.ts:177-179`).
- Unions of more than one non-null type return null and the member vanishes
  (`wit-generator.ts:235`).

The generator is honestly scoped ("first step toward Component Model",
`wit-generator.ts:6` — no canonical-ABI adapters, no component binary), but
within that scope the output must be either correct or refused.

## Proposed approach

1. Unmappable param/return ⇒ **skip the whole function** with a comment in
   the WIT output (`// skipped foo: parameter 'x' has unmappable type T`)
   and a compiler diagnostic — never emit a wrong-arity signature.
2. `any` ⇒ skip-with-diagnostic too (mapping to `string` is a silent lie);
   or gate behind an explicit `--wit-any=string` opt-in.
3. Multi-member unions ⇒ WIT `variant` where members are mappable, else
   skip-with-diagnostic.
4. Tests: arity-mismatch regression (function with one unmappable param),
   variant emission, and a golden-file check that every emitted function's
   param count matches the export's signature (cross-check against the
   compiled module's types).

## Acceptance criteria

- No emitted WIT function has an arity differing from its core export
  (programmatic test, not golden text).
- Diagnostics name the function and offending type.

## Source

Compiler quality review 2026-06. Child of #1858 (fail-loud).
