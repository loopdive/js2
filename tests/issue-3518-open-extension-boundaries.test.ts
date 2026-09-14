// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = resolve(repository, "scripts/audit-legacy-reachability.mjs");
const manifestPath = "scripts/compiler-extension-boundaries.json";
const reviewedManifest = JSON.parse(readFileSync(resolve(repository, manifestPath), "utf8"));
const optimizer = "src/optimize.ts";
const platform = "src/runtime/platform-capability-adapter.ts";
const canonicalQueue = "src/runtime/wasmgc/async/microtask-queue-bodies.ts";
const originalQueue = "src/codegen/prepared-native-async-runtime.ts";
const canonicalHandle = "src/wasm/physical/function-handles.ts";
const originalHandle = "src/emit/resolve-layout.ts";
const builders = ["buildGrowLocals", "buildGrowBody", "buildEnqueueBody", "buildDrainLocals", "buildDrainBody"];
const symbols = [...builders, "inLiveShiftRange"];
const roots: string[] = [];
const hash = (text: string) => {
  const bytes = Buffer.from(text);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};
const optimizerSource = `export async function getBinaryenModule() {
  const globalObject = globalThis as any;
  const specifier = (globalObject.__js2wasmBinaryenModuleSpecifier as string | undefined) ?? "binaryen";
  return import(/* @vite-ignore */ specifier);
}`;
const platformSource = `export function resolvePlatformCapabilityImport(intent: { type: string }) {
  switch (intent.type) {
    case "dynamic_import": return (specifier: unknown) => import(/* @vite-ignore */ specifier as string);
    default: return undefined;
  }
}`;

function run(root: string, staged = true, extra: string[] = []) {
  const output = mkdtempSync(resolve(tmpdir(), "js2-open-report-"));
  roots.push(output);
  const reportFile = resolve(output, "report.json");
  const result = spawnSync(
    process.execPath,
    [
      checker,
      "--root",
      root,
      "--check",
      "--json",
      reportFile,
      ...(staged ? ["--moved-reference-contract=preservation-v1"] : []),
      ...extra,
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  let report: any;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8"));
  } catch {
    /* CLI parse failures have no scanner report. */
  }
  return { exit: result.status, output: result.stdout + result.stderr, m: report?.movedRuntime };
}

function fixture(relocated = true) {
  const root = mkdtempSync(resolve(tmpdir(), "js2-open-boundaries-"));
  roots.push(root);
  const put = (file: string, source: string) => {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), source);
  };
  const read = (file: string) => readFileSync(resolve(root, file), "utf8");
  const manifest = structuredClone(reviewedManifest);
  const saveManifest = () => put(manifestPath, JSON.stringify(manifest));
  // Fixture-authored expected digests, never an auditor auto-refresh. Individual
  // adversarial controls deliberately rebind a changed fixture to test the AST
  // guard independently of the whole-file digest guard.
  const bindFixtureBytes = () => {
    for (const record of manifest.records) record.contentHash = hash(read(record.source));
    saveManifest();
  };
  const scheduler = (consumers = symbols) => `
    import { ${builders.join(", ")} } from "${relocated ? "../runtime/wasmgc/async/microtask-queue-bodies.js" : "./prepared-native-async-runtime.js"}";
    import { inLiveShiftRange } from "../emit/resolve-layout.js";
    export function ensureScheduler() { ${consumers.map((name) => `${name}();`).join(" ")} }
  `;
  const entry = (body = "", includeAdapters = true) => `
    import { generateModule } from "./codegen/index.js";
    import { getBinaryenModule } from "./optimize.js";
    import { resolvePlatformCapabilityImport } from "./runtime/platform-capability-adapter.js";
    export function compile(specifier: string) {
      ${includeAdapters ? 'getBinaryenModule(); resolvePlatformCapabilityImport({ type: "dynamic_import" });' : ""}
      ${body}
      return generateModule();
    }
  `;
  put(optimizer, optimizerSource);
  put(platform, platformSource);
  put("scripts/dead-export-baseline.json", "[]");
  put("src/index.ts", entry());
  put(
    "src/codegen/index.ts",
    'import { ensureScheduler } from "./async-scheduler.js"; export function generateModule() { return ensureScheduler(); }',
  );
  put(
    "src/codegen/statements.ts",
    'import { ensureScheduler } from "./async-scheduler.js"; export function compileStatement() { return ensureScheduler(); }',
  );
  put("src/codegen/expressions.ts", "export function compileExpression() { return 0; }");
  put("src/codegen/async-scheduler.ts", scheduler());
  put(
    relocated ? canonicalQueue : originalQueue,
    builders.map((name) => `export function ${name}() { return []; }`).join("\n"),
  );
  put(relocated ? canonicalHandle : originalHandle, "export function inLiveShiftRange() { return false; }");
  if (relocated) {
    put(originalQueue, `export { ${builders.join(", ")} } from "../runtime/wasmgc/async/microtask-queue-bodies.js";`);
    put(originalHandle, 'export { inLiveShiftRange } from "../wasm/physical/function-handles.js";');
  }
  bindFixtureBytes();
  return {
    root,
    put,
    read,
    entry,
    scheduler,
    manifest,
    saveManifest,
    bindFixtureBytes,
    run: (staged = true, extra: string[] = []) => run(root, staged, extra),
  };
}

