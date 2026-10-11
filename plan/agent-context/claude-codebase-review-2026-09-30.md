# Codebase review 2026-09-30 — issue map

Filed from this review (all `status: ready`, `sprint: Backlog`; scheduling into
`sprint: current` is the PO's call). Severity is the review's, priority is the
issue's.

| issue | severity | finding |
|---|---|---|
| #6776 | CRITICAL | validate emitted module by default; invalid binary = compile failure (C1/C2 policy) |
| #6777 | CRITICAL | `in` on array carriers: invalid module on `any[]`, wrong on holes, non-boolean (C1/H5) |
| #6778 | HIGH | linear `string + number` → `f64.add` on i32 pointer, `success: true` (C2) |
| #6779 | CRITICAL | default `dynamicCode: "compat"` escapes to host eval; double execution (C3) |
| #6780 | CRITICAL | `await` of statically-resolved operand does not suspend (C5) |
| #6781 | HIGH | generator `.throw()/.return()` silently takes eager path — refuse (H2) |
| #6782 | CRITICAL | `compileFiles()` throws under ESM; library requires global `process`; wasm-opt from cwd (C4/H20) |
| #6783 | CRITICAL | ~4,100 test files ungated; main red (C6) |
| #6784 | HIGH | lint gate vacuous (Biome diagnostic cap); cheap gate "not blocking" (H15/H16) |
| #6785 | HIGH | equivalence-gate blind to file-level failures, no floor; dead path in CLAUDE.md (H17/H4) |
| #6786 | HIGH | test262 regression check accepts pass→fail flips at net ≥ 0 (H18) |
| #6787 | HIGH | `push` fast path reads length before evaluating args (H1) |
| #6788 | HIGH | array carriers skip ToPrimitive/ToString (H4/H6) |
| #6789 | HIGH | extracted object-literal method traps uncatchably — regression of #2025 (H7) |
| #6790 | HIGH | process-lifetime registries: eval worker handles, class-parent map, linked-provider reset (H7/H9/H10) |
| #6791 | MEDIUM | `Promise.reject` pre-marked handled (H8) |
| #6792 | MEDIUM | DOM containment exempts `domRoot`; dead `runtime-containment.ts` (H11) |
| #6793 | HIGH | linear backend: `undefined` ≡ 0, swallowed IR throws, unmaintained — decide fate (H12–H14) |
| #6794 | HIGH | 48.8 MB package (compiler bundled twice); CLI `-v`, hidden errors, cache dir, docs drift (H19/H21) |
| #6795 | HIGH | README/STATUS/ROADMAP/CHANGELOG/CLAUDE.md contradictions (H22) |
| #6796 | MEDIUM | tracked ignored artifacts, dup binaryen, tarballs, NUL byte, audit, devDeps (H23/H24) |
| #6797 | HIGH | import-cycle ratchet; 693-file codegen↔ir SCC (arch) |
| #6798 | MEDIUM | misc probe-backed semantic divergences (typeof class/TDZ, yield*, bool union, i32 saturate, resolve catch) |
| #6799 | MEDIUM | bot pushes to main fail open; hook `--no-verify`; format watchdog; dead workflows/scripts |

Existing issues cross-referenced (not reopened): #1687 (eager generator model), #2025 (regressed, see #6789), #68 (DOM containment, see #6792), #1868 (linear invalid binary, see #6778), #3008 (issue-tests wiring, see #6783).

---

# js2wasm codebase review — 2026-09-30 (HEAD e303c5c7)

Read-only review. Six focused passes (entry/API/CLI, host runtime & eval boundary,
WasmGC codegen, IR + linear backend, tests & CI, architecture & docs) plus direct
verification of every CRITICAL/HIGH item below (probes re-run from `dist/` or via
the source harness). Nothing in the tree was modified; probes live in the session
scratchpad.

Baseline health on a clean checkout: `pnpm run typecheck` (TS7) 0 diagnostics,
`typecheck:ts5` 0, `format:check` clean, `pnpm run build` OK, all `package.json`
exports resolve, `equivalence-gate` exit 0 (22 known failures tolerated).

---

## CRITICAL

### C1. Compiler reports `success: true` for modules the engine rejects (WasmGC)
- `const arr: any[] = [1,2,3]; arr[5] = 9; [2 in arr]` → `errors: []`, then
  `WebAssembly.Module(): struct.get[0] expected type (ref null 2), found local.get of type (ref null 4)`.
- Cause: output validation is opt-in (`src/index.ts:495-506`); the `in`-on-array
  lowering (`src/codegen/binary-ops-in.ts:383-394`, typed arm `:482`) is type-confused.
- Fix: validate by default (`WebAssembly.validate` costs a decode, not a compile) and
  route `in` on array carriers through the `__extern_has_idx` chokepoint the comment
  at `:490` already names.

### C2. Same class on the linear backend: `"1" + 2` emits `f64.add` on an i32 pointer
- `src/codegen-linear/index.ts:2510` requires BOTH operands to be strings; mixed `+`
  falls to the numeric path. Reproduced from `dist/`: `success: true, errors: []`,
  `WebAssembly.compile` → `f64.add[0] expected type f64, found if of type i32`.
- `src/compiler.ts:1025-1027` claims `collectLinearCodegenErrors` prevents "structurally
  invalid binaries (#1868)"; it does not catch this.

### C3. Default `eval` policy runs program strings in the HOST realm
- `src/runtime.ts:12725-12740`: on any non-SyntaxError from the Wasm eval shim, both
  branches call `_legacyHostEval(src)` → `(0, eval)(src)` in the host. The `if
  (isSyntaxError)` branch is literally identical to the else branch.
- Default policy is `dynamicCode: "compat"` (`src/runtime.ts:11490`).
- Probe: `eval("globalThis.process.pid")` returns the real host pid;
  `process.binding` reachable. README §"security boundaries" (line 42) sells Wasm
  compilation as an isolation boundary for third-party code.
- Side effect: the eval'd string executes TWICE when its own body throws a non-SyntaxError
  (`runtime-eval.ts:544` `entry()` is inside the try) — `globalThis.__probe` ends at 2.
- Fix: default to `deny` (or `evaluator`); make host fallback an explicit opt-in named
  `hostEval`; only fall back on compile/instantiate failure, never after `entry()` ran.

### C4. `compileFiles()` — a public export — throws under plain Node ESM
- `src/checker/index.ts:1301` and `:1344`: `const pathMod = require("node:path")`.
  Package is `"type": "module"`, dist is ESM-only. Reproduced against `dist/index.js`:
  `ReferenceError: require is not defined`. Tests pass only because vite-node injects
  `require`; `tests/helpers/compile-files-validate-probe.ts:16-20` monkey-patches
  `globalThis.require` to hide this.
- Fix: use `getDefaultEnvironment().path` (same file, lines 67-73 already do).

### C5. `await` of a "statically resolved" operand does not suspend
- `src/codegen/async-activation.ts:225-227` drops the async lane when every `await`
  passes `awaitIsStaticallyResolved` (`src/ir/async-static.ts`). The body then runs
  synchronously through `await null` / `await Promise.resolve()`.
- Probe: `af = async () => { shared=1; await null; shared=2 }; af(); log(shared)` →
  wasm `2`, JS `1`. Ordering of sibling async functions also diverges.
- Fix: every `await` must defer its continuation to a microtask; refuse to compile
  instead of the documented "sync fallback".

### C6. ~4,100 test files are not gated by any required check, and main is red
- Random 8-file sample on clean main: 2 files / 9 tests fail
  (`tests/native-i32-type.test.ts` 8/8 — instantiates with `{ env: {} }` and the
  compiler now emits a `string_constants` import; `tests/issue-3526-string-boundary-schema.test.ts`
  greps for a symbol that moved).
- Required CI runs: 16 pinned files, the 20-file guard suite, `tests/equivalence/`
  (ratcheted, 22 known failures), and the PR's own touched tests (`changed-root-tests.sh`
  — PR event only, >20 changed files → `exit 0`). The "issue tests this PR touched"
  step is `continue-on-error: true` (`ci.yml:805`); `issue-tests` is not required.
  `docs/ci-policy.md:63` admits the suite "is not clean on main today".
- Fix: triage the red files (fix or delete), then make `issue-tests` a required
  known-failures ratchet like `equivalence-gate`.

---

## HIGH

### Codegen semantics (all reproduced, wasm vs Node)
| # | Case | wasm | JS |
|---|------|------|----|
| H1 | `a.push(f())` where `f` pushes (`array-methods.ts:4293-4299` reads length before evaluating the arg) | `[2]` | `[1,2]` |
| H2 | `gen.throw("boom")` / `gen.return()` — generator silently takes the eager host-buffer path (`generators-native.ts:3780`, `:4302-4308`); whole body incl. `finally` runs at creation | uncaught `boom` | caught inside generator |
| H3 | `delete arr[0]; 1 in arr` on `number[]` / `0 in arr` on `any[]`; `2 in arr` yields `1`/`0` not booleans (`binary-ops-in.ts:482-490`) | wrong | — |
| H4 | `String([0,9,0])`, `` `${arr}` `` with `number[]` returns the array carrier (host lane) | array | `"0,9,0"` |
| H5 | `const m = obj.m; try { m() } catch {}` — trampoline null-`this` traps uncatchably (`closures/method-trampolines.ts:254`) | `RuntimeError` escapes `catch` | catchable `TypeError` |
| H6 | `[] + []`, `+[]`, `Number([5])` skip ToPrimitive for array carriers (`addition-to-primitive.ts:26` admits partial) | `NaN` | `""`, `0`, `5` |

### Runtime / host boundary
- **H7** Node eval Worker leaks every handle: `runtime-node-eval-worker.ts:401` `handles.set` never deleted; host `proxyByHandle` (`:276`) same; no release op in the `Request` union.
- **H8** `Promise.reject` is pre-marked handled (`runtime.ts:17549-17551` `p.catch(() => {})`) → `unhandledRejection` never fires for compiled code.
- **H9** Process-global name-keyed class-parent registry (`runtime/class-static-parent.ts:10-11`): two instances declaring `class C extends X` / `class C extends Y` collide; never cleared.
- **H10** Linked-provider registry requires a manual `resetLinkedProjectRegistry()` before a second instantiation (`runtime.ts:6432-6450` documents the mis-decode); only test scripts call it.
- **H11** DOM containment exempts `domRoot` itself (`runtime.ts:19476/19486/19513/19522` gate on `self !== domRoot`): `root.after(x)`, `root.remove()`, `root.insertAdjacentHTML("beforebegin")` escape the container. `src/runtime-containment.ts` is a dead duplicate.

### IR / linear
- **H12** Linear IR overlay swallows untyped throws (compiler bugs) as silent demotes: `src/ir/backend/linear-integration.ts:1344-1357` only rethrows `IrPlanningIdentityInvariantError`; a bare `TypeError` or `IrInvariantError` is demoted and the direct path compiles the function with no diagnostic. The WasmGC lane hard-errors the same case (`src/ir/outcomes.ts:96-120`, `codegen/index.ts:2390-2404`).
- **H13** Linear backend conflates `undefined` with `0` (`codegen-linear/runtime.ts:1068-1084`, `index.ts:2498`): `a[5] === 0` → `true`. Cross-backend parity is advisory only (`cross-backend-parity.yml:12-27`, 29-program corpus).
- **H14** Linear backend is unmaintained: 0 commits in the last ~900 (vs ~330 to `src/codegen`); `linear-tests` not required; compiles 0/13 playground files.

### CI gates that cannot fail
- **H15** `pnpm run lint` (the `quality` gate) exits 0 with 11 real lint errors in tree. Biome 1.9's default `--max-diagnostics=20` is consumed by the first 20 of 4,613 `noExplicitAny` warnings, and the exit code only reflects *emitted* diagnostics. `biome lint … --max-diagnostics=100000` exits 1 (`runtime.ts:2861` `noUselessCatch`, `boundary-object-adapter.ts:89` `noShadowRestrictedNames`, …). Reproduced.
- **H16** `cheap gate (main-ancestor + lint)` does not gate lint: `test262-sharded.yml:301` `::warning::lint failed … not blocking`.
- **H17** `equivalence-gate` (required) reads only `assertionResults` (`scripts/equivalence-gate.mjs:79-92`); a file that fails to import, a deleted test file, or a fork OOM has zero assertions → "No new equivalence regressions". No floor on `passing.size`.
- **H18** `check for test262 regressions` (required) passes pass→fail flips as long as net ≥ 0 (`scripts/diff-test262.ts:610-635, 2644-2688`); 932 host rows quarantined via `test262-host-noise-quarantine.json`. `docs/ci-policy.md:52` claims "pass→fail regressions cannot merge".

### Packaging / docs
- **H19** Published package is 48.8 MB unpacked / 1,803 files: `dist/runtime-*.js` (the compiler chunk, 20 MB) is bundled a second time into `dist/test262-worker.js` (20.6 MB). The `js2-test262` bin should import `./index.js`.
- **H20** Library hard-requires a global `process` (313+ unguarded `process.env` reads, e.g. `compiler.ts:1051` on every compile); README pitches browser use. Deleting `globalThis.process` → `compile()` throws.
- **H21** CLI: `-v` is both `--version` and `--verbose` (`cli.ts:45` wins; `:369` unreachable); error-severity diagnostics on a successful compile are never printed (`cli.ts:520-527`); `compileProject` writes `.js2wasm-cache/` into the user's source tree by default (`package-linker.ts:1724`), undocumented.
- **H22** README/STATUS/ROADMAP contradict their own numbers: README prints standalone 41,410 (85.9 %) vs host 39,229 (81.3 %), then says standalone is "meaningfully lower" (line 69) and "trails" (line 286). "Not yet supported" lists name eval/Proxy/WeakRef/Temporal, all of which have shipped code and hundreds of passing rows. CHANGELOG stops at v0.52.0; package is 0.71.0. `import { compile } from "js2wasm"` vs package name `@loopdive/js2`.
- **H23** Repo carries 259 MB tracked: `benchmarks/results/test262-current.jsonl` 18 MB (CLAUDE.md says it is no longer committed), `binaryen.js` twice (28 MB), 29 npm tarballs (22 MB) in `tests/dogfood/fixtures`, 437 stale `.claude/ci-status/pr-*.json`, 19 `.tmp/*.mjs` despite `.gitignore`.
- **H24** `pnpm audit`: 3 critical / 48 high / 72 moderate (devDeps only; runtime dep is `typescript` alone). 23 of 44 devDeps have zero `src/` imports (dogfood fixtures).

---

## MEDIUM (selected)
- `typeof (class {})` → `"object"`; `typeof y` before `let y` → `"number"`; `yield*` return value → `null`; `String(false && f())` → `"0"`; `type i32` coercion saturates (`i32.trunc_sat_f64_s`) while `|0` wraps — silent, inconsistent.
- WasmGC resolve-stage catch (`codegen/index.ts:3357-3391`) turns every throw into a `type-resolution-unsupported` warning — designed demotes and real bugs indistinguishable.
- IR fallback ratchet bottomed out (`unintended: {}` since 2026-08-03) on a 13-file corpus while `ir-adoption.md` still lists 31/58 kinds `mixed`; the CLAUDE.md rule "bucket hits zero → add to STRICT_IR_REASONS" contradicts the code's own (better) rule at `codegen/index.ts:2222-2247`.
- `optimize.ts:112/556` resolves `binaryen` from `process.cwd()`; bare `catch {}` at `:322/:356` masks binaryen aborts as "wasm-opt not available".
- Iterator helpers swallow `return()` errors on normal completion (`iterator-polyfills.ts:674-678`); `eval("stmt; 1")` loses the completion value.
- `src/codegen/nonnull-proof.ts:173` contains a raw NUL byte inside a template literal (`grep`/`file` treat the source as binary); write `\0`.
- `.husky/pre-push` runs `git commit --no-verify` on version tags, contrary to the no-`--no-verify` order; `format:check` there skips under a 90 s watchdog (measured 82 s idle).
- 46 of the last 300 first-parent main commits are `[skip ci]` bot pushes; `main-push-queue-gate.mjs` fails open ("gate exited; failing open").
- Import graph: one strongly connected component of 693 files (codegen+ir+frontend, 40 % of src); 3,083 circular chains from `src/index.ts`. `generateModule` is 1,909 lines; 48 files > 3,000 lines; `src/codegen/` has 824 flat files.
- `plan/` is 39.6 % of tracked files; 20 issues carry off-schema statuses; `plan/agent-context` is 770 files / 8.4 MB.

---

## Major corrections (ranked)
1. **Validate output by default in both backends** and treat an invalid binary as a compile failure. This alone converts C1, C2 and every future type-confusion into a red compile instead of a green artifact.
2. **Change the default dynamic-code policy from `compat` to `deny`**, rename the host fallback so it is unmistakably `hostEval`, and never re-run a string after its body executed. Update the README security paragraph to match.
3. **Never "fall back" on control-flow semantics.** `await`, generator `.throw/.return`, and the linear IR overlay all currently degrade to running the wrong program. Make each a compile error (the way #3587 already does for async) until the real lowering exists.
4. **Make the gates gate**: `biome lint --max-diagnostics=<large>` (or `--error-on-warnings` + fix the 11 errors), fail the cheap gate on lint, make `equivalence-gate` fail on file-level failures and enforce a pass-count floor, make `issue-tests` a required known-failures ratchet, and add a per-row strict mode to the host test262 diff for `completed` editions.
5. **Ship a package that runs**: replace the two bare `require("node:path")` calls, guard `process.env` behind one accessor, drop the duplicate compiler bundle from `test262-worker.js` (48.8 MB → ~25 MB), fix `-v`, print error-severity diagnostics, move the compile cache out of the source tree.
6. **Fix the array/`in`/`push`/ToPrimitive cluster in codegen** (H1, H3, H4, H6, H5) — each is a small, local, probe-backed fix.
7. **Decide the linear backend's fate**: either staff it (fix C2/H13, make `linear-tests` + parity required) or mark it experimental in `--help` and README and stop advertising WASI parity.
8. **Repo hygiene in one PR**: `git rm --cached` the ignored-but-tracked artifacts (18 MB jsonl, `.tmp/`, `.claude/ci-status/`), dedupe `binaryen.js`, fetch dogfood tarballs at test time, move dogfood devDeps to a workspace package, run `pnpm audit --fix` for the 3 criticals.
9. **Make the docs generated or delete the prose**: README/STATUS/ROADMAP numbers and "unsupported" lists from `test262-current.json`; CHANGELOG from release tags; fix CLAUDE.md's dead paths (`tests/equivalence.test.ts`, `test262-baseline-validate.yml`, `--nativeStrings`, `bgIsolation`).
10. **Add an import-cycle ratchet** (baseline 3,083) and cut the 74 `ir → codegen` edges first, or the documented IR retirement path cannot be executed.

## Verified OK
Peephole patterns (all 8) sound; emitter has a real `never` exhaustiveness check; bitwise/NaN/−0/ToInt32/number formatting/per-iteration `let` bindings/evaluation order/TDZ reads/try-finally/microtask ordering all match Node across ~25 probes; IR↔legacy ABI parity enforced with typed invariants; SSA verified in `verify.ts`; no `vm.*`, no module-level prototype pollution, `dynamicCode: "deny"` fails closed; `parseInt` NaN-radix sentinel is spec-equivalent; auto-enqueue honours drafts/hold/author-trust; `package.json` exports and bins all resolve after build; typecheck (TS5 and TS7), format, and the equivalence ratchet are green on main.
