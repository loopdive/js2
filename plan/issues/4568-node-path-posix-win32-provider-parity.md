---
id: 4568
title: "Complete portable node:path parity for POSIX and Win32"
status: backlog
created: 2026-08-20
updated: 2026-08-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: runtime, linker
language_feature: node-path
goal: node-compatibility
sprint: Backlog
depends_on: [2512, 4567]
horizon: m
es_edition: n/a
related: [1494, 1791, 1810, 3681]
origin: "2026-08-20 Node API compatibility and portability review"
---
# #4568 — Complete portable `node:path` parity for POSIX and Win32

## Objective

Provide the deterministic `node:path` surface through a portable, linkable
provider rather than compiler-special inline shims or opaque host objects. The
same source must behave consistently under JS-host, standalone/WASI, and linear
targets.

## Current gap

The existing Tier-0 implementation covers a useful POSIX subset:
`resolve`, `join`, `normalize`, `dirname`, `basename`, `extname`, `isAbsolute`,
and `relative`, plus POSIX `sep` and `delimiter`. It deliberately deferred:

- `path.posix` and `path.win32` namespace objects;
- `parse`, `format`, and `toNamespacedPath`;
- Win32 drive, UNC, device, separator, and case-insensitive root semantics;
- a provider-explicit `cwd` dependency for relative `resolve` calls.

Unsupported members can consequently escape through the generic module-object
route instead of receiving an explicit capability result.

## Design

- The compiled program imports only the used real members from `node:path`.
- A portable provider implements string/path algorithms and can be selected for
  every target.
- `path.posix` and `path.win32` remain explicitly selectable on every platform.
- The default namespace follows the selected target platform policy. That
  policy is recorded in the capability manifest rather than inferred from an
  ambient build machine.
- Relative `resolve` declares a `node:process::cwd` dependency. Standalone mode
  must receive an explicit cwd provider; it must not hide a hard-coded cwd as
  Node-compatible behavior.

## Acceptance criteria

- [ ] The provider implements `normalize`, `isAbsolute`, `join`, `resolve`,
      `relative`, `dirname`, `basename`, `extname`, `parse`, `format`, and
      `toNamespacedPath` for both POSIX and Win32 semantics.
- [ ] Default, named, namespace, `path.posix`, and `path.win32` import shapes
      expose the same typed implementation.
- [ ] Fixtures cover empty paths, repeated separators, `.`/`..`, trailing
      separators, extensions, drive-relative paths, drive roots, UNC shares,
      and device paths.
- [ ] Differential tests compare every fixture with the pinned Node oracle and
      report the exact denominator for POSIX and Win32 rows separately.
- [ ] The portable provider has no hidden host imports; `resolve`'s cwd input is
      declared and tested as a capability.
- [ ] Unsupported or unimplemented exports receive registry diagnostics rather
      than opaque host fallback.
- [ ] Programs that do not import `node:path` contain no path provider imports
      or linked path implementation.

## Out of scope

- Filesystem existence, symlink resolution, globbing, or URL conversion.
- Embedding path semantics directly in call-expression codegen.
