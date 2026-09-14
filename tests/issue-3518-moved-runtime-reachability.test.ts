// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = resolve(repository, "scripts/audit-legacy-reachability.mjs");
const temporaryRoots: string[] = [];
const builders = ["buildGrowLocals", "buildGrowBody", "buildEnqueueBody", "buildDrainLocals", "buildDrainBody"];
const oldQueue = "src/codegen/prepared-native-async-runtime.ts";
const newQueue = "src/runtime/wasmgc/async/microtask-queue-bodies.ts";
const oldHandle = "src/emit/resolve-layout.ts";
const newHandle = "src/wasm/physical/function-handles.ts";
const declarations = builders.map((name) => `export function ${name}() { return []; }`).join("\n");

interface MovedFunction {
  original: string;
  canonical: string;
  target: string;
  fullProductionPath: string[] | null;
  legacyDispatchCutPath: string[] | null;
  classification: string;
}

function fixture(relocated = true) {
  const root = mkdtempSync(resolve(tmpdir(), "js2-moved-runtime-"));
  temporaryRoots.push(root);
  const put = (file: string, text: string) => {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), text);
  };
  const queueImport = relocated
    ? "../runtime/wasmgc/async/microtask-queue-bodies.js"
    : "./prepared-native-async-runtime.js";
  const scheduler = (names = builders) => `
    import { ${builders.join(", ")} } from "${queueImport}";
    import { inLiveShiftRange } from "../emit/resolve-layout.js";
    export function ensureScheduler() {
      ${names.map((name) => `${name}();`).join("\n")}
      return inLiveShiftRange(0, 0);
    }
  `;
  put("scripts/dead-export-baseline.json", "[]");
  put(
    "src/index.ts",
    'import { compileSource } from "./compiler.js"; export function compile() { return compileSource(); }',
  );
  put(
    "src/compiler.ts",
    'import { generateModule } from "./codegen/index.js"; export function compileSource() { return generateModule(); }',
  );
  put(
    "src/codegen/index.ts",
    'import { compileStatement } from "./statements.js"; export function generateModule() { return compileStatement(); }',
  );
  put(
    "src/codegen/statements.ts",
    'import { ensureScheduler } from "./async-scheduler.js"; export function compileStatement() { return ensureScheduler(); }',
  );
  put("src/codegen/expressions.ts", "export function compileExpression() { return 0; }");
  put("src/codegen/async-scheduler.ts", scheduler());
  put(relocated ? newQueue : oldQueue, declarations);
  put(
    relocated ? newHandle : oldHandle,
    "export function inLiveShiftRange(idx: number, start: number) { return idx >= start && idx < 0x40000000; }",
  );
  if (relocated) {
    put(oldQueue, `export { ${builders.join(", ")} } from "../runtime/wasmgc/async/microtask-queue-bodies.js";`);
    put(oldHandle, 'export { inLiveShiftRange } from "../wasm/physical/function-handles.js";');
  }
  const run = (extraArgs: string[] = []) => {
    const reportFile = resolve(root, "report.json");
    // This is the actual package check path, with only its input tree changed.
    // Do not substitute a mocked graph or the old broad-root report.
    const result = spawnSync(
      process.execPath,
      [checker, "--root", root, "--check", "--json", reportFile, ...extraArgs],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    return {
      exit: result.status,
      output: result.stdout + result.stderr,
      moved: report.movedRuntime as {
        roots: string[];
        functions: MovedFunction[];
        failures: string[];
        moduleLoads: { from: string; kind: string; specifier: string | null; status: string; target: string | null }[];
        ok: boolean;
        fullProduction: { reachableNodes: number };
        legacyDispatchCut: { reachableNodes: number };
      },
      perFile: report.perFile as { file: string; fns: { name: string; cls: string }[] }[],
    };
  };
  return { root, put, scheduler, run };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("#3518 moved runtime production reachability", () => {
  for (const relocated of [false, true]) {
    it(`requires six concrete production paths ${relocated ? "after" : "before"} relocation`, () => {
      const result = fixture(relocated).run();
      expect(result.exit, result.output).toBe(0);
      expect(result.moved.ok).toBe(true);
      expect(result.moved.roots).toEqual(["src/index.ts#compile"]);
      expect(result.moved.functions).toHaveLength(6);
      expect(result.moved.fullProduction.reachableNodes).toBeGreaterThan(6);
      for (const fn of result.moved.functions) {
        expect(fn.target).toBe(relocated ? fn.canonical : fn.original);
        expect(fn.fullProductionPath?.[0]).toBe("src/index.ts#compile");
        expect(fn.fullProductionPath?.at(-1)).toBe(fn.target);
        expect(fn.fullProductionPath).toContain("src/compiler.ts#compileSource");
        expect(fn.fullProductionPath).toContain("src/codegen/statements.ts#compileStatement");
        expect(fn.fullProductionPath).toContain("src/codegen/async-scheduler.ts#ensureScheduler");
        expect(fn.legacyDispatchCutPath).toBeNull();
        expect(fn.classification).toBe("legacy-only");
      }
    });
  }

  it("reports a separate path when a production route survives the dispatch cut", () => {
    const f = fixture();
    f.put(
      "src/codegen/index.ts",
      'import { ensureScheduler } from "./async-scheduler.js"; export function generateModule() { return ensureScheduler(); }',
    );
    const result = f.run();
    expect(result.exit, result.output).toBe(0);
    expect(result.moved.functions.every((fn) => fn.classification === "survivor")).toBe(true);
    for (const fn of result.moved.functions) {
      expect(fn.legacyDispatchCutPath?.[0]).toBe("src/index.ts#compile");
      expect(fn.legacyDispatchCutPath?.at(-1)).toBe(fn.target);
      expect(fn.legacyDispatchCutPath).not.toContain("src/codegen/statements.ts#compileStatement");
    }
  });

  it("fails when all real consumers are removed, despite compatibility exports", () => {
    const f = fixture();
    f.put("src/codegen/async-scheduler.ts", "export function ensureScheduler() { return 0; }");
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.functions.every((fn) => fn.classification === "unreferenced")).toBe(true);
    expect(result.moved.functions.every((fn) => fn.fullProductionPath === null)).toBe(true);
  });

  it("does not root a leaf re-exported directly by the public entry", () => {
    const f = fixture();
    f.put(
      "src/index.ts",
      `export { ${builders.join(", ")} } from "./runtime/wasmgc/async/microtask-queue-bodies.js"; export function compile() { return 0; }`,
    );
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.functions.every((fn) => fn.fullProductionPath === null)).toBe(true);
  });

  it("ignores test-only callers", () => {
    const f = fixture();
    f.put("src/codegen/async-scheduler.ts", "export function ensureScheduler() { return 0; }");
    f.put(
      "tests/consumer.test.ts",
      `import { ${builders.join(", ")} } from "../${newQueue}"; ${builders.map((name) => `${name}();`).join(" ")}`,
    );
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.functions.every((fn) => fn.fullProductionPath === null)).toBe(true);
  });

  for (const missing of builders) {
    it(`fails when the actual ${missing} reference is removed but its import remains`, () => {
      const f = fixture();
      f.put("src/codegen/async-scheduler.ts", f.scheduler(builders.filter((name) => name !== missing)));
      const result = f.run();
      expect(result.exit).toBe(1);
      expect(result.moved.functions.find((fn) => fn.target.endsWith(`#${missing}`))?.classification).toBe(
        "unreferenced",
      );
      expect(result.moved.functions.filter((fn) => fn.fullProductionPath)).toHaveLength(5);
    });
  }

  it("does not accept a same-spelled shadowing local as the moved function", () => {
    const f = fixture();
    f.put(
      "src/codegen/async-scheduler.ts",
      f
        .scheduler()
        .replace(
          "export function ensureScheduler() {",
          "export function ensureScheduler() { const buildGrowBody = () => [];",
        ),
    );
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.functions.find((fn) => fn.target.endsWith("#buildGrowBody"))?.fullProductionPath).toBeNull();
  });

  it("fails a renamed unreferenced moved function without dropping its contract row", () => {
    const f = fixture();
    f.put(newQueue, declarations.replace("function buildGrowBody", "function renamedUnreferenced"));
    f.put("src/codegen/async-scheduler.ts", f.scheduler(builders.filter((name) => name !== "buildGrowBody")));
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.functions).toHaveLength(6);
    expect(result.moved.failures).toContain(`missing moved function ${newQueue}#buildGrowBody`);
  });

  it("does not fall back to old implementations when a canonical module is incomplete", () => {
    const f = fixture(false);
    f.put(newQueue, "export const unrelated = 1;");
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.failures).toContain(`missing moved function ${newQueue}#buildGrowBody`);
  });

  it("fails when inLiveShiftRange loses its production reference", () => {
    const f = fixture();
    f.put("src/codegen/async-scheduler.ts", f.scheduler().replace("inLiveShiftRange(0, 0)", "0"));
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.functions.find((fn) => fn.target.endsWith("#inLiveShiftRange"))?.fullProductionPath).toBeNull();
  });

  it("fails a missing root instead of accepting an empty report", () => {
    const f = fixture();
    f.put("src/index.ts", "export function renamedCompile() { return 0; }");
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.fullProduction.reachableNodes).toBe(0);
    expect(result.moved.failures).toContain("missing production root src/index.ts#compile");
  });

  it("fails a missing public export even when the local root has the expected name", () => {
    const f = fixture();
    f.put(
      "src/index.ts",
      'import { compileSource } from "./compiler.js"; function compile() { return compileSource(); }',
    );
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.failures).toContain("missing public production export src/index.ts#compile");
  });

  it("fails an unresolved relative module from a live root", () => {
    const f = fixture();
    f.put("src/index.ts", 'import { missing } from "./missing.js"; export function compile() { return missing(); }');
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.failures.some((failure) => failure.includes("unresolved production module ./missing.js"))).toBe(
      true,
    );
  });

  it("fails an unresolved export edge even when all six target paths remain live", () => {
    const f = fixture();
    f.put(
      "src/index.ts",
      'import { compileSource, missing } from "./compiler.js"; export function compile() { missing(); return compileSource(); }',
    );
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.functions.filter((fn) => fn.fullProductionPath)).toHaveLength(6);
    expect(result.moved.failures.some((failure) => failure.includes("unresolved relative reference missing"))).toBe(
      true,
    );
  });

  it("fails unresolved namespace edges", () => {
    const f = fixture();
    f.put(
      "src/index.ts",
      'import * as compiler from "./compiler.js"; export function compile() { compiler.missing(); return compiler.compileSource(); }',
    );
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(
      result.moved.failures.some((failure) => failure.includes("unresolved namespace edge compiler.missing")),
    ).toBe(true);
  });

  for (const [load, failure] of [
    ['import("./missing.js")', "unresolved dynamic import module ./missing.js"],
    ['require("./missing.js")', "unresolved require module ./missing.js"],
    ["import(specifier)", "unknown nonliteral dynamic import module target"],
    ["require(specifier)", "unknown nonliteral require module target"],
    ["import(`./${specifier}.js`)", "unknown nonliteral dynamic import module target"],
  ]) {
    it(`fails ${load} with all six production targets still live`, () => {
      const f = fixture();
      f.put(
        "src/index.ts",
        `import { compileSource } from "./compiler.js"; export function compile(specifier: string) { ${load}; return compileSource(); }`,
      );
      const result = f.run();
      expect(result.exit, result.output).toBe(1);
      expect(result.moved.ok).toBe(false);
      expect(result.moved.functions).toHaveLength(6);
      expect(result.moved.functions.filter((fn) => fn.fullProductionPath)).toHaveLength(6);
      expect(result.moved.failures.some((message) => message.includes(failure))).toBe(true);
      expect(result.moved.moduleLoads).toEqual([
        expect.objectContaining({ from: "src/index.ts#compile", status: "unknown" }),
      ]);
    });
  }

  for (const load of ['import("./loaded.js")', 'require("./loaded.js")', "import(`./loaded.js`)"]) {
    it(`resolves ${load} and checks its transitive module initialization`, () => {
      const f = fixture();
      f.put(
        "src/index.ts",
        `import { compileSource } from "./compiler.js"; export function compile() { ${load}; return compileSource(); }`,
      );
      f.put("src/loaded.ts", 'import("./missing-transitive.js");');
      const result = f.run();
      expect(result.exit).toBe(1);
      expect(result.moved.functions.filter((fn) => fn.fullProductionPath)).toHaveLength(6);
      expect(result.moved.moduleLoads).toContainEqual(
        expect.objectContaining({ status: "resolved-production", target: "src/loaded.ts#<module>" }),
      );
      expect(
        result.moved.failures.some((message) =>
          message.includes("src/loaded.ts#<module>: unresolved dynamic import module ./missing-transitive.js"),
        ),
      ).toBe(true);
    });
  }

  it("does not root otherwise unreachable owners just because they contain unknown module loads", () => {
    const f = fixture();
    f.put("src/unreachable.ts", "export function unused(specifier: string) { return import(specifier); }");
    const result = f.run();
    expect(result.exit, result.output).toBe(0);
    expect(result.moved.moduleLoads).toEqual([]);
  });

  it("accepts a resolved literal load without making the loaded functions roots", () => {
    const f = fixture();
    f.put(
      "src/index.ts",
      'import { compileSource } from "./compiler.js"; export function compile() { import("./loaded.js"); return compileSource(); }',
    );
    f.put("src/loaded.ts", "export function unused(specifier: string) { return import(specifier); }");
    const result = f.run();
    expect(result.exit, result.output).toBe(0);
    expect(result.moved.moduleLoads).toEqual([
      expect.objectContaining({ status: "resolved-production", target: "src/loaded.ts#<module>" }),
    ]);
  });

  for (const [declaration, failure] of [
    ['import missing = require("./missing.js");', "unresolved import-equals module ./missing.js"],
    ["import missing = nonexistent.member;", "unknown import-equals alias missing"],
  ]) {
    it(`fails unresolved import-equals syntax: ${declaration}`, () => {
      const f = fixture();
      f.put(
        "src/index.ts",
        `import { compileSource } from "./compiler.js"; ${declaration} export function compile() { missing(); return compileSource(); }`,
      );
      const result = f.run();
      expect(result.exit).toBe(1);
      expect(result.moved.functions.filter((fn) => fn.fullProductionPath)).toHaveLength(6);
      expect(result.moved.failures.some((message) => message.includes(failure))).toBe(true);
    });
  }

  it("fails an unresolved export-equals alias inside an existing loaded module", () => {
    const f = fixture();
    f.put("src/broken.ts", "export = nonexistent;");
    f.put(
      "src/index.ts",
      'import { compileSource } from "./compiler.js"; import broken = require("./broken.js"); export function compile() { broken(); return compileSource(); }',
    );
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.functions.filter((fn) => fn.fullProductionPath)).toHaveLength(6);
    expect(result.moved.failures.some((message) => message.includes("unresolved import-equals alias broken"))).toBe(
      true,
    );
    expect(
      result.moved.failures.some((message) =>
        message.includes("src/broken.ts#<module>: unknown/unresolved export-equals reference nonexistent"),
      ),
    ).toBe(true);
  });

  it("accepts a resolved import-equals callable without suppressing the six required paths", () => {
    const f = fixture();
    f.put("src/loaded.ts", "function loaded() { return 0; } export = loaded;");
    f.put(
      "src/index.ts",
      'import { compileSource } from "./compiler.js"; import loaded = require("./loaded.js"); export function compile() { loaded(); return compileSource(); }',
    );
    const result = f.run();
    expect(result.exit, result.output).toBe(0);
    expect(result.moved.functions.filter((fn) => fn.fullProductionPath)).toHaveLength(6);
    expect(result.moved.moduleLoads).toContainEqual(
      expect.objectContaining({
        kind: "import-equals",
        status: "resolved-production",
        target: "src/loaded.ts#<module>",
      }),
    );
  });

  it("does not make an export-equals callable live merely by importing its module", () => {
    const f = fixture();
    f.put("src/loaded.ts", "function loaded(specifier: string) { return import(specifier); } export = loaded;");
    f.put(
      "src/index.ts",
      'import { compileSource } from "./compiler.js"; import loaded = require("./loaded.js"); export function compile() { return compileSource(); }',
    );
    const result = f.run();
    expect(result.exit, result.output).toBe(0);
    expect(result.moved.functions.filter((fn) => fn.fullProductionPath)).toHaveLength(6);
    expect(result.moved.moduleLoads.every((load) => load.status === "resolved-production")).toBe(true);
  });

  it("resolves export-equals aliases and checks the referenced callable", () => {
    const f = fixture();
    f.put("src/loaded.ts", "function loaded(specifier: string) { return import(specifier); } export = loaded;");
    f.put(
      "src/index.ts",
      'import { compileSource } from "./compiler.js"; import loaded = require("./loaded.js"); export function compile() { loaded("./any.js"); return compileSource(); }',
    );
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.moved.functions.filter((fn) => fn.fullProductionPath)).toHaveLength(6);
    expect(
      result.moved.failures.some((message) =>
        message.includes("src/loaded.ts#loaded: unknown nonliteral dynamic import module target"),
      ),
    ).toBe(true);
  });

  it("accepts resolved external re-exports without treating them as production roots", () => {
    const f = fixture();
    f.put("node_modules/gate-external/package.json", '{"name":"gate-external","types":"index.d.ts"}');
    f.put("node_modules/gate-external/index.d.ts", "export default function external(): void;");
    f.put("src/external.ts", 'import external from "gate-external"; export { external };');
    f.put(
      "src/index.ts",
      'import { compileSource } from "./compiler.js"; import { external } from "./external.js"; export function compile() { external(); return compileSource(); }',
    );
    const result = f.run();
    expect(result.exit, result.output).toBe(0);
    expect(result.moved.roots).toEqual(["src/index.ts#compile"]);
    expect(result.moved.functions.filter((fn) => fn.fullProductionPath)).toHaveLength(6);
  });

  it("keeps the original codegen dead-export ratchet active", () => {
    const f = fixture();
    f.put("src/codegen/unreferenced.ts", "export function unrelatedDeadFunction() { return 0; }");
    const result = f.run();
    expect(result.moved.ok).toBe(true);
    expect(result.exit).toBe(1);
    expect(result.output).toContain("NEW unreferenced top-level function(s)");
    expect(result.output).toContain("src/codegen/unreferenced.ts#unrelatedDeadFunction");
  });

  it("cannot bypass --check with --why", () => {
    const f = fixture();
    f.put("src/codegen/async-scheduler.ts", f.scheduler([]));
    expect(f.run(["--why", "buildGrowBody"]).exit).toBe(1);
  });
});
