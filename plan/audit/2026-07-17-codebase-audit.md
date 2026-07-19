# Codebase audit — 2026-07-17

Base: upstream/main `c4c13cbe31`. Read-heavy investigation; findings verified
with light targeted standalone compiles only (no test262 run). Focus: codegen
correctness, silent fallbacks, shared-mutable-state footguns, CI single points
of failure.

## Method

Guided by the #3364 archetype (widening maps keyed by bare variable name →
cross-function struct collision). Swept `src/codegen/context/types.ts` for
module-level `Map<string,…>` state keyed on something non-unique, traced the
set/read sites, and reproduced the highest-value candidate end to end.

---

## HIGH

### H1 — Object-integrity tracking keyed by BARE variable name (VERIFIED) → filed #3381

**Files:**
`src/codegen/expressions/call-builtin-static.ts:1382-1389` (freeze/seal/preventExtensions marking),
`src/codegen/expressions/assignment.ts:2514,3329` (frozen-write throw compile-away),
`src/codegen/object-ops.ts:1801-1810,2135-2139` (`definedPropertyFlags`),
`src/codegen/declarations/object-shape-widening.ts:717` + `object-ops.ts:2136,2228,3230,3543` (`widenedDefinePropertyKeys`).

**Defect:** The #3364 fix per-declaration-keyed the shape maps
(`widenedTypeProperties`/`widenedVarStructMap`) but left the sibling
object-integrity maps — `frozenVars`, `sealedVars`, `nonExtensibleVars`,
`definedPropertyFlags`, `widenedDefinePropertyKeys` — keyed by the bare
identifier name, module-wide. They accumulate across the whole compile and are
never scoped per user function (the only reset is the two-pass `__module_init`
snapshot/restore in `declarations.ts:2052-2063`). So a `const o = {}` frozen /
define-property'd in one function poisons every same-named local in every other
function.

**Failure scenario (both reproduced on main, standalone):**
- `function freezeIt(){const cfg={a:1};Object.freeze(cfg);…}` +
  `function mutateIt(){const cfg={a:1};cfg.a=5;return cfg.a;}` → `mutateIt`
  **traps** ("Cannot assign to read only property of frozen object") though its
  own `cfg` is never frozen. Renaming to `cfgB` → correct. The frozen-write
  compile-away at `assignment.ts:2514` emits an unconditional `throw` purely on
  the bare name.
- Two functions each doing `Object.defineProperty(o,"p",…)` with different
  configurable flags → the second function's legal (re)define **traps**
  ("Cannot redefine property") because the first function's `o:p` flag entry
  collides. Distinct names → correct.

Generic local names (`o`, `obj`, `cfg`, `opts`, `result`; acorn's `node`/`type`
per the #3364 commit) make this realistic in test262 and the self-hosted
acorn/AST paths. Same fix machinery as #3364 (`widened-var-key.ts`).

**Confidence:** VERIFIED (repro + control, both variants).
**Severity:** High — silent spurious traps on correct user code; latent, easy
to hit with common variable names.

---

## Areas audited — no new defect found

- **CI promote / shard gating** (`.github/workflows/test262-sharded.yml`):
  the all-or-nothing shard gating (`SHARDS_RAN = needs.test262-shard.result ==
  'success'`, a matrix `result` that is `success` only if *every* leg passed —
  one flaky shard skips the merge/promote path) is the **already-known #3380**;
  hanging SSH pushes are the already-known #3344. No additional independent SPOF
  surfaced in a focused pass; this area is actively owned by others.
- **Swallowed errors** (`src/runtime.ts:2482-2492`): the `catch` that swallows a
  trap in `__to_primitive`'s `@@toPrimitive` probe is **intentional and narrow**
  — it rethrows everything except `WebAssembly.RuntimeError` (wrong struct
  variant), with a load-bearing comment. Not a defect. Other `catch {}` sites
  scanned (`iterator-polyfills.ts`, `optimize.ts`, `treeshake.ts`) are
  best-effort host-shim / optimizer-optional paths, correctly non-fatal.
- **Shape-widening maps** (`widenedTypeProperties`/`widenedVarStructMap`): the
  #3364 per-declaration re-keying is **complete** — every read site now routes
  through `widenedVarKeyFromDecl`/`resolveWidenedVarKey`. Only the sibling
  integrity maps (H1) were missed.

## Notes for future audit passes

- Other module-level `Map<string,…>` in `context/types.ts` keyed by *function*
  name (`funcRestParams`, `funcOptionalParams`, `numericReturnTypes`,
  `generatorYieldType`, `funcSourceText`) are candidates for the same
  collision class if two distinct functions can share a name across scopes
  (nested function expressions, methods). Not traced to a repro this pass —
  **suspected, unverified**; lower priority than H1 because top-level function
  names are usually module-unique.
