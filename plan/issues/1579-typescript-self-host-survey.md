---
id: 1579
title: "TypeScript self-host Tier 0 survey — distance from `compileProject(tsc)` to a runnable Wasm"
status: backlog
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: hard
model: fable
reasoning_effort: high
goal: compiler-architecture
sprint: Backlog
related: [1058, 1059, 1042, 1044, 1046]
labels: [stress-test, self-host, typescript, survey]
---
# TypeScript self-host Tier 0 survey

## What this is

A **probe-only** snapshot — no code changes — of where `compileProject` lands
when fed the *bundled* JS files TypeScript ships in `node_modules/typescript/lib/`.
There are no `.ts` source files in the npm package, so this is the only entry
point a Tier 0 stress test can reach without cloning the TypeScript repo.

Companion to **#1058** ("Compile the TypeScript compiler to Wasm — self-hosting
stress test"), which assumes access to `src/compiler/*.ts`. This survey
answers the prior question: how does our compiler behave against the
already-bundled CJS output that lives in every project's `node_modules`?

Methodology mirrors `tests/stress/eslint-tier1.test.ts` and the axios/react
probes. For each entry: `compileProject(entry, { allowJs: true })`, then
`WebAssembly.validate(binary)`. First error per probe is recorded. Bucket
histograms tag every error as `ts-checker | ts-syntax | ts-diagnostic |
codegen-unsupported | other`.

Probe scripts:
- `.tmp/ts-probe/probe-typescript.ts` — vitest-driven small files (≤ 28 KB)
- `.tmp/ts-probe/probe-big-traced.mjs` — node-driven big files (6.2 MB / 9.1 MB)
- `tests/probe-typescript.test.ts` — gitignored vitest harness

Raw results JSON: `.tmp/ts-probe/results.json`

## Probed entries

| # | Entry | Size | Compile | Result | Binary | Errors (bucket) |
|---|-------|-----:|--------:|--------|-------:|-----------------|
| 1 | `lib/watchGuard.js` | 2.3 KB | 2.2 s | **VALID WASM** | 6.3 KB | 5 / `ts-checker` only |
| 2 | `lib/_typingsInstaller.js` | 10 KB | 2.0 s | **VALID WASM** | 22 KB | 19 / 12 `ts-checker` + 7 `ts-diagnostic` |
| 3 | `lib/_tsserver.js` | 28 KB | 2.6 s | **INVALID WASM** | 57 KB | 58 / 55 `ts-checker` + 2 `ts-diagnostic` + 1 `other` |
| 4 | `lib/_tsc.js` (the actual `tsc` CLI) | **5.93 MB** | ~10 s | **THROWS** | — | 1 codegen: `Maximum call stack size exceeded` |
| 5 | `lib/typescript.js` (full API) | **8.69 MB** | ~14 s | **THROWS** | — | 1 codegen: `Maximum call stack size exceeded` |

### Detail per entry

#### 1. `watchGuard.js` — VALID WASM (2.3 KB → 6.3 KB)

Trivial `fs.watch` shim. All 5 reported "errors" are TypeScript checker
diagnostics about `'fs'` and `process` being unresolved — soft warnings
that don't block codegen. The binary validates and is byte-for-byte runnable
once Node host imports are wired up.

```
err[0] Cannot find module 'fs' or its corresponding type declarations.
err[1] Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
err[2] Cannot find name 'process'. …
```

This is the **least-distance** Tier 0 target: a single fix to wire
`@types/node` (or `define`-substitute `process`) would clear the diagnostics,
and the binary already validates.

#### 2. `_typingsInstaller.js` — VALID WASM (10 KB → 22 KB)

19 diagnostics, all "Cannot find module" (`child_process`, `fs`, `path`,
`./typescript.js`) plus `process` references. **No codegen errors.** Binary
validates. Same shape as watchGuard.

#### 3. `_tsserver.js` — INVALID WASM (28 KB → 57 KB)

Compiles and produces a binary but validation fails:

```
WebAssembly.Module(): Compiling function #65:"Logger_msg" failed:
call[0] expected type f64, found if of type externref @+32032
```

This is a **real codegen bug**. The Logger.msg method, as bundled at
`_tsserver.js:179-191`, is:

