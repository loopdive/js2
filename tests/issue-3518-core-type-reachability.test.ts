// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repository = resolve(import.meta.dirname, "..");
const checker = resolve(repository, "scripts/audit-legacy-reachability.mjs");
const core = [
  "irVal",
  "irVec",
  "irFnctor",
  "asVal",
  "irDynamic",
  "irTypeEquals",
  "classShapeEquals",
  "closureSignatureEquals",
  "objectShapeEquals",
  "tagRefinementEquals",
];
const queue = ["buildGrowLocals", "buildGrowBody", "buildEnqueueBody", "buildDrainLocals", "buildDrainBody"];
const types = "src/ir/core/types.ts";
const tags = "src/ir/core/tag-refinement.ts";
const consumer = "src/ir/consumer.ts";
const calls = core.map((name) => `${name}();`).join(" ");
const imports = `import { ${core.join(", ")} } from './nodes.js';`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(open = false) {
  const root = mkdtempSync(resolve(tmpdir(), "js2-core-callers-"));
  roots.push(root);
  const put = (file: string, text: string) => {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), text);
  };
  put("scripts/dead-export-baseline.json", "[]");
  put(
    types,
    core
      .slice(0, 9)
      .map((name) => `export function ${name}() { return 0; }`)
      .join("\n"),
  );
  put(tags, "export function tagRefinementEquals() { return true; }");
  put(
    "src/ir/nodes.ts",
    `export { ${core.slice(0, 9).join(", ")} } from './core/types.js'; export { tagRefinementEquals } from './core/tag-refinement.js';`,
  );
  put(consumer, `${imports} export function coreConsumer() { ${calls} }`);
  put(
    "src/runtime/wasmgc/async/microtask-queue-bodies.ts",
    queue.map((name) => `export function ${name}() { return []; }`).join("\n"),
  );
  put("src/wasm/physical/function-handles.ts", "export function inLiveShiftRange() { return true; }");
  put(
    "src/codegen/prepared-native-async-runtime.ts",
    `export { ${queue.join(", ")} } from '../runtime/wasmgc/async/microtask-queue-bodies.js';`,
  );
  put("src/emit/resolve-layout.ts", "export { inLiveShiftRange } from '../wasm/physical/function-handles.js';");
  put(
    "src/codegen/index.ts",
    `import { ${queue.join(", ")} } from './prepared-native-async-runtime.js'; import { inLiveShiftRange } from '../emit/resolve-layout.js'; export function generateModule() { ${queue.map((name) => `${name}();`).join(" ")} inLiveShiftRange(); }`,
  );
  put("src/codegen/statements.ts", "export function compileStatement() { return 0; }");
  put("src/codegen/expressions.ts", "export function compileExpression() { return 0; }");
  let extensionImports = "";
  let extensionCalls = "";
  if (open) {
    put(
      "src/optimize.ts",
      'export async function getBinaryenModule() { const globalObject = globalThis as any; const specifier = (globalObject.__js2wasmBinaryenModuleSpecifier as string | undefined) ?? "binaryen"; return import(/* @vite-ignore */ specifier); }',
    );
    put(
      "src/runtime/platform-capability-adapter.ts",
      'export function resolvePlatformCapabilityImport(intent: { type: string }) { switch (intent.type) { case "dynamic_import": return (specifier: unknown) => import(/* @vite-ignore */ specifier as string); default: return undefined; } }',
    );
    const manifest = JSON.parse(
      readFileSync(resolve(repository, "scripts/compiler-extension-boundaries.json"), "utf8"),
    );
    for (const record of manifest.records) {
      const bytes = readFileSync(resolve(root, record.source));
      record.contentHash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    }
    put("scripts/compiler-extension-boundaries.json", JSON.stringify(manifest));
    extensionImports =
      "import { getBinaryenModule } from './optimize.js'; import { resolvePlatformCapabilityImport } from './runtime/platform-capability-adapter.js';";
    extensionCalls = 'getBinaryenModule(); resolvePlatformCapabilityImport({type:"dynamic_import"});';
  }
  const entry = (extra = "", body = "coreConsumer();") =>
    `import { generateModule } from './codegen/index.js'; import { coreConsumer } from './ir/consumer.js'; ${extensionImports} ${extra} export function compile() { generateModule(); ${extensionCalls} ${body} }`;
  put("src/index.ts", entry());
  const run = (required = true, preservation = open) => {
    const reportFile = resolve(root, "report.json");
    const result = spawnSync(
      process.execPath,
      [
        checker,
        "--root",
        root,
        "--check",
        "--json",
        reportFile,
        ...(required ? ["--require-core-types"] : []),
        ...(preservation ? ["--moved-reference-contract=preservation-v1"] : []),
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    const moved = JSON.parse(readFileSync(reportFile, "utf8")).movedRuntime;
    return { exit: result.status, output: result.stdout + result.stderr, moved, core: moved.coreTypes };
  };
  return { root, put, entry, run };
}

function positive(f: ReturnType<typeof fixture>) {
  const r = f.run();
  expect(r.exit, r.output).toBe(0);
  expect(r.moved.functions).toHaveLength(6);
  expect(r.core).toEqual(
    expect.objectContaining({
      required: true,
      assessed: true,
      expectedSymbols: 10,
      fullWitnessCount: 10,
      cutWitnessCount: 10,
      failures: [],
      ok: true,
    }),
  );
  expect(r.core.functions).toHaveLength(10);
  for (const fn of r.core.functions) {
    expect(fn.fullProductionPath[0]).toBe("src/index.ts#compile");
    expect(fn.legacyDispatchCutPath[0]).toBe("src/index.ts#compile");
    expect(fn.fullProductionPath.at(-1)).toBe(fn.canonical);
  }
  return r;
}

describe("#3518 additive core caller preservation contract", () => {
  it.each([
    `( () => { ${calls} } )`,
    `( function () { ${calls} } )`,
    `( () => { ${calls} } ) as () => void`,
    `<() => void>( () => { ${calls} } )`,
    `( () => { ${calls} } ) satisfies () => void`,
    `( () => { ${calls} } )!`,
  ])("does not root an unused wrapped callable: %s", (initializer) => {
    const f = fixture();
    positive(f);
    f.put(consumer, `${imports} const unused = ${initializer}; export function coreConsumer() {}`);
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.core.fullWitnessCount).toBe(0);
    f.put(consumer, `${imports} const unused = ${initializer}; export function coreConsumer() { unused(); }`);
    positive(f);
  });
  it("requires the fixed group in the actual package command", () => {
    const command = JSON.parse(readFileSync(resolve(repository, "package.json"), "utf8")).scripts["check:dead-exports"];
    expect(command).toBe(
      "node scripts/audit-legacy-reachability.mjs --check --moved-reference-contract=preservation-v1 --require-core-types --require-core-nodes",
    );
  });
  it("keeps six N1 targets and ten distinct canonical class-free witnesses", () => {
    positive(fixture());
  });
  it("does not assess or claim core success when running only the historical contract", () => {
    const r = fixture().run(false);
    expect(r.exit, r.output).toBe(0);
    expect(r.core).toEqual(
      expect.objectContaining({
        required: false,
        assessed: false,
        ok: null,
        fullWitnessCount: null,
        cutWitnessCount: null,
        functions: [],
      }),
    );
    expect(r.output).toContain("not required / not assessed");
  });
  it("conjoins core preservation with the approved open receipts while strict closure still fails", () => {
    const f = fixture(true);
    const r = positive(f);
    expect(r.moved.preservation.expectedSymbols).toBe(6);
    expect(r.moved.preservation.receipts).toHaveLength(2);
    expect(r.moved.preservation.ok).toBe(true);
    expect(r.moved.ok).toBe(false);
    expect(f.run(true, false).exit).toBe(1);
    f.put(consumer, "export function coreConsumer() {}");
    const lost = f.run();
    expect(lost.exit).toBe(1);
    expect(lost.moved.preservation.ok).toBe(false);
    expect(lost.core.ok).toBe(false);
  });
  it("cannot deactivate the group by deleting every canonical destination", () => {
    const f = fixture();
    positive(f);
    rmSync(resolve(f.root, types));
    rmSync(resolve(f.root, tags));
    const r = f.run();
    expect(r.exit).toBe(1);
    expect(r.core.functions).toHaveLength(10);
    expect(r.core.fullWitnessCount).toBe(0);
  });
  it("rejects an old-path duplicate instead of substituting it for a canonical target", () => {
    const f = fixture();
    positive(f);
    f.put("src/ir/nodes.ts", core.map((name) => `export function ${name}() { return 0; }`).join("\n"));
    const r = f.run();
    expect(r.exit).toBe(1);
    expect(r.core.fullWitnessCount).toBe(0);
    expect(r.core.failures.join(" ")).toContain("duplicate core implementation");
  });
  it.each(core)("fails when the bound real %s consumer is removed", (name) => {
    const f = fixture();
    positive(f);
    f.put(consumer, `${imports} export function coreConsumer() { ${calls.replace(`${name}();`, "")} }`);
    const r = f.run();
    expect(r.exit).toBe(1);
    expect(r.core.fullWitnessCount).toBe(9);
  });
  it("rejects a renamed/shadowing local despite an unchanged import", () => {
    const f = fixture();
    positive(f);
    f.put(consumer, `${imports} export function coreConsumer() { function irVal() {} ${calls} }`);
    expect(f.run().core.fullWitnessCount).toBe(9);
    expect(f.run().exit).toBe(1);
  });
  it("does not accept exports or test-only references as production callers", () => {
    const f = fixture();
    positive(f);
    f.put(consumer, `${imports} export { ${core.join(", ")} }; export function coreConsumer() {}`);
    f.put("tests/callers.ts", `${imports} ${calls}`);
    const r = f.run();
    expect(r.exit).toBe(1);
    expect(r.core.fullWitnessCount).toBe(0);
  });
  it("requires cut paths even when all ten remain reachable through direct dispatch", () => {
    const f = fixture();
    positive(f);
    f.put(
      "src/codegen/statements.ts",
      "import { coreConsumer } from '../ir/consumer.js'; export function compileStatement() { coreConsumer(); }",
    );
    f.put(
      "src/index.ts",
      f.entry("import { compileStatement } from './codegen/statements.js';", "compileStatement();"),
    );
    const r = f.run();
    expect(r.exit).toBe(1);
    expect(r.core.fullWitnessCount).toBe(10);
    expect(r.core.cutWitnessCount).toBe(0);
  });
  it.each([
    [
      "class declaration",
      `${imports} class Unused { method() { ${calls} } } export function coreConsumer() { return Unused; }`,
    ],
    [
      "class expression",
      `${imports} const Unused = class { method() { ${calls} } }; export function coreConsumer() { return Unused; }`,
    ],
    [
      "nested class",
      `${imports} export function coreConsumer() { class Unused { method() { ${calls} } } return Unused; }`,
    ],
  ])("does not turn visiting an unused %s into ten callers", (_kind, source) => {
    const f = fixture();
    positive(f);
    f.put(consumer, source);
    const r = f.run();
    expect(r.exit).toBe(1);
    expect(r.core.fullWitnessCount).toBe(0);
  });
  it("keeps a separate eligible reference when the same owner also contains unused class references", () => {
    const f = fixture();
    f.put(
      consumer,
      `${imports} export function coreConsumer() { class Unused { method() { ${calls} } } ${calls} return Unused; }`,
    );
    positive(f);
  });
});
