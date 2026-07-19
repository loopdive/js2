---
id: 3403
title: "Object-integrity tracking maps (frozenVars/sealedVars/nonExtensibleVars/definedPropertyFlags/widenedDefinePropertyKeys) keyed by BARE variable name → cross-function collision (same archetype as #3364)"
status: done
completed: 2026-07-18
sprint: current
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: objects
horizon: m
goal: core-semantics
related: [3364, 2012, 2744, 1460]
origin: "2026-07-17 codebase audit — VERIFIED reproducing on upstream/main c4c13cbe31"
loc-budget-allow:
  - src/codegen/object-ops.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/call-namespace-static.ts
---

# #3403 — object-integrity tracking is keyed by bare variable name (cross-function collision)

> **Id reassigned 3381 → 3403 (fable-dev-5, 2026-07-18).** This audit issue was
> hand-picked id 3381, which collided with `3381-refresh-baseline-standalone.md`
> that landed on main overnight — parking PR #3304 in the merge queue on the
> `check:issue-ids:against-main` gate. Reallocated via `claim-issue.mjs
> --allocate` (mechanical takeover; the authoring session was idle since
> 21:32 the previous night). No content changed — only the `id:` frontmatter,
> this heading, and the filename. The PR title still reads `docs(#3381)` (a
> merged commit message, cosmetic only).

## Summary

The #3364 fix keyed the empty-object *shape*-widening maps
(`widenedTypeProperties` / `widenedVarStructMap`) per-declaration to stop a
same-named local in one function clobbering another. But its **sibling
object-integrity maps were left keyed by the BARE identifier name**, module-wide.
They accumulate across the whole module compile and are never scoped/reset per
user function, so a `const o = {}` in one function poisons every other
function's variable that happens to share the name `o`:

- `ctx.frozenVars` / `ctx.sealedVars` / `ctx.nonExtensibleVars`
  — added at `src/codegen/expressions/call-builtin-static.ts:1382-1389`
  via `markIntegrity(arg0.text)` / `expr.parent.name.text` (bare name).
- `ctx.definedPropertyFlags` — `Map<"${varName}:${propName}", flags>`,
  keyed at `src/codegen/object-ops.ts:1801-1810` and read at `:2135`.
- `ctx.widenedDefinePropertyKeys` — `Set<"${varName}:${propName}">`,
  added at `src/codegen/declarations/object-shape-widening.ts:717`,
  read at `object-ops.ts:2136,2228,3230,3543`.

The only place these maps are ever reset is the two-pass module-init
snapshot/restore in `declarations.ts:2052-2063` — that is for program-order
within `__module_init`, NOT per-function isolation.

Consumers turn a collision into **wrong runtime output**:
- The frozen-write compile-away at `src/codegen/expressions/assignment.ts:2514`
  (and `:3329`) emits an **unconditional `throw TypeError`** for *any*
  `ident.prop = …` when `frozenVars.has(ident.text)`.
- The defineProperty redefine guard at `object-ops.ts:2135-2139` treats a
  first `Object.defineProperty` as an illegal redefine when a *foreign*
  same-name entry exists → spurious "Cannot redefine property".

## Verified repro (both on upstream/main c4c13cbe31, standalone target)

