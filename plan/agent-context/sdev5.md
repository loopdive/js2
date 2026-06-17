# sdev5 — session context (2026-06-16, wrap)

2nd senior, sprint 62 "Standalone conformance catch-up". Wrapped clean. Pointers
for a fresh senior resuming any of my threads.

## Shipped this session (merged)

- **#1983** — class-member `${ClassName}_${member}` funcMap key collision.
  SOLVED via PR **#1505** (merged, cc833a2c9). Root cause was the **IR front-end**
  (`compileIrPathFunctions` recompiles eligible top-level functions; the IR
  `ClassRegistry.methodFuncName`/`constructorFuncName` → `ir/lower.ts:1358`
  resolved the legacy key, landing on the user fn's funcIdx for a colliding
  class) — NOT the "DCE remap" I first guessed. Fix: `classMemberFuncKey`
  (`src/codegen/class-member-keys.ts`) relocates the class member's funcMap key +
  display name to `__cm$<name>` ONLY on a real collision (byte-identical else),
  routed through producers + every consumer incl. the IR backend + property-access.
  **Any new code reading class-member funcMap keys MUST route through
  `classMemberFuncKey`.**
- **#2161 matchAll slice** — PR **#1504** (merged). Native standalone
  `String.prototype.matchAll(/re/g)` (`__regex_match_all_arrays` in
  `native-regex.ts` + `tryCompileStandaloneStringMatchAll`), zero host imports,
  for-of works.

## In flight (queue/CI — land without me)

- **#2130 Stage A+B** (runtime presence model) — PR **#1518** (enqueued).
  Shared `_wasmStructHasOwn` backs `__hasOwnProperty` + `__extern_has` (`in`);
  DELETED the `__sget_` getter-probe (the module-global field-name test = root of
  the `in` false positives); read-path tombstone gates; `Object.keys` tombstone
  filter. Residual filed as **task #45** (delete/read struct-type symmetry on a
  statically-struct-shaped local `any` — codegen front-end, not the runtime model).
- **#2161 triage + refinement** — PR **#1521** (doc-only).

## Suspended / handed off

- **#2158** (1,388-test class/proto/descriptor standalone lane) —
  **status: suspended**, branch **`issue-2158-classmeta`** (commits 2c5bb9fef +
  0d21b6282). Inert P0 scaffolding landed (`classMetaTypeIdx` + `classMetaGlobals`
  context state). Full resume steps in #2158 `## Suspended Work`:
  P0 `$ClassMeta` registration at `class-bodies.ts:546-573` (byte-identical, lazy
  populator mirroring `emitLazyProtoGet`), #2009 tag-VALUE discipline, use
  `classMemberFuncKey` for `$ctorFunc`. Authoritative spec: #2101.
- **#2161a** (RegExp.prototype reflection closures) — **task #46, parked
  blocked-on-arch**. KEY FINDING (in #1521 / #2161): the refusal
  is reading **`RegExp.prototype` itself** (the prototype OBJECT,
  `property-access.ts:1969`), not the method/getter — every form chains off it,
  NO isolated slice. It needs `RegExp.prototype` as a standalone-queryable object
  + native-method-closure dispatch on a runtime externref regex receiver — the
  **same architecture as #2158's standalone builtin-prototype readers**.
- **#49 (NEW arch task, lead-filed from my finding)** — the cross-cutting
  convergence: **host-free builtin-prototype object + native-method-closure
  dispatch**, shared by RegExp / class / TypedArray. This is the single
  highest-leverage remaining standalone architecture piece. #2161a/#46 fold into
  it; #2158's standalone-readers phase consumes it.

## Data asset

Standalone test262 baseline pulled to
`/home/node/.claude/jobs/<job>/tmp/standalone.jsonl` (48,117 entries; source
`loopdive/js2wasm-baselines/test262-standalone-current.jsonl`). The #2161 triage
table (1,120 RegExp failures bucketed) is in #2161. Re-fetch
the standalone baseline the same way to scope other Lane-B residuals.

## Other open tasks I touched

#47 (#2161b @@symbol-protocol calls, ~128, reuses #1504 helpers), #48 (#2161c
regex-engine v-flag/`\q{}`/dynamic-ctor, ~97 backend). Both dispatch-ready.
