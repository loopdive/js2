import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  parseTest262SemanticProviders,
  test262CompileSemanticProviders,
  test262ResultPrefix,
} from "../scripts/test262-lane.mjs";

const root = join(import.meta.dirname, "..");

describe("#5385 test262 semantic lane identity", () => {
  // (#6708 S6) The default lane IS native-first; only the host-assisted control
  // lane gets its own artifacts.
  it("keeps legacy paths and separates the host-assisted control artifacts", () => {
    expect(test262ResultPrefix()).toBe("test262");
    expect(test262ResultPrefix("standalone")).toBe("test262-standalone");
    expect(test262ResultPrefix("gc", "native-first")).toBe("test262");
    expect(test262ResultPrefix("standalone", "native-first")).toBe("test262-standalone");
    expect(test262ResultPrefix("gc", "host-assisted")).toBe("test262-host-assisted");
    expect(parseTest262SemanticProviders("")).toBe("auto");
    expect(parseTest262SemanticProviders("native-first")).toBe("auto");
    expect(test262CompileSemanticProviders("auto")).toBeUndefined();
    expect(test262CompileSemanticProviders("host-assisted")).toBe("host-assisted");
    expect(() => parseTest262SemanticProviders("native-frist")).toThrow("Invalid");
  });

  it("records measured provider identity and rejects merged cross-provider evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "test262-5385-"));
    try {
      const input = join(dir, "rows.jsonl");
      const output = join(dir, "report.json");
      const row = {
        file: "test/language/expressions/addition/S11.6.1_A1.js",
        category: "language/expressions",
        status: "pass",
        semantic_providers: "host-assisted",
      };
      const build = () =>
        spawnSync(process.execPath, ["scripts/build-test262-report.mjs", "--input", input, "--output", output], {
          cwd: root,
          encoding: "utf8",
        });
      writeFileSync(input, JSON.stringify(row) + "\n");
      const native = build();
      expect(native.status, native.stderr).toBe(0);
      const report = JSON.parse(readFileSync(output, "utf8"));
      expect(report.mode.semantic_providers).toBe("host-assisted");
      expect(report.summary.total).toBe(1);
      writeFileSync(input, JSON.stringify(row) + "\n" + JSON.stringify({ ...row, semantic_providers: "auto" }) + "\n");
      const mixed = build();
      expect(mixed.status).not.toBe(0);
      expect(mixed.stderr).toContain("different semantic providers");
      // (#6708) a pre-S6 native-first row and an unlabelled row are the same lane now.
      writeFileSync(
        input,
        JSON.stringify({ ...row, semantic_providers: undefined }) +
          "\n" +
          JSON.stringify({ ...row, file: "test/x.js", semantic_providers: "native-first" }) +
          "\n",
      );
      expect(build().status).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8")).mode.semantic_providers).toBe("auto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#5385 worker compile branches", () => {
  it("passes the host-assisted control policy to literal, synthetic, fixture and linked-provider compilation", async () => {
    const worker = readFileSync(join(root, "scripts/test262-worker.mjs"), "utf8");
    const start = worker.indexOf("async function doCompile(");
    const end = worker.indexOf("\n/**", start);
    // Run the real dispatch function against compiler doubles. This proves the
    // option reaches the compiler, including compileMulti, without a provider build.
    const observed: unknown[] = [];
    const single = (_source: unknown, options: unknown) => {
      observed.push(options);
    };
    const multi = (_files: unknown, _entry: unknown, options: unknown) => {
      observed.push(options);
    };
    const linked = (_source: unknown, _provider: unknown, options: unknown) => {
      observed.push(options);
    };
    // Free variables of `doCompile` that live at worker module scope.
    // (1de31aa63c, #6776) the branches now spread `WORKER_SELF_VALIDATES`, and
    // (f1ad427b98) the fixture-graph arm checks `isFixtureFileRecord`.
    const doCompile = new Function(
      "restoreBuiltins",
      "isFixtureFileRecord",
      "compileMultipleSources",
      "compileSingleSource",
      "compilerBundle",
      "WORKER_SELF_VALIDATES",
      "HARNESS_HOST_BRIDGE",
      `${worker.slice(start, end)}; return doCompile;`,
    )(
      () => ({ recycle: false }),
      (files: unknown) => !!files && typeof files === "object" && !Array.isArray(files),
      multi,
      single,
      { compileWithTemporalGlobal: linked },
      { validate: false },
      { hostBridge: "always" },
    );
    // The parameter list keeps growing in the middle (f1ad427b98 inserted
    // `moduleGraph`, 668d3cf93b `linkedHarness`, 06dbc8d88f `scriptGoal`), which
    // silently shifted every positional argument here. Bind by NAME, read off
    // the real signature, so the next insertion cannot do that again.
    const params = worker
      .slice(start, worker.indexOf(") {", start))
      .replace(/^async function doCompile\(/, "")
      .replace(/\/\/[^\n]*/g, "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    expect(params).toEqual(expect.arrayContaining(["semanticProviders", "moduleGraph", "temporal"]));
    const call = (named: Record<string, unknown>) =>
      doCompile(
        ...params.map((p) => (p === "source" ? "source" : p === "semanticProviders" ? "host-assisted" : named[p])),
      );
    // literal JavaScript (original harness off -> synthetic TS lane)
    await call({ inferModuleStrictArguments: false, originalHarness: false });
    // literal original-harness assembly
    await call({ inferModuleStrictArguments: false, originalHarness: true });
    // fixture module graph -> compileMulti
    await call({
      inferModuleStrictArguments: false,
      originalHarness: true,
      fixtureFiles: { "fixture.js": "export const x=1;" },
      entryFile: "main.js",
      moduleGraph: true,
    });
    // linked Temporal provider
    await call({ inferModuleStrictArguments: false, originalHarness: true, temporal: {} });
    expect(observed).toHaveLength(4);
    for (const options of observed)
      expect(options).toMatchObject({ semanticProviders: "host-assisted", deferTopLevelInit: true });
  });
});
