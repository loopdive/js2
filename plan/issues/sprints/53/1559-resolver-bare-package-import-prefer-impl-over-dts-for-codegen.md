---
id: 1559
sprint: 53
title: "ModuleResolver: bare-package import resolves to implementation (default/main) for codegen, not .d.ts"
status: needs-spec
created: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: resolver, codegen
language_feature: package-exports, npm-resolution, module-resolution
goal: npm-library-support
related: [1400, 1060, 1061, 1287]
blocks: [eslint-tier-1e, 1560]
---

# #1559 — Bare-package import resolves to implementation for codegen

## Problem

`import { Linter } from "eslint"` currently resolves through ESLint's
`package.json` `exports` map:

```json
{
  ".": {
    "types": "./lib/types/index.d.ts",
    "default": "./lib/api.js"
  }
}
```

The TypeScript checker correctly picks `./lib/types/index.d.ts` for
type information, **but the compiler then uses that same `.d.ts` as
the source of truth for codegen**. The result: codegen treats
`Linter` as an extern class and emits `env.__new_Linter`. The compiled
implementation in `./lib/api.js` (and its transitively required
`./lib/linter/linter.js`) is never traced.

Symptom captured in #1400:

```text
No dependency provided for extern class "Linter"
```

This is the inverse of the #1060 fix (which removed `@types/*`
preference for the implementation graph). #1060 handled the
`@types/foo` case (declaration package distinct from impl package).
This issue handles the **package-local** case where one `package.json`
declares both `types` and `default` for the same bare import.

## Scope distinction

- #1060 — `@types/foo` vs `foo`: separate packages. **DONE**.
- #1559 — single package, `types` + `default` in same `exports`
  conditions block. **OPEN**.

## Reproducer

```ts
import { compileProject } from "./src/index.js";

const r = compileProject("/workspace/entry.ts", { allowJs: true });
// entry.ts contains: import { Linter } from "eslint"; new Linter();
```

Inspect `r.imports`: currently includes `__new_Linter` (extern fallback).
After fix: should not, because `Linter` is found in
`./lib/api.js` → `./lib/linter/linter.js` (a real compiled class).