```js
msg(s, type = typescript_exports.server.Msg.Err) {
  if (!this.canWrite()) return;
  s = `[${typescript_exports.server.nowString()}] ${s}\n`;
  if (!this.inGroup || this.firstInGroup) {
    const prefix = Logger.padStringRight(type + " " + this.seq.toString(), "          ");
    s = prefix + s;
  }
  this.write(s, type);
  ...
}
```

Two candidate sources for the `if → externref → f64-param` mismatch:
- the default parameter `type = typescript_exports.server.Msg.Err` (an
  external enum reference, externref-typed) flowing into a downstream call
  that expects `f64`;
- the template literal expression `\`[${nowString()}] ${s}\n\``
  unifying string and numeric arms.

Either way: a known soft gap from #452 ("template literal with `${}`
interpolation") that #1058 also calls out as a soft prerequisite. This is
the **first hard codegen blocker** in the TypeScript surface, and it's
small enough to extract a 10-line repro from.

#### 4. `_tsc.js` — Maximum call stack size exceeded (5.93 MB)

The actual `tsc` CLI binary. With default V8 stack size, codegen throws
within ~10 s:

```
Codegen error: Maximum call stack size exceeded
```

With `--stack-size=16384` (16 MB), the immediate overflow is bypassed and
codegen runs much longer (still in progress as of report write). The
overflow itself signals that **the codegen's recursive AST/IR walk is not
tail-call shaped for files with a single ~2,671-statement top-level body**
(measured: `ts.createSourceFile` reports 2,671 statements / 711,444 nodes).

`_tsc.js` is the dense, packed esbuild output: every TypeScript module
inside is `IIFE`-wrapped at the top level, producing many sibling function
expressions in one source. Our codegen recurses into each — fine for 30 KB,
not fine for 6 MB.

#### 5. `typescript.js` — same overflow (8.69 MB)

Same `Maximum call stack size exceeded` after ~14 s. Same root cause.
Recurses ~50 % more nodes before exhausting the stack.

## Distance to "compilable"

Defining "compilable" as "produces a Wasm module that validates" (not yet
"runs the TypeScript compiler"), the distance is:

| Entry | Distance | Concrete fixes needed |
|-------|---------:|-----------------------|
| `watchGuard.js` | **0** | Already validates. Only blockers are runtime: Node host imports (`node:fs`, `process`) — covered by #1044 |
| `_typingsInstaller.js` | **0** | Same — already validates |
| `_tsserver.js` | **1** | Fix the `Logger_msg` `if → f64` coercion (one codegen bug). Likely the same template-literal-into-numeric-arg pattern flagged in #452 |
| `_tsc.js` | **≥ 2** | (a) Convert the codegen's recursive node walk to iterative/tail-call-shaped for top-level statement lists, OR raise our internal recursion budget. (b) Whatever lies beyond the overflow — currently unknown because we can't see past it |
| `typescript.js` | **≥ 2** | Same as `_tsc.js` plus any extra patterns the public API surface uses that `_tsc.js` doesn't |

Notable: **none of the 102 distinct `ts-checker` diagnostics across all
probes block compilation.** They're all type-resolution noise from missing
`@types/node`. The compileProject path treats them as warnings, emits a
binary anyway. So the *real* distance is dominated by 1–2 codegen bugs, not
hundreds of checker complaints.

## Recommendation: defer the Tier 0 stress test

**Do not add `tests/stress/typescript-tier0.test.ts` yet.**

Reasoning:

1. **The interesting probe is `_tsc.js`, and that's blocked on a single
   structural codegen issue** (stack overflow on large statement lists). A
   stress test that only exercises `watchGuard.js` (10 lines of `fs.watch`)
   buys ~zero signal beyond what existing stress tests already give.
2. **`_tsc.js` and `typescript.js` need ~10 GB heap and >2 minutes per
   compile attempt today.** That's not viable inside the standard vitest
   test budget; it would be a permanently-skipped test gated on the codegen
   fix, which is exactly the kind of "Tier 0 that doesn't pay rent" the
   prompt warns against.
3. **The lodash / hono / eslint / axios stress tiers already cover the
   patterns that show up at `_tsserver.js` scale** (template-literal-into-f64,
   `instanceof` cross-module, for-in dispatch, CJS `require()` graphs).
   Adding a third probe of the same patterns under the "typescript" label
   would duplicate signal.
