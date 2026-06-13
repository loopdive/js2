---
id: 1751
title: "WIT generator emits an incomplete world: hardcoded package name + no WASI imports"
status: done
created: 2026-05-30
updated: 2026-06-02
completed: 2026-06-02
priority: medium
feasibility: medium
task_type: feature
area: wit-generator
goal: platform
sprint: 58
related: [600, 639, 389]
---
# #1751 — WIT generator emits an incomplete world

## Context

Reported by an external contributor on GitHub #389 (native-messaging host).
Compiling `nm_typescript.ts` with `--wit` produces:

```wit
package local:module;

world module {
  export main: func();
}
```

Compared to what `wasm-tools component wit` extracts for the equivalent
AssemblyScript / Javy components
([nm_assemblyscript_component.wit](https://github.com/guest271314/native-messaging-webassembly/blob/main/nm_assemblyscript_component.wit),
[nm_javy_component.wit](https://github.com/guest271314/native-messaging-webassembly/blob/main/nm_javy_component.wit)),
which carry a meaningful package name and the full import/export surface, our
output is thin.

`#600` (done) added WIT generation from TS types; this issue tracks the
**completeness gaps** in that output. `export main: func()` is actually
*correct* (in the native-messaging host, `main` is the only exported function;
`getMessage`/`sendMessage` are internal) — the real gaps are:

## Gaps

1. **Hardcoded package name.** `WitGeneratorOptions.packageName` defaults to
   `"local:module"` and there's no CLI way to set it. Real components name the
   package (e.g. `native-messaging-host:native-messaging-javy`). Add a
   `--wit-package <ns:name[@version]>` flag and/or derive a sensible default
   from the output filename instead of the literal `local:module`.
   (`src/wit-generator.ts` ~line 25 / 90.)

2. **No `import` side.** The generated `world` lists only `export`s. A WASI
   target module actually *imports* host interfaces (`wasi:cli`, `wasi:io`,
   `fd_write`/`fd_read`/`proc_exit`, plus any `__*` host imports). A faithful
   WIT world should declare those imports so the file reflects the module's
   real interface and round-trips against `wasm-tools`. Emit the import surface
   the compiled module declares (the same set `index.ts` adds for the target).

3. **(stretch) Round-trip parity check.** Add a test that compiles a small
   program with `--wit`, builds the component, and asserts our emitted WIT
   matches (modulo formatting) what `wasm-tools component wit` extracts.

## Out of scope

- Wrapping the core module into an actual deployable Component (canonical ABI
  adapter) — that's **#639**.
- String-encoding boundary selection — **#1650**.

## Acceptance

- `--wit-package` (or filename-derived default) replaces the literal
  `local:module`.
- The emitted `world` includes the module's `import`s, not just exports.
- A regression test covers the native-messaging host shape (`export main` +
  WASI imports) and ideally a `wasm-tools` round-trip.

## Implementation status (2026-06-02)

Status: done on main via commit `4d231b51f`.

Changes:
- Added `--wit-package <ns:name[@version]>` to the CLI. The flag implies `--wit`.
- WIT package names now default to `js2wasm:<input-basename>` when no package is supplied, replacing `local:module`.
- WIT generation consumes the compiled module's import/type table and emits function imports in the world, preserving the original core import module/name in doc comments.
- WASI native-messaging shape now emits `fd-read`, `fd-write`, and `proc-exit` imports plus `export main: func();`.

Validation:
- `pnpm test tests/issue-1751.test.ts tests/wit-generator.test.ts`
- `pnpm exec tsc --noEmit --pretty false`

Notes:
- `wasm-tools` is not installed in the workspace, so the stretch round-trip parity check was not added.
- Non-function core imports are not emitted as WIT world imports because WIT world items express functions/interfaces, not raw core globals/tables/tags.