A direct compile of `./lib/api.js` already works (#1400 Tier 1c-equivalent),
so the implementation graph is reachable — the resolver just needs to
pick it for the bare-package import.

## Required behaviour

When resolving a bare-package specifier (`import X from "pkg-name"`):

1. The TypeScript checker continues to read `.d.ts` for *type* checking
   (so the developer sees `Linter` typed correctly).
2. The codegen module graph follows the `default` / `main` /
   implementation condition for the **module resolution** step,
   producing an implementation source path that is fed to
   `compileMultiSource`.
3. If the implementation entry is `.js`, `allowJs: true` paths must
   honor this (already true for #1287's `.d.ts`-as-extern fix).
4. The fallback chain: implementation entry → if missing/invalid →
   declaration-only extern class (current behaviour).

## Architect spec needed

This issue is **`needs-spec` before dispatch**. The resolver currently
has two competing requirements:

- For `@types/*`: prefer the impl package (`foo`) over the types
  package (`@types/foo`). #1060 addressed this.
- For self-typed packages: prefer the impl entry (`default`/`main`)
  over the types entry (`types`) when codegen needs a body.

The architect spec must define:

1. Where in `src/checker/module-resolver.ts` (or wherever) the
   conditional `exports` resolution decides between `types` and
   `default`. The decision should be **callsite-driven**: codegen
   asks for impl, checker asks for types.
2. The fallback semantics when only one condition is present.
3. Interaction with `compileProject`'s tree-shaker — at what point
   the impl entry's module graph gets pulled in.
4. A regression matrix covering: bare-package + dts-only,
   bare-package + impl-only, bare-package + both (the ESLint case),
   bare-package + scoped (`@scope/pkg`), conditional-exports with
   `node`/`browser`/`default` flavors.

## Acceptance criteria

1. `compileProject` on an entry that does
   `import { Linter } from "eslint"; new Linter()` produces a binary
   whose `imports` manifest does **not** contain `__new_Linter`.
2. The `Linter` class in the produced module is the compiled class
   from `eslint/lib/linter/linter.js`, not an extern.
3. ESLint Tier 1b stays green (validate the bare-package shim binary).
4. ESLint Tier 1e unskips and either passes or moves to the next-layer
   blocker (likely runtime: rule loading, `for...in`, etc.).
5. Existing tests pass: lodash Tier 1+2, Hono Tier 1-6, prettier
   bundled-config compilation (the #1060 regression test), TypeScript
   `@types/*` resolution stays in `@types/*`-prefer-impl mode.
6. A new regression test under `tests/` covers the single-package
   `types` + `default` decision (a minimal `node_modules/foo` fixture
   with both a `.d.ts` and a `.js` body declared in `exports`).

## Notes

- This is #1400 item 1 (deferred from S52 partial PR), promoted to
  its own issue for tracking.
- Blocks #1560 (CJS class re-export linkage) — once this resolves to
  the impl, the re-export issue becomes the next blocker.
- Architect spec needed because the change touches the resolver's
  central decision path and a regression here breaks every npm
  import path.

## Implementation Plan

### Root cause confirmed

`src/resolve.ts:147-160` currently has:

```ts
// TypeScript's standard resolver prefers `.d.ts` declarations from
// `@types/<pkg>` over the real implementation at `<pkg>/...`. ...
if (pkgName && /[/\\]@types[/\\]/.test(resolved)) {
  const implPath = this.findImplementationBody(pkgName, specifier, containingFile);
  if (implPath) {
    resolved = implPath;
  }
}
```

The `@types/<pkg>` redirect is the ONLY trigger for switching to an
implementation body. For self-typed packages like ESLint:

```json
{
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/api.js"
    }
  }
}
```

TypeScript's resolver picks `./lib/types/index.d.ts` (the `types`
condition is preferred). That path does NOT contain `@types/`, so the
redirect at line 155 never fires, and codegen receives a `.d.ts` file
as if it were the implementation.

### Fix — extend the `.d.ts` → implementation redirect

Two-line conceptual change in `src/resolve.ts::resolveModule`:

```ts
// BEFORE
if (pkgName && /[/\\]@types[/\\]/.test(resolved)) { ... }

// AFTER
if (pkgName && (
    /[/\\]@types[/\\]/.test(resolved) ||
    resolved.endsWith(".d.ts")
)) {
  const implPath = this.findImplementationBody(pkgName, specifier, containingFile);
  if (implPath) {
    resolved = implPath;
  }
}
```

Rationale:
- The existing `findImplementationBody` already does the right thing
  for bare-package imports — it reads `package.json` `module ?? main`
  to find the impl entry (line 255). For ESLint, `pkg.main` is
  `./lib/api.js`, exactly what we want.
- Subpath specifiers (`import x from "pkg/sub"`) already work via
  `probeImplementationPath`'s direct-file probe.

### Caveats / edge cases

1. **Packages that ship only `.d.ts` (declaration-only externs).**
   If `findImplementationBody` returns `null`, the resolver
   currently falls back to the `.d.ts` result. This is correct —
   the existing logic at line 158 already guards with
   `if (implPath)`. No change needed: declaration-only packages
   stay as externs.

2. **`exports` map conditions order**: TypeScript respects `types`
   first by default, but `module` / `node` / `default` conditions
   can shift the chosen path. Since we read `package.json.module ??
   package.json.main` directly in `probeImplementationPath`, we
   bypass the `exports` map and pick whichever entry point the
   package author marked as the "real" implementation.
   - **This is a known divergence from Node's resolution algorithm**,
     but it matches the existing `@types/*` redirect's behavior. The
     correctness story is: "the type-checker uses TS's resolver; the
     codegen picks the impl entry as published in `main`/`module`".

3. **Conditional `exports` with no `main` field.** Some modern
   ESM-only packages drop `main` entirely and rely solely on
   `exports`. `probeImplementationPath` will fall through to the
   `index.{js,mjs,cjs,ts}` probe. If even that fails, we keep the
   `.d.ts` result. Add a regression test for this case to prevent
   future regressions.

4. **Mixed bare + subpath in the same package.** Calling
   `findImplementationBody("eslint", "eslint", containingFile)`
   resolves the bare specifier via `package.json.main`. Calling
   `findImplementationBody("eslint", "eslint/lib/rules", containingFile)`
   resolves the subpath via `probeImplementationPath`. Both already
   work — the bug is only in the trigger condition (line 155), not
   in the implementation-finder.

### Test plan

Add `tests/issue-1559.test.ts` with the following cases:

1. **Bare-package self-typed (the ESLint case)**: synthesize a
   minimal `.tmp/issue-1559/node_modules/foo/` fixture with:
   ```
   package.json:  { "main": "./impl.js", "types": "./types.d.ts" }
   impl.js:       export class Foo { bar() { return 42; } }
   types.d.ts:    export declare class Foo { bar(): number; }
   ```
   Compile an entry with `import { Foo } from "foo"; new Foo();`.
   Assert: `r.imports` does NOT contain `__new_Foo`. The compiled
   module references the impl class.

2. **Bare-package `exports` map (the modern ESM case)**:
   ```
   package.json: {
     "exports": {
       ".": { "types": "./types.d.ts", "default": "./impl.js" }
     }
   }
   ```
   Same assertions as case 1.

3. **Declaration-only extern (regression guard)**: fixture with
   only `.d.ts`, no `.js` body. Assert: resolves to the `.d.ts`
   (extern fallback), `r.success` is true.

4. **`@types/*` separate package (#1060 regression guard)**:
   `@types/foo` + `foo` in separate `node_modules` dirs. Assert
   the existing #1060 behaviour still holds — impl wins.

5. **Subpath import (regression guard)**:
   `import x from "foo/sub"` resolves the same way it did before
   (subpath probe). No regression.

6. **ESLint smoke**: Tier 1a entry compiles, and `r.imports`
   does NOT contain `__new_Linter`. (This becomes the end-to-end
   gate for #1559 + #1560 together.)

### Files to touch

- `src/resolve.ts` — extend trigger condition (5 lines)
- `tests/issue-1559.test.ts` — new (~150 lines, six cases above)
- `tests/stress/eslint-tier1.test.ts` — add assertion to Tier 1a
  that `r.imports` does NOT contain `__new_Linter`. Optionally
  unskip Tier 1e if #1560 has also landed.

### Risk assessment

- **Low blast radius**: the change is gated on `resolved.endsWith(".d.ts")`,
  so it only affects paths that resolved to a declaration file. Real
  `.ts`/`.js` source resolutions are untouched.
- **Existing tests cover the regression-sensitive paths**: #1060
  regression test (lodash bundled prettier), Hono Tier 1-6 (real
  CJS package compilation), lodash Tier 1+2 (function re-exports).
  Run these before merging.
- **`module` vs `main` precedence**: keep the current
  `pkg.module ?? pkg.main` ordering (`module` preferred — already
  honored by `probeImplementationPath`).

### Estimated effort

- Codegen change: 30 min
- Test fixtures + assertions: 90 min
- Local validation against lodash / Hono / ESLint stress tests: 30 min
- **Total**: ~2.5 hours, single dev, medium feasibility (not hard)

### Feasibility downgrade

This issue's frontmatter currently says `feasibility: hard,
reasoning_effort: max`. After this spec, **downgrade to
`feasibility: medium, reasoning_effort: high`** — the actual code
change is localized and the test plan is well-defined. The
architect spec was needed for correctness reasoning (decision-point
identification), not implementation complexity.

### Status transition

Once this spec is approved, flip frontmatter:
```yaml
status: needs-spec  →  status: ready
feasibility: hard   →  feasibility: medium
reasoning_effort: max →  reasoning_effort: high
```

---

## Architect review — 2026-05-20 (confirmation pass)

Re-read `src/resolve.ts` end-to-end against the spec above. Findings:

### Confirmations

1. **Decision point verified.** The redirect is at `src/resolve.ts:155`
   inside `ModuleResolver.resolve()`. The current trigger
   `/[/\\]@types[/\\]/.test(resolved)` is the ONLY mechanism for
   switching from a `.d.ts` to an implementation body. Extending the
   condition with `|| resolved.endsWith(".d.ts")` is the minimal
   correct fix.

2. **`findImplementationBody` is callsite-safe for bare specifiers.**
   For `specifier === "eslint"` and `pkgName === "eslint"`,
   `afterPkg === ""` and `probeImplementationPath` reads
   `pkg.module ?? pkg.main` (line 255). ESLint's `package.json`
   has `main: "./lib/api.js"` (no `module`), so we get
   `.../node_modules/eslint/lib/api.js`, which is exactly the impl
   entry the package author marked as canonical.

3. **The walk-up algorithm correctly handles the entry-outside-pkg
   case.** `containingFile` here is the user's `entry.ts` (e.g.
   `/workspace/entry.ts`). The walk-up loop hits
   `/workspace/node_modules/eslint`, `stat`s the dir, and probes
   the impl path. No pnpm / hoisting wrinkle — ESLint is a regular
   top-level dependency.

4. **Resolve cache invariance.** `this.resolveCache` is keyed by
   `${containingFile}::${specifier}`. The redirect happens before
   caching (line 163), so subsequent resolutions return the impl
   path consistently. No stale-`.d.ts` risk.

### Clarifications (call out to the implementer)

1. **The fix is a single conjunctive extension, not a new code path.**
   Do NOT introduce a parallel `if (resolved.endsWith(".d.ts"))`
   branch. Keep the `findImplementationBody` call shared so future
   changes to the impl-finding logic apply to both triggers.

2. **`pkgName` MUST be non-null.** `getBarePackageName` returns
   `null` for relative/absolute paths. Relative imports like
   `import "./types.d.ts"` (rare but legal) MUST NOT be redirected
   — they are file-local references the user explicitly wrote, and
   we have no `node_modules/<pkgName>` to probe. The existing
   guard `if (pkgName && ...)` already covers this; the
   `.d.ts`-suffix extension goes INSIDE that pkgName guard.

3. **Subpath specifiers with declaration-only entries
   (e.g. `eslint/rules`).** Looking at the ESLint `exports` map:
   `"./rules": { "types": "./lib/types/rules.d.ts" }` — there is
   NO `default` condition. If a consumer writes
   `import x from "eslint/rules"`, TS resolves to
   `lib/types/rules.d.ts`, we trigger the redirect, then
   `probeImplementationPath` tries the direct path
   `lib/types/rules` — which does not exist as `.js`/`.mjs`/`.cjs`.
   It returns `null`, and we keep the `.d.ts`. The fallback chain
   is correct — declaration-only subpaths gracefully degrade to
   extern, no regression. Add a regression test case for this
   (test plan case 7 below).

4. **Tier 1a stress test currently passes without the fix.**
   Re-read `tests/stress/eslint-tier1.test.ts:70-87`: Tier 1a
   asserts `r.success === true`. ESLint compiles successfully today
   because `__new_Linter` extern is added as a fallback. The
   assertion that catches the bug is the absence of `__new_Linter`
   in `r.imports`. Add this assertion to Tier 1a (and Tier 1b) as
   part of the fix — this is the regression gate.

### Updated test plan — extra cases

Add to the existing six cases:

7. **Declaration-only subpath (regression guard for ESLint
   `./rules`-style exports).** Fixture:
   ```
   package.json: {
     "exports": {
       ".": { "types": "./types.d.ts", "default": "./impl.js" },
       "./decls": { "types": "./decls.d.ts" }
     }
   }
   decls.d.ts: export declare const x: number;
   ```
   Compile entry with `import { x } from "foo/decls"`. Assert:
   resolves to `decls.d.ts` (extern fallback), `r.success` is true.
   This pins the "subpath has no impl → keep `.d.ts`" behavior.

8. **`module` field preferred over `main` (regression guard).**
   Fixture with `package.json: { "main": "./cjs.js", "module":
   "./esm.mjs" }`. Compile entry with `import x from "foo"`.
   Assert resolved file is `esm.mjs`. (Already covered by
   `probeImplementationPath` line 255; this test pins behavior.)

### Regression gate (run before merge)

The implementer MUST run these locally and verify all pass:

```bash
npm test -- tests/resolve.test.ts
npm test -- tests/import-resolver.test.ts
npm test -- tests/issue-1060.test.ts      # if present
npm test -- tests/issue-1287.test.ts      # if present
npm test -- tests/issue-1559.test.ts      # new
npm test -- tests/issue-1560.test.ts      # positive regression guard
npm test -- tests/stress/lodash-tier1.test.ts
npm test -- tests/stress/lodash-tier2.test.ts
npm test -- tests/stress/hono-tier1.test.ts
npm test -- tests/stress/hono-tier5.test.ts   # class App with method re-exports
npm test -- tests/stress/eslint-tier1.test.ts # Tier 1a/1b must still pass
```

The Hono Tier 5 and lodash Tier 1/2 tests are the strongest gates
— they exercise real npm packages with self-typed declarations and
will surface any over-eager redirect.

### One last sanity check — `.d.ts` in user source

If a user has a hand-written `.d.ts` inside their own project
(e.g. `src/types/foo.d.ts`) and imports it relatively
(`import { X } from "./types/foo"`), the resolved path will end in
`.d.ts` BUT `pkgName` will be `null` (relative specifier). The
`pkgName &&` guard already excludes this case. **No regression.**

If the same user has `node_modules/foo/index.d.ts` (a
declaration-only dependency), the redirect fires, `pkg.main` is
absent (only `types` field), `probeImplementationPath` falls back
to `index.{js,mjs,cjs,ts}` probes (line 270-274), finds nothing,
returns `null`, and we keep the `.d.ts`. **No regression.**

The spec is approved. Flip frontmatter to `status: ready`,
`feasibility: medium`, `reasoning_effort: high`.
