// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1282 — ESLint Tier 1 stress test: minimal `Linter.verify()`.
//
// Goal: drive the ESLint module graph through `compileProject` and
// document — at the granularity of "compiles OK / instantiates OK /
// runs OK" — what works on `main` today. Each `it` covers one rung of
// the ladder; the last passing rung tells us where the next fix lands.
//
// Methodology mirrors `tests/stress/hono-tier1.test.ts` and
// `tests/stress/lodash-tier1.test.ts`: an inline entry source written
// to a tmp file, run through `compileProject`, optionally
// instantiated and exercised. The current compile frontier asserts its exact
// diagnostics; later rungs are explicit `it.skip` tests with pointers to the
// blocking issues so the ladder progressively advances as those issues close.
//
// Known dependencies (from `plan/issues/sprints/48/1282-eslint-tier-1-stress-test.md`):
//
//   - CJS `require()`             → #1279 (DONE)
//   - CJS `module.exports`        → #1277 (DONE)
//   - WeakMap private storage     → #1283 (DONE — already extern)
//   - `instanceof` cross-module   → #1273 (open)
//   - `for...in` / `Object.keys`  → #1271 (open)
//   - `typeof` dispatch           → #1275 (open)
//   - Optional chaining `?.`      → #1281 (DONE)
//
// New blockers discovered while writing this test:
//
//   - #1287 — minimal `new Linter()` entry compiles but emits
//     invalid Wasm ("Type index 10 is out of bounds @+58") because
//     the `eslint` npm package isn't traced by the resolver.
//   - #1289 — direct `eslint/lib/linter/linter.js` compile produces
//     invalid Wasm in `FileReport_addRuleMessage` (array.set type
//     mismatch).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileProject } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";
import { ESLINT_DEV_DEPENDENCY_SKIP, requireEslintFile, resolveEslintFile } from "../helpers/eslint.js";
import { type CompileProjectProbeReport, runCompileProjectProbe } from "../helpers/eslint-graph-probe.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Tier 1 entry files live in `.tmp/` (gitignored). Each test writes its own
// fresh entry to avoid stale-cache surprises across vitest worker pools.
const TMP_DIR = resolve(__dirname, "../../.tmp/eslint-tier1");
const ESLINT_LINTER = resolveEslintFile("lib/linter/linter.js");

// #3672 — the package-entry graph runs under the same enforced budget as the
// direct `linter.js` probe in `tests/issue-3672.test.ts`. Enforcing rather than
// recording matters here: an out-of-memory abort or a hung child must surface
// as a named probe failure, never as "the compiler produced no diagnostics".
const TIER1_HEAP_LIMIT_MB = 2048;
// (#1282) Re-measured after the ambient-`.d.ts` fix removed the `source callable
// validate` abort: the package entry now runs REAL codegen instead of stopping
// at ~12 s, and reaches its next blocker at 297 s. Widened on a fresh
// measurement, exactly as this file's own rule requires — not to make a red rung
// green. 600 s leaves ~2x headroom for a slower CI runner.
//
// (2026-08-01) Re-measured AGAIN after #4001/#4018/#4019/#4027/#4028 cleared
// five successive aborts. Each fix lets the compiler lower more of the graph
// before stopping, so wall time GREW even though #4001 removed a quadratic:
// 297 s -> 820 s. Measured under this file's own enforced 2048 MB cap on a
// 4-core container: 820 s wall, peak RSS 1,576 MB (`VmHWM`, sampled every 2 s
// by a parent supervisor), exit 0, structured report emitted. The heap cap is
// therefore still honest and stays at 2048.
//
// (2026-08-02) Re-measured once more after #4033 and with `allowFs` on: 955 s.
// Still inside 1,500 s (~1.6x), so the budget is unchanged. Each cleared blocker
// costs wall time because more of the graph actually lowers.
//
// 1,500 s is ~1.6x the measurement. This is a slow rung, and deliberately so —
// the dominant cost is the single surviving module-init compile (#4031, ~51 % of
// the ESLint compile). Shrink this budget when #4031 lands, do not leave it wide.
// `tests/stress/` runs in no required check, so this does not gate CI.
const TIER1_WALL_CLOCK_BUDGET_MS = 1_500_000;

let tier1EntryCompile: Promise<CompileProjectProbeReport> | null = null;

function writeEntry(name: string, src: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const p = join(TMP_DIR, name);
  writeFileSync(p, src);
  return p;
}

