---
id: 2624
title: "Node API emulation typing is import-scoped, not blanket"
status: done
sprint: Backlog
created: 2026-06-22
updated: 2026-06-22
completed: 2026-06-22
priority: medium
feasibility: medium
reasoning_effort: max
task_type: feature
area: checker
language_feature: node-host-apis
goal: standalone-mode
related: [2603, 2524, 2512, 389]
---

## Problem

`--emulate node` (#2603) injected a **blanket** ambient `.d.ts`
(`NODE_ENV_DTS_SOURCE`) that always declared the global `process` whenever
emulation was on — regardless of what Node surface the program actually used. A
program that imports only `node:fs` would still get an ambient `process`, and
there was no per-module typing for `node:<mod>` imports at all.

The agreed per-module design (stakeholder-confirmed, loopdive/js2#389) is that
Node emulation is **per-imported-module, not blanket**, with the type layer and
the runtime layer lining up 1:1:

- **Type layer** (this issue): `import … from "node:fs"` injects ONLY `node:fs`
  types (only the imported members); a bare global `process` (no import — the
  #389 host) injects ONLY the `process` global. Don't inject the whole Node
  surface.
- **Runtime layer** (#2625): one linkable shim PER MODULE, named after the
  module (`node:process` → `js2wasm:node-process`).

## Fix — build the injected `.d.ts` dynamically, scoped to what the source touches

`src/checker/index.ts`, `analyzeSource`: when `emulateNode` is on, build the
injected `.d.ts` DYNAMICALLY from the source instead of serving the static
`NODE_ENV_DTS_SOURCE`.

- `scanNodeEmuUsage(source, scriptKind)` — a cheap single `ts.createSourceFile`
  parse (no type-checking) that records, for the source:
  - every `import … from "node:<mod>"` (default / named / namespace) and
    `require("node:<mod>")`, with the **imported member names**;
  - whether a **bare global `process`** is referenced (and `node:process` was
    NOT imported — in which case `process` is the import binding, not the
    global).
- `buildNodeEnvDts(usage)` — emits ONLY the touched surface:
  - bare global `process` → the `NodeJS_Process` interfaces + `declare var process`;
  - `node:process` import → the interfaces + a `declare module "node:process"`
    with a default export and named member re-exports (so default / namespace /
    named imports all resolve under ESNext module mode, no `esModuleInterop`);
  - other `node:<mod>` imports → a permissive `declare module "node:<mod>"`
    declaring just the imported member names (`export const <name>: any`) + a
    default, so they type-check (goal: "type-checks, no TS2307/TS2580", minimal
    surface);
  - returns `undefined` when the program touches no Node surface → the checker
    skips injection entirely (no empty synthetic root).
- `buildNodeEnvDtsForSource(source, scriptKind?)` is exported so tests can assert
  the EXACT injected text.

Kept from #2603: the `--emulate node|none` flag, the `node:`-import auto-detect
(cli.ts), the duplicate-identifier fallback (a user that declares its own
`process`/module never errors), and the warning-dedup.

**Type-level only** — emitted wasm is byte-identical. The example host
(`examples/native-messaging/nm_js2wasm.ts`, a bare-`process` #389 host) md5s to
`428a96eb38121be46a7983bdff883e70` with the default path, with `--emulate node`,
and after this change — all identical. Codegen lowers `process.*` syntactically
regardless of the injected declaration.

## Verification

- `tests/issue-2603-warning-dedup-auto-emulate.test.ts` (#2624 block, 7 new
  cases): a `node:fs`-only program does NOT inject `process`; a bare `process`
  reference injects ONLY the process global (no module decls); a `node:process`
  import injects the process module but NOT unrelated `node:*` modules and NOT
  the ambient global; multiple `node:*` imports each declare only their own
  members; a no-Node-surface program injects nothing (`undefined`); an
  end-to-end `analyzeSource` with `node:process` resolves with no TS2307/TS2580;
  namespace import resolves.
- Byte-identity: `examples/native-messaging/nm_js2wasm.ts` → wasm md5 unchanged
  (`428a96eb…`) for default and `--emulate node`.

## Notes

Builds on PR #1950 (`fix-dedupe-node-builtin-warnings`). Mirrors the per-module
runtime-shim design in #2625 (`js2wasm:node-process`). Pairs with #2512 (node
host APIs as separate linkable wasm modules) and #2524 (process IO shim).
