---
id: 4570
title: "Share Node-compatible filesystem validation and errors across providers"
status: backlog
created: 2026-08-20
updated: 2026-08-20
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: runtime, linker
language_feature: node-fs-contract
goal: node-compatibility
sprint: Backlog
depends_on: [4567]
required_by: [4571]
horizon: m
es_edition: n/a
related: [1491, 2631, 2634, 2647, 4565]
origin: "2026-08-20 Node API compatibility and portability review"
---
# #4570 — Share Node-compatible filesystem validation and errors across providers

## Objective

Define one observable `node:fs` contract for argument validation, error shape,
and asynchronous settlement, then reuse it across real-host and WASI-backed
providers.

## Problem

Current filesystem work is organized mainly around transport mechanics:
host-function glue, direct fd imports, path opening, and linear-memory
marshalling. Those mechanisms do not by themselves preserve Node's observable
contract. Providers can disagree about which invalid argument fails first,
whether a coercion runs before I/O, what error object is returned, or when a
callback/Promise settles.

Duplicating validation in codegen and each provider makes that drift likely.
Node semantics belong in the `node:fs` compatibility provider, while codegen
should only declare and call the standard module interface.

## Initial contract surface

- `readSync` and `writeSync`, including buffer/options and string overloads;
- `readFileSync` and `writeFileSync`;
- `fs/promises` `readFile`, `writeFile`, `stat`, `mkdir`, and `unlink`;
- shared path, fd, buffer-view, offset, length, position, encoding, mode, flag,
  callback, and options validation;
- stable error fields where observable: error class/name, `code`, `errno`,
  `syscall`, and normalized path/destination fields.

OS-authored free-form message text may vary. Tests should compare stable fields
and explicitly selected message fragments rather than normalizing substantive
differences away.

## Acceptance criteria

- [ ] A provider-independent validation layer owns the initial contract surface
      and runs before filesystem side effects.
- [ ] JS-host and WASI providers produce the same first observable error for
      invalid arguments and coercion side effects.
- [ ] Differential fixtures cover overload selection, error class/code, stable
      fields, validation order, coercion effects, callback cardinality, and
      Promise settlement ordering.
- [ ] The test artifact reports per-member and per-target denominators; an
      unavailable target is an explicit unsupported row, not a skip or pass.
- [ ] The real Node module and linked providers use the same typed import
      boundary, with provider selection outside call-expression codegen.
- [ ] No unsupported member falls through to a generic module object or returns
      an API-shaped placeholder.
- [ ] Existing fd-based `readSync`/`writeSync` behavior remains filesystem-free
      and does not gain a preopen requirement.

## Out of scope

- Implementing the complete Node filesystem surface.
- Requiring byte-for-byte equality for OS-dependent error prose or paths.
- Baking provider or syscall selection into the source-language checker.