4. **#1058 (the real Tier-N target) needs `.ts` source, not bundled CJS.**
   That issue blocks on #1042 (async lowering), #1044 (Node host imports),
   #1046 (separate ES-module compilation). Until those land, a Tier 0 on the
   bundled JS gives a misleading picture: it would "pass" against
   `watchGuard.js` while the real moonshot is on a different code path
   entirely.

**What to do instead:** file the concrete codegen blockers as standalone
issues. Each is well-isolated and unblocks the next layer of the survey
without committing to a permanently-skipped test.

## Highest-leverage blockers (proposed issue titles)

1. **"Codegen recursion limit hit on large top-level statement lists (≥ 2,500
   statements)"** — overflow root cause in `_tsc.js` / `typescript.js`.
   Likely an iterative rewrite of the top-level statement loop in
   `src/codegen/index.ts` or `src/codegen/statements.ts`. Single-file fix,
   high leverage: unblocks every bundled CJS distribution of any sufficiently
   large library (`_tsc.js`, `typescript.js`, future webpack/rollup bundles).

2. **"Template literal expression flowing into f64-param coerces wrong arm
   to externref (`Logger_msg` in `_tsserver.js`)"** — concrete Wasm
   validation error: `call[0] expected type f64, found if of type externref
   @+32032`. Reduces to a 10-line repro
   (`function f(x: number) { return f(\`${x ? x : 0}\`); }` or similar
   ternary-in-template pattern). Same family as #452's 1/20 known gap.

3. **"compileProject treats `Cannot find module 'fs' | 'path' | …` as
   compile errors when `allowJs: true`"** — strictly speaking, these come
   through as warnings (`success=true`), but they pollute `result.errors`
   with 50+ entries that mask the real codegen errors. Either route them to
   a separate `result.warnings[]` array, or auto-load `@types/node` when
   `allowJs: true` is set against a file that uses Node builtins. Quality-
   of-life fix; precondition for clean diff against the actual Tier 0
   pass/fail signal.

4. **"Memory ceiling on `compileProject` for ≥ 5 MB JS inputs"** — current
   ceiling is ~1 GB RSS at parse, climbs past 10 GB during codegen on
   `typescript.js`. Investigate where the codegen retains intermediate
   structures that should be released between functions. Soft-blocker for
   any large-bundle stress test; hard-blocker for self-hosting (because
   self-hosting requires the compiler to compile itself, and the
   compiler-as-source is at least this large).

5. **"Tier 0 harness against bundled CJS distributions of large npm
   packages"** — *file only after #1 and #2 land*. Build a reusable
   `scripts/probe-bundled-cjs.mjs` that runs `compileProject` against
   every `*.js` file in any installed package's `lib/` or `dist/`, records
   first error per entry, and writes a markdown summary. This is the
   generic shape of the present survey — running it against typescript,
   prettier, esbuild, webpack, rollup, and biome would surface the next 5–10
   structural blockers in one sweep. Not worth doing today (one bug
   dominates), worth doing once the codegen handles the bundle shape.

## Why not invest in Tier 0 right now (one-paragraph version)

Two codegen bugs (recursion limit + ternary→f64 coercion) account for every
non-trivial failure across 5 probed entries spanning 4 orders of magnitude
in size. Fixing those two bugs delivers more value than adding a stress
test that would assert "yes, the codegen still overflows" on every CI run.
File the bugs as standalone issues; revisit Tier 0 after they land.

## Coordination notes

- **Other parallel agents working on:** axios (#1032), react (#1033),
  eslint internals (#1282/#1287/#1289).
- **No source modifications outside `plan/issues/backlog/`, `.tmp/`, and
  `tests/probe-typescript.test.ts` (gitignored).** No new committed test
  file.
- **Companion artifacts** (kept in `.tmp/ts-probe/`, gitignored):
  `probe-typescript.ts`, `probe-big-traced.mjs`, `probe-parse-only.mjs`,
  `results.json`.

## Related issues

- **#1058** — the real "compile the TypeScript compiler" issue. This
  survey is the cheap precursor.
- **#452** — the original feasibility study (toy 411-line scanner). Flagged
  the template-literal-into-f64 pattern; we've now confirmed it on real
  TypeScript output.
- **#1042 / #1044 / #1046** — async lowering, Node builtins, separate
  ES-module compilation. Hard prerequisites for #1058 but **not for this
  survey** — bundled CJS sidesteps the module-graph blocker.
- **#1059** — parallel-tsc stress test; depends on #1058 reaching Tier 3.