function sixWitnesses(m: any) {
  expect(m.functions).toHaveLength(6);
  expect(m.functions.filter((fn: any) => fn.fullProductionPath)).toHaveLength(6);
}
function unknowns(m: any) {
  return m.moduleLoads.filter((load: any) => load.status === "unknown");
}

// A downstream consumer must validate evidence, not infer retirement from a
// package exit code. These checks exercise the serialized report, including
// tampered copies, without substituting a mocked graph for the real auditor.
function verifyPreservationEvidence(m: any) {
  expect(m.closureCertified).toBe(false);
  expect(m.retirementCertified).toBe(false);
  expect(m.externalResolutionIsRuntimeClosure).toBe(false);
  expect(m.preservation.scope).toBe("source-reference-preservation-only");
  expect(m.preservation.contract).toBe("preservation-v1");
  expect(m.preservation.ok).toBe(true);
  expect(m.preservation.oldRatchet.unchanged).toBe(true);
  sixWitnesses(m);
  expect(m.preservation.fullWitnessCount).toBe(6);
  expect(m.preservation.cutWitnessCount).toBe(6);
  expect(m.preservation.receipts).toHaveLength(2);
  for (const receipt of m.preservation.receipts) {
    expect(receipt.strictFailureExemption).toBe(false);
    expect(receipt.mayEnterRepository).toBe(true);
    if (receipt.fullReachable) {
      expect(m.moduleLoads).toContainEqual(
        expect.objectContaining({ siteId: receipt.siteId, status: "unknown", target: null, specifier: null }),
      );
      expect(m.diagnostics).toContainEqual(
        expect.objectContaining({ id: receipt.diagnosticId, siteId: receipt.siteId }),
      );
      expect(m.ok).toBe(false);
    }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("#3518 preservation and two reviewed open extension sites", () => {
  it("keeps closed modeled-source acceptance separate from universal retirement", () => {
    const f = fixture();
    f.put("src/index.ts", f.entry("", false));
    for (const staged of [false, true]) {
      const result = f.run(staged);
      expect(result.exit, result.output).toBe(0);
      expect(result.m.ok).toBe(true);
      expect(unknowns(result.m)).toHaveLength(0);
      verifyPreservationEvidence(result.m);
      expect(result.m.preservation.receipts.every((receipt: any) => !receipt.fullReachable)).toBe(true);
    }
  });

  it("selects only preservation; strict failure, raw unknowns and cut evidence survive serialization", () => {
    const f = fixture();
    const strict = f.run(false);
    const staged = f.run();
    expect(strict.exit).toBe(1);
    expect(staged.exit, staged.output).toBe(0);
    expect(staged.m.ok).toBe(false);
    expect(staged.m.failures).toEqual(strict.m.failures);
    expect(staged.m.moduleLoads).toEqual(strict.m.moduleLoads);
    expect(unknowns(staged.m)).toHaveLength(2);
    expect(staged.m.legacyDispatchCut.moduleLoads.filter((load: any) => load.status === "unknown")).toHaveLength(2);
    expect(staged.m.preservation.receipts.map((receipt: any) => receipt.defaultSpecifier)).toEqual(["binaryen", null]);
    verifyPreservationEvidence(staged.m);
    expect(staged.output).toContain("preservation-only PASS: 6/6 full source witnesses, 6/6 cut witnesses");
    expect(staged.output).toContain("graph OPEN");
    expect(staged.output).toContain("retirement/deletion NOT CERTIFIED");
    expect(staged.output).not.toContain("gate: OK");
  });

  it("preserves all original/canonical witnesses before and after relocation", () => {
    const before = fixture(false).run();
    const after = fixture().run();
    expect(before.exit, before.output).toBe(0);
    expect(after.exit, after.output).toBe(0);
    for (const [index, fn] of after.m.functions.entries()) {
      expect(fn.target).toBe(fn.canonical);
      expect(before.m.functions[index].target).toBe(fn.original);
      expect(fn.legacyDispatchCutPath?.[0]).toBe("src/index.ts#compile");
      expect(before.m.functions[index].legacyDispatchCutPath?.[0]).toBe("src/index.ts#compile");
    }
  });

  for (const load of ["import(specifier)", "require(specifier)"]) {
    it(`rejects an unrelated ${load} with six live targets in both modes`, () => {
      const f = fixture();
      f.put("src/index.ts", f.entry(`${load};`, false));
      for (const staged of [false, true]) {
        const result = f.run(staged);
        expect(result.exit).toBe(1);
        sixWitnesses(result.m);
        expect(result.m.preservation.ok).toBe(false);
        expect(unknowns(result.m)).toHaveLength(1);
      }
    });
  }

  for (const symbol of symbols) {
    it(`cannot replace the missing ${symbol} consumer with a receipt`, () => {
      const f = fixture();
      f.put("src/codegen/async-scheduler.ts", f.scheduler(symbols.filter((name) => name !== symbol)));
      const result = f.run();
      expect(result.exit).toBe(1);
      expect(result.m.functions).toHaveLength(6);
      expect(result.m.functions.filter((fn: any) => fn.fullProductionPath)).toHaveLength(5);
      expect(unknowns(result.m)).toHaveLength(2);
      expect(
        result.m.preservation.failures.some((failure: string) => failure.includes("no production reference path")),
      ).toBe(true);
    });
  }

  for (const surface of ["none", "tests", "reexports"]) {
    it(`rejects all removed consumers with only ${surface} remaining`, () => {
      const f = fixture();
      f.put("src/codegen/async-scheduler.ts", f.scheduler([]));
      if (surface === "tests")
        f.put(
          "tests/provider.test.ts",
          `import { ${builders.join(", ")} } from "../${canonicalQueue}"; ${builders.map((name) => `${name}();`).join(" ")}`,
        );
      if (surface === "reexports")
        f.put(
          "src/index.ts",
          f.entry() + `\nexport { ${builders.join(", ")} } from "./runtime/wasmgc/async/microtask-queue-bodies.js";`,
        );
      const result = f.run();
      expect(result.exit).toBe(1);
      expect(result.m.functions).toHaveLength(6);
      expect(result.m.functions.every((fn: any) => !fn.fullProductionPath)).toBe(true);
    });
  }

  it("rejects a public export binding redirected away from the same-spelled local root", () => {
    const f = fixture();
    f.put(
      "src/index.ts",
      f.entry().replace("export function compile", "function compile") + "\nexport { getBinaryenModule as compile };",
    );
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.m.preservation.ok).toBe(false);
    expect(result.m.failures.some((failure: string) => failure.includes("does not resolve to root"))).toBe(true);
  });

  it("accepts a public export binding to the actual local compile declaration", () => {
    const f = fixture();
    f.put("src/index.ts", f.entry().replace("export function compile", "function compile") + "\nexport { compile };");
    const result = f.run();
    expect(result.exit, result.output).toBe(0);
    sixWitnesses(result.m);
  });

  for (const mutation of [
    "rename-target",
    "delete-target",
    "duplicate-body",
    "rename-root",
    "remove-export",
    "alias-root",
    "lost-cut",
  ]) {
    it(`fails integrity control ${mutation} with receipts retained`, () => {
      const f = fixture();
      if (mutation === "rename-target")
        f.put(canonicalQueue, f.read(canonicalQueue).replace("function buildGrowBody", "function renamed"));
      if (mutation === "delete-target") rmSync(resolve(f.root, canonicalQueue));
      if (mutation === "duplicate-body") f.put(originalQueue, f.read(canonicalQueue));
      if (mutation === "rename-root")
        f.put("src/index.ts", f.entry().replace("function compile(", "function renamedCompile("));
      if (mutation === "remove-export")
        f.put("src/index.ts", f.entry().replace("export function compile", "function compile"));
      if (mutation === "alias-root")
        f.put(
          "src/index.ts",
          f.entry().replace("export function compile", "function renamedCompile") +
            "\nexport { renamedCompile as compile };",
        );
      if (mutation === "lost-cut")
        f.put(
          "src/codegen/index.ts",
          'import { compileStatement } from "./statements.js"; export function generateModule() { return compileStatement(); }',
        );
      const result = f.run();
      expect(result.exit).toBe(1);
      expect(result.m.functions).toHaveLength(6);
      expect(result.m.preservation.ok).toBe(false);
      if (mutation === "lost-cut") {
        sixWitnesses(result.m);
        expect(result.m.preservation.cutWitnessCount).toBe(0);
      }
    });
  }

  for (const mutation of [
    "missing-A",
    "missing-B",
    "duplicate",
    "swapped-hashes",
    "swapped-anchors",
    "same-site",
    "forged-external",
    "extra-field",
    "malformed",
    "missing-manifest",
  ]) {
    it(`fails receipt control ${mutation}`, () => {
      const f = fixture();
      if (mutation === "missing-A") f.manifest.records.shift();
      if (mutation === "missing-B") f.manifest.records.pop();
      if (mutation === "duplicate") f.manifest.records[1] = structuredClone(f.manifest.records[0]);
      if (mutation === "swapped-hashes")
        [f.manifest.records[0].contentHash, f.manifest.records[1].contentHash] = [
          f.manifest.records[1].contentHash,
          f.manifest.records[0].contentHash,
        ];
      if (mutation === "swapped-anchors")
        [f.manifest.records[0].anchor, f.manifest.records[1].anchor] = [
          f.manifest.records[1].anchor,
          f.manifest.records[0].anchor,
        ];
      if (mutation === "same-site") f.manifest.records[1].source = optimizer;
      if (mutation === "forged-external") f.manifest.records[0].mayEnterRepository = false;
      if (mutation === "extra-field") f.manifest.records[0].ignoreDirectory = "src";
      f.saveManifest();
      if (mutation === "malformed") f.put(manifestPath, "{");
      if (mutation === "missing-manifest") rmSync(resolve(f.root, manifestPath));
      const result = f.run();
      expect(result.exit).toBe(1);
      sixWitnesses(result.m);
      expect(result.m.preservation.ok).toBe(false);
    });
  }

  for (const source of [optimizer, platform]) {
    for (const mutation of ["delete", "move", "comment"]) {
      it(`fails changed source ${source}: ${mutation}`, () => {
        const f = fixture();
        if (mutation === "comment") f.put(source, f.read(source) + "\n// changed reviewed bytes\n");
        else {
          if (mutation === "move") f.put(source.replace(".ts", "-moved.ts"), f.read(source));
          rmSync(resolve(f.root, source));
        }
        expect(f.run().exit).toBe(1);
      });
    }
  }

  for (const [source, before, after] of [
    [optimizer, '?? "binaryen"', '?? "other"'],
    [optimizer, "globalThis as any", "({}) as any"],
    [optimizer, "__js2wasmBinaryenModuleSpecifier", "otherOverride"],
    [optimizer, "specifier);", "globalObject);"],
    [optimizer, "getBinaryenModule()", "getBinaryenModule(globalThis: any)"],
    [platform, 'case "dynamic_import"', 'case "other"'],
    [platform, "specifier as string", "intent.type"],
    [platform, "(specifier: unknown)", "(renamed: unknown)"],
    [platform, "switch (intent.type)", "switch (({} as any).type)"],
  ]) {
    it(`requires the bound AST site even with a matching fixture digest: ${before}`, () => {
      const f = fixture();
      f.put(source, f.read(source).replace(before, after));
      f.bindFixtureBytes();
      const result = f.run();
      expect(result.exit).toBe(1);
      expect(result.m.preservation.failures.some((failure: string) => failure.includes("bound AST site"))).toBe(true);
    });
  }

  for (const where of ["optimizer", "platform", "sibling", "initializer"]) {
    it(`rejects a third unknown in ${where}, including another site in a reviewed owner`, () => {
      const f = fixture();
      if (where === "optimizer")
        f.put(
          optimizer,
          optimizerSource.replace("return import(", 'import("file:" + String(globalObject)); return import('),
        );
      if (where === "platform")
        f.put(platform, platformSource.replace("switch (intent.type)", "import(intent.type); switch (intent.type)"));
      if (where === "sibling") {
        f.put("src/sibling.ts", "export function sibling(specifier: string) { return import(specifier); }");
        f.put("src/index.ts", 'import { sibling } from "./sibling.js";\n' + f.entry("sibling(specifier);"));
      }
      if (where === "initializer") {
        f.put("src/loaded.ts", 'const specifier = "./unknown.js"; import(specifier);');
        f.put("src/index.ts", f.entry('import("./loaded.js");'));
      }
      f.bindFixtureBytes();
      const result = f.run();
      expect(result.exit).toBe(1);
      sixWitnesses(result.m);
      expect(unknowns(result.m)).toHaveLength(3);
      expect(result.m.preservation.receipts).toHaveLength(2);
      const loadDiagnostics = result.m.diagnostics.filter((diagnostic: any) => diagnostic.siteId !== null);
      expect(loadDiagnostics).toHaveLength(3);
      expect(new Set(loadDiagnostics.map((diagnostic: any) => diagnostic.id)).size).toBe(3);
      expect(result.m.preservation.failures.some((failure: string) => failure.includes("unknown nonliteral"))).toBe(
        true,
      );
    });
  }

  it("cannot use a possible provider's repository reentry to restore a lost caller", () => {
    const f = fixture();
    f.put(
      "src/provider.ts",
      'import { buildGrowBody } from "./runtime/wasmgc/async/microtask-queue-bodies.js"; buildGrowBody();',
    );
    f.put("tests/provider.test.ts", 'import "../src/provider.js";');
    f.put("src/codegen/async-scheduler.ts", f.scheduler(symbols.filter((name) => name !== "buildGrowBody")));
    f.put("src/index.ts", f.entry('globalThis.__js2wasmBinaryenModuleSpecifier = "./provider.js";'));
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.m.functions.find((fn: any) => fn.target.endsWith("#buildGrowBody")).fullProductionPath).toBeNull();
    expect(unknowns(result.m).every((load: any) => load.target === null)).toBe(true);
  });

  it("keeps installed package declarations distinct from executable closure", () => {
    const f = fixture();
    f.put("node_modules/gate-provider/package.json", '{"name":"gate-provider","types":"index.d.ts"}');
    f.put("node_modules/gate-provider/index.d.ts", "export function invoke(): void;");
    f.put("src/index.ts", f.entry('import("gate-provider");'));
    const result = f.run();
    expect(result.exit, result.output).toBe(0);
    expect(result.m.moduleLoads).toContainEqual(
      expect.objectContaining({ specifier: "gate-provider", status: "resolved-external" }),
    );
    verifyPreservationEvidence(result.m);
    expect(result.m.ok).toBe(false);
  });

  for (const appearance of [
    "file:///tmp/provider.js",
    "https://example.invalid/provider.js",
    "gate-provider",
    "./provider-link.js",
  ]) {
    it(`does not fabricate an external target from provider spelling ${appearance}`, () => {
      const f = fixture();
      f.put("src/provider.ts", "export const value = 1;");
      symlinkSync(resolve(f.root, "src/provider.ts"), resolve(f.root, "src/provider-link.ts"));
      f.put("src/index.ts", f.entry(`globalThis.__js2wasmBinaryenModuleSpecifier = ${JSON.stringify(appearance)};`));
      const result = f.run();
      expect(result.exit, result.output).toBe(0);
      verifyPreservationEvidence(result.m);
      expect(unknowns(result.m).every((load: any) => load.specifier === null && load.target === null)).toBe(true);
    });
  }

  for (const extra of [
    "--moved-reference-contract=typo",
    "--moved-reference-contract=declared-open-boundaries-v1",
    "--unknown-flag",
  ]) {
    it(`fails unsupported CLI contract ${extra}`, () => {
      const result = fixture().run(false, [extra]);
      expect(result.exit).not.toBe(0);
      expect(result.m).toBeUndefined();
    });
  }

  it("fails an empty graph and missing source instead of a missing-report success", () => {
    const f = fixture();
    rmSync(resolve(f.root, "src"), { recursive: true });
    mkdirSync(resolve(f.root, "src"));
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.m.fullProduction.reachableNodes).toBe(0);
    expect(result.m.preservation.ok).toBe(false);
  });

  it("retains new-dead-export and baseline-integrity failures in both modes", () => {
    const f = fixture();
    f.put("src/codegen/dead.ts", "export function newDeadExport() { return 0; }");
    for (const staged of [false, true]) {
      const result = f.run(staged);
      expect(result.exit).toBe(1);
      expect(result.m.preservation.oldRatchet.added).toEqual(["src/codegen/dead.ts#newDeadExport"]);
      expect(result.m.preservation.ok).toBe(false);
    }
    f.put("scripts/dead-export-baseline.json", "{}");
    expect(f.run().exit).toBe(1);
  });

  it("rejects staged success as retirement evidence, including corrupted serialized reports", () => {
    const result = fixture().run();
    expect(result.exit, result.output).toBe(0);
    verifyPreservationEvidence(result.m);
    expect(result.m.ok && result.m.retirementCertified && result.m.closureCertified).toBe(false);
    for (const corrupt of [
      (m: any) => {
        m.moduleLoads = [];
      },
      (m: any) => {
        Reflect.deleteProperty(m, "retirementCertified");
      },
      (m: any) => {
        m.preservation.scope = "retirement";
      },
      (m: any) => {
        m.ok = true;
      },
      (m: any) => {
        m.preservation = { ok: true };
      },
    ]) {
      const edited = structuredClone(result.m);
      corrupt(edited);
      expect(() => verifyPreservationEvidence(edited)).toThrow();
    }
  });

  it("measures cut unknowns separately without dropping the full-root unknowns", () => {
    const f = fixture();
    f.put(
      "src/index.ts",
      f.entry("compileStatement();", false) + '\nimport { compileStatement } from "./codegen/statements.js";',
    );
    f.put(
      "src/codegen/statements.ts",
      'import { getBinaryenModule } from "../optimize.js"; import { resolvePlatformCapabilityImport } from "../runtime/platform-capability-adapter.js"; export function compileStatement() { getBinaryenModule(); resolvePlatformCapabilityImport({ type: "dynamic_import" }); }',
    );
    const result = f.run();
    expect(result.exit, result.output).toBe(0);
    expect(unknowns(result.m)).toHaveLength(2);
    expect(result.m.legacyDispatchCut.moduleLoads.filter((load: any) => load.status === "unknown")).toHaveLength(0);
    expect(result.m.preservation.receipts.every((receipt: any) => receipt.fullReachable && !receipt.cutReachable)).toBe(
      true,
    );
    expect(result.m.ok).toBe(false);
  });

  it("binds both reviewed production source blobs to the real scanner's AST sites", () => {
    const result = run(repository);
    expect(result.m, result.output).toBeDefined();
    expect(result.m.preservation.receipts.map((receipt: any) => receipt.contentHash)).toEqual([
      "13ee034af6c141c44f67ef36744481d1c6e2b1b9",
      "ea5e10a98f23e1cdacb50f190feb9a7011453162",
    ]);
    expect(result.m.preservation.receipts.map((receipt: any) => receipt.id)).toEqual([
      "optional-binaryen-provider-v1",
      "platform-dynamic-import-v1",
    ]);
    expect(result.m.ok).toBe(false);
    expect(result.m.retirementCertified).toBe(false);
  });
});