**(a) freeze collision** — `mutateIt` traps though its `cfg` is never frozen:
```ts
function freezeIt(): number { const cfg = { a: 1 }; Object.freeze(cfg); return cfg.a; }
function mutateIt(): number { const cfg = { a: 1 }; cfg.a = 5; return cfg.a; }
export function test(): number { return freezeIt() + mutateIt(); } // want 6
```
Actual: WebAssembly trap ("Cannot assign to read only property of frozen
object") thrown from `mutateIt`. Renaming `mutateIt`'s local to `cfgB` → returns
6 (control passes). The compile-away fires purely on the bare name `cfg`
poisoned by `freezeIt`.

**(b) defineProperty collision** — legal redefine throws:
```ts
function a(): number { const o: any = {}; Object.defineProperty(o, "p", { value: 1, configurable: false }); return o.p; }
function b(): number { const o: any = {}; Object.defineProperty(o, "p", { value: 2, configurable: true });
                        Object.defineProperty(o, "p", { value: 3, configurable: true }); return o.p; }
export function test(): number { return a() + b(); } // want 4
```
Actual: trap from `b` ("Cannot redefine property"), because `a`'s
non-configurable `o:p` entry poisons `b`'s independent `o`. Distinct names
(`o1`/`o2`) → returns 4 (control passes).

Generic local names (`o`, `obj`, `cfg`, `opts`, `result`, and — per the #3364
commit — acorn's `node`/`type`) make this collision realistic in test262 and
in the self-hosted acorn/AST paths.

## Fix direction

Reuse the #3364 machinery (`src/codegen/widened-var-key.ts`): key all five
maps per-declaration (name + declaration start offset) rather than bare name.
Set sites resolve the declared binding; use sites resolve the identifier symbol
→ `valueDeclaration` (`resolveWidenedVarKey` / `widenedVarKeyFromDecl`).
Module-level / global objects (no local declaration) can fall back to the bare
name as today. Non-colliding modules stay byte-identical; only same-name /
different-integrity collisions change (to correct). Add a standalone regression
test mirroring the two repros above (no acorn compile needed).

## Acceptance criteria
- Both repros above return 6 and 4 respectively (standalone + host).
- No test262 regressions; byte-identical output on non-colliding modules.
- `frozenVars`/`sealedVars`/`nonExtensibleVars`/`definedPropertyFlags`/
  `widenedDefinePropertyKeys` no longer keyed by a bare identifier that can
  repeat across functions.

## Implementation landed (opus-dev-a, 2026-07-18)

Added `integrityVarKey(ctx, ident) = resolveWidenedVarKey(ctx, ident) ??
ident.text` to `src/codegen/widened-var-key.ts` (per-declaration key
`name@declStart` for locals; bare-name fallback for module-level/ambient
globals that cannot collide cross-function — keeps non-colliding modules
byte-identical). Routed every SET/READ of the five maps through it (or through
`widenedVarKeyFromDecl` at a declaration site):

- **frozenVars / sealedVars / nonExtensibleVars** — `call-builtin-static.ts`
  `markIntegrity` (both binding shapes), `call-namespace-static.ts`
  `Reflect.preventExtensions`, `assignment.ts` frozen-write + non-extensible
  guards.
- **definedPropertyFlags** (varName-half) — `object-ops.ts` (dpKey + all
  varName/key derivations + a separate `argVarKey`/`recvVarKey`/`dpfPrefix` at
  the mixed sites that also feed out-of-scope maps), `builtin-static-gopd.ts`,
  `property-access.ts` `runtimeAccessorDescriptorKey`, `call-builtin-static.ts`
  gOPD.
- **widenedDefinePropertyKeys** (varName-half) — `object-shape-widening.ts`
  threads a per-declaration `varKey` through `collectPropsFromStatements` /
  `recordDefinePropertyWiden`; `object-ops.ts` read sites.

Out-of-scope maps that share the same receiver identifier but stay bare-keyed
(`sidecarDefinedPropertyKeys`, `definePropertyReceiverKeys`,
`nonConfigurableAccessorKeys`, `moduleGlobals`) keep their inline bare-name
derivations; the mixed sites (`argVarName`/`recvVarName`/`receiverName`,
`property-access` key) compute BOTH a bare key for those and a per-declaration
key for the five maps.

**Validation**: `tests/issue-3403-object-integrity-var-key.test.ts` — 5/5 pass;
the two repros return 6 and 4 in BOTH standalone and host lanes; a distinct-name
control keeps correct freeze semantics.

**loc-budget note**: the per-declaration-key routing adds +19 net LOC across five
god-files (`object-ops.ts` +7, `call-builtin-static.ts` +6, `assignment.ts` +3,
`property-access.ts` +2, `call-namespace-static.ts` +1) — irreducible
correctness code (the new `argVarKey`/`recvVarKey`/`dpfPrefix` locals + the
split-key sites), granted the change-scoped `loc-budget-allow` in the
frontmatter above.
