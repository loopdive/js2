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

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { compileProject } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";
import { ESLINT_DEV_DEPENDENCY_SKIP, requireEslintFile, resolveEslintFile } from "../helpers/eslint.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const execFileAsync = promisify(execFile);
// Tier 1 entry files live in `.tmp/` (gitignored). Each test writes its own
// fresh entry to avoid stale-cache surprises across vitest worker pools.
const TMP_DIR = resolve(__dirname, "../../.tmp/eslint-tier1");
const ESLINT_LINTER = resolveEslintFile("lib/linter/linter.js");
const COMPILE_PROJECT_PROBE = resolve(__dirname, "../helpers/compile-project-probe.ts");
const COMPILE_PROJECT_PROBE_MARKER = "__JS2_COMPILE_PROJECT_PROBE__";

interface CompileProjectProbe {
  success: boolean;
  binaryByteLength: number;
  valid: boolean;
  errors: Array<{ message: string }>;
}

let tier1EntryCompile: Promise<CompileProjectProbe> | null = null;

function writeEntry(name: string, src: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const p = join(TMP_DIR, name);
  writeFileSync(p, src);
  return p;
}

function compileTier1Entry(): Promise<CompileProjectProbe> {
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
    tier1EntryCompile = execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        COMPILE_PROJECT_PROBE,
        entry,
        JSON.stringify({ allowJs: true, target: "gc", platform: "node" }),
      ],
      {
        cwd: resolve(__dirname, "../.."),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    ).then(({ stdout }) => {
      const marker = stdout.lastIndexOf(COMPILE_PROJECT_PROBE_MARKER);
      if (marker === -1) {
        throw new Error(`compileProject probe emitted no structured report:\n${stdout}`);
      }
      return JSON.parse(stdout.slice(marker + COMPILE_PROJECT_PROBE_MARKER.length).trim()) as CompileProjectProbe;
    });
  }
  return tier1EntryCompile;
}

describe.skipIf(ESLINT_LINTER === null)(
  `#1282 ESLint Tier 1 — minimal Linter.verify() ${ESLINT_DEV_DEPENDENCY_SKIP}`,
  () => {
    /**
     * Tier 1a — run the real package-entry graph in the Node-host JS lane.
     * #3654 restores the resolver layer, but the expanded graph does not yet
     * complete inside this test's compile budget (#3672). The independent
     * dynamic object-destructuring invariant was removed by #3656.
     */
    it.skip('Tier 1a — package entry reaches the #3672 frontier for `import { Linter } from "eslint"`', async () => {
      const r = await compileTier1Entry();
      const diagnostics = r.errors.map((error) => error.message).join("\n");
      expect(r.success).toBe(false);
      expect(r.binaryByteLength).toBe(0);
      expect(diagnostics).not.toContain("Cannot find module");
      expect(diagnostics).not.toContain("object destructuring source must be IrType.object or IrType.class");
    }, 180_000);

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