function compileTier1Entry(): Promise<CompileProjectProbeReport> {
  if (tier1EntryCompile === null) {
    const entry = writeEntry(
      "tier1-entry.ts",
      `
import { Linter } from "eslint";
const linter = new Linter();
export function test(): number {
  const messages = linter.verify("const x = 1;", {});
  return Array.isArray(messages) ? messages.length : -1;
}
`,
    );
    // Explicitly pin the first ESLint rung to the WasmGC JS-host lane under a
    // Node host. Node builtins stay host dependencies instead of becoming a
    // standalone/WASI implementation requirement.
    //
    // The package graph currently takes over Vitest's worker-heartbeat budget
    // to compile synchronously, so keep the worker responsive by compiling in
    // a child process and returning a small structured frontier report.
    //
    // #3672 — the child now runs under an enforced heap and wall-clock budget.
    // Previously an out-of-memory abort (SIGABRT, empty stdout) and a hung
    // child were both indistinguishable from "no useful output"; the shared
    // supervisor rejects with a typed `EslintGraphProbeFailure` naming which
    // budget broke, so a breach can never be read as a compiler diagnostic.
    tier1EntryCompile = runCompileProjectProbe({
      entry,
      // (#4033) `allowFs` is REQUIRED, not a convenience: ESLint calls
      // `fs.readFileSync`, and the #1491 policy gate refuses to emit for a
      // non-WASI target without it. That refusal is correct behaviour, not a
      // compiler defect, and leaving it in the run buried a real policy decision
      // in the middle of a defect ladder.
      options: { allowJs: true, target: "gc", platform: "node", allowFs: true },
      heapLimitMb: TIER1_HEAP_LIMIT_MB,
      timeoutMs: TIER1_WALL_CLOCK_BUDGET_MS,
    }).then((outcome) => outcome.report);
  }
  return tier1EntryCompile;
}

describe.skipIf(ESLINT_LINTER === null)(
  `#1282 ESLint Tier 1 — minimal Linter.verify() ${ESLINT_DEV_DEPENDENCY_SKIP}`,
  () => {
    /**
     * Tier 1a — run the real package-entry graph in the Node-host JS lane.
     *
     * #3672 un-skipped this rung. It had been `it.skip` on the belief that the
     * graph "does not complete inside this test's compile budget"; re-measured
     * on 2026-07-31 against `origin/main` that is false — the package entry
     * completes in **10.8 s at 628 MB peak RSS** under a 2048 MB cap and emits
     * a structured report. Every rung of this file being skipped meant there
     * was *zero* automated signal on ESLint compilation, which is worse than a
     * red rung.
     *
     * Frontier as of 2026-08-01, AFTER the ambient-`.d.ts` fix (#1282) in
     * `src/codegen/declarations.ts`. The previous two rungs are both retired:
     * the builtin-subclass inherited-alias abort, and then
     * `source callable validate has no consistent exact top-level or
     * compiler-support inventory owner` — the latter caused by a bare
     * `function validate(...)` in `json-schema/index.d.ts` being minted as a
     * DEFINED wasm function (inside a `.d.ts`, `declare` is implicit, so the
     * `hasDeclareModifier` guard missed it).
     *
     * With that gone the package entry no longer stops in the front-end at
     * ~12 s — it runs REAL codegen for the first time, for 297 s, and reaches
     * a genuinely different class of blocker: a module-init ORDERING defect,
     * `module TDZ global minimatch was observed before its value global`.
     *
     * Resolution is otherwise complete — #3654 landed and there is not a single
     * `Cannot find module` left on this entry. #3656's dynamic-destructuring
     * invariant is gone too.
     */
    it('Tier 1a — package entry reaches the current frontier for `import { Linter } from "eslint"`', async () => {
      const r = await compileTier1Entry();
      const diagnostics = r.errors.map((error) => error.message).join("\n");
      expect(r.success).toBe(false);
      expect(r.binaryByteLength).toBe(0);
      expect(diagnostics).not.toContain("Cannot find module");
      expect(diagnostics).not.toContain("object destructuring source must be IrType.object or IrType.class");

      // Frontier as of 2026-08-02. The single-hard-abort ladder is FINISHED:
      // #4018 (ambient `.d.ts` owning a module TDZ global), #4019 (unbounded
      // recursion on cyclic types), #4027 (documented IR deferrals classified as
      // fatal invariants), #4028 (a nested `FunctionDeclaration` admitted as an
      // imported direct-call target the inventory can never own) and #4033
      // (`callableProvider` duplicating `moduleInit`'s role ordinal) each retired
      // the abort before it. There is now NO hard codegen abort at all.
      const codegenErrors = r.errors.filter((error) => error.message.startsWith("Codegen error:"));
      expect(
        codegenErrors.map((error) => error.message),
        "a hard codegen abort came back on the ESLint package entry",
      ).toEqual([]);

      // What blocks emission now is a SET of independent gaps, not one abort.
      // Pin them by identity so fixing any one turns this rung red on purpose.
      expect(diagnostics).toContain("$ObjVecArr"); // #4037
      expect(diagnostics).toContain("Internal error compiling expression"); // #4038

      // Retired rungs must not come back — each of these WAS the frontier.
      expect(diagnostics).not.toContain("inherited class callable");
      expect(diagnostics).not.toContain("was observed before its value global"); // #4018
      expect(diagnostics).not.toContain("Maximum call stack size exceeded"); // #4019
      expect(diagnostics).not.toContain("concrete return needs a dynamic box"); // #4027
      expect(diagnostics).not.toContain("has no exact structural unit identity"); // #4028
      expect(diagnostics).not.toContain("share structural order"); // #4033
      // #1491's fs gate is a POLICY refusal, not a defect — `allowFs` above
      // settles it. If it reappears the option was dropped, not a bug found.
      expect(diagnostics).not.toContain("requires the --allow-fs flag");
    }, 1_560_000);

    /**
     * Tier 1b — the binary produced by Tier 1a is structurally valid Wasm.
     * Asserts via `WebAssembly.validate` (does not require host imports
     * to be satisfied — those are tested in Tier 1e). Previously failed
     * with `Type index N is out of bounds @+offset` because `.d.ts`
     * interfaces (`Comment`, `JSONSchema4`, etc.) were registered as
     * WasmGC structs whose array fields produced forward heap-type
     * references after dead-elim compaction. Fixed by skipping
     * `collectInterface` for `.d.ts` source files. (#1287)
     */
    it.skip("Tier 1b — package-entry binary is structurally valid Wasm (blocked before emission by #3655/#3672)", () => {
      // Advance this rung once Tier 1a emits a binary.
    });

    /**
     * Tier 1c — `compileProject` accepts the `eslint/lib/linter/linter.js`
     * file as a direct entry (bypassing the package entry resolver).
     * The internal CJS `require()` graph is traced thanks to #1279 and
     * #1277, producing a 255 KB binary.
     *
     * What this rung asserts: compile-time success against a real
     * 32-file CJS module graph. Validation is the next rung.
     */
    it.skip("Tier 1c — `eslint/lib/linter/linter.js` direct compile succeeds (blocked by #3655/#3672)", async () => {
      const entry = requireEslintFile(ESLINT_LINTER, "lib/linter/linter.js");
      const r = await compileProject(entry, { allowJs: true });
      expect(r.success, r.errors.map((error) => error.message).join("\n")).toBe(true);
      if (r.success) {
        expect(r.binary.byteLength).toBeGreaterThan(100_000);
      }
    });

    /**
     * Tier 1d — the binary from Tier 1c instantiates. Currently fails
     * inside `FileReport_addRuleMessage` with
     *   `array.set[2] expected type (ref null 80), found array.get of type (ref null 64)`
     * — a struct-shape mismatch where a narrower inferred element type
     * is being written into an array of a wider declared type.
     *
     * BLOCKED on #1289.
     */
    it.skip("Tier 1d — `linter.js` binary instantiates (blocked before validation by #3655/#3672)", async () => {
      const entry = requireEslintFile(ESLINT_LINTER, "lib/linter/linter.js");
      const r = await compileProject(entry, { allowJs: true });
      expect(r.success, r.errors.map((error) => error.message).join("\n")).toBe(true);
      if (!r.success) return;
      const imps = buildImports(r.imports as never, undefined, r.stringPool);
      await expect(WebAssembly.instantiate(r.binary, imps as never)).resolves.toBeDefined();
    });

    /**
     * Tier 1e — full integration: `linter.verify("const x = 1;", {})`
     * runs end-to-end and returns `[]`. Requires Tiers 1b–1d plus the
     * remaining open blockers listed in the issue file.
     *
     * BLOCKED on #1287, #1289, #1273 (instanceof), #1271 (for-in),
     * #1275 (typeof dispatch).
     */
    it.skip('Tier 1e — Node-host `Linter.verify("const x = 1;", {})` returns `[]` (blocked by #3655/#3657/#3672)', async () => {
      const entry = writeEntry(
        "tier1e-entry.ts",
        `
import { Linter } from "eslint";
const linter = new Linter();
export function test(): number {
  const messages = linter.verify("const x = 1;", {});
  return Array.isArray(messages) ? messages.length : -1;
}
`,
      );
      // The first runnable proof is deliberately the default WasmGC JS-host
      // lane under Node. Node builtins remain host dependencies supplied by
      // buildImports; standalone/WASI ESLint is not this rung (#3653).
      const r = await compileProject(entry, { allowJs: true, target: "gc", platform: "node" });
      expect(r.success, r.errors.map((error) => error.message).join("\n")).toBe(true);
      if (!r.success) return;
      const imps = buildImports(r.imports as never, undefined, r.stringPool);
      const inst = await WebAssembly.instantiate(r.binary, imps as never);
      (imps as { setInstance?: Function }).setInstance?.(inst.instance);
      const ret = (inst.instance.exports as { test: () => unknown }).test();
      expect(ret).toBe(0); // [].length === 0
    });
  },
);
