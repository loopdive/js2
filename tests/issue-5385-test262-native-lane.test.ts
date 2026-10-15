import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { test262LaneUsesNativeRegime, test262ResultPrefix } from "../scripts/test262-lane.mjs";

const root = join(import.meta.dirname, "..");

describe("#5385 test262 semantic lane identity", () => {
  // (#6979 S7) A lane is named by its target alone; the host-assisted control
  // lane and its artifacts are gone.
  it("keeps the legacy result paths and names lanes by target", () => {
    expect(test262ResultPrefix()).toBe("test262");
    expect(test262ResultPrefix("gc")).toBe("test262");
    expect(test262ResultPrefix("standalone")).toBe("test262-standalone");
    expect(test262LaneUsesNativeRegime(undefined)).toBe(true);
    expect(test262LaneUsesNativeRegime("gc")).toBe(true);
    expect(test262LaneUsesNativeRegime("standalone")).toBe(true);
    expect(test262LaneUsesNativeRegime("wasi")).toBe(false);
  });

  it("records the row-format provider identity and rejects removed host-assisted rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "test262-5385-"));
    try {
      const input = join(dir, "rows.jsonl");
      const output = join(dir, "report.json");
      const row = {
        file: "test/language/expressions/addition/S11.6.1_A1.js",
        category: "language/expressions",
        status: "pass",
        semantic_providers: "auto",
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
      expect(report.mode.semantic_providers).toBe("auto");
      expect(report.summary.total).toBe(1);
      writeFileSync(
        input,
        JSON.stringify(row) +
          "\n" +
          JSON.stringify({ ...row, file: "test/y.js", semantic_providers: "host-assisted" }) +
          "\n",
      );
      const removed = build();
      expect(removed.status).not.toBe(0);
      expect(removed.stderr).toContain("removed semantic-provider lane host-assisted");
      // An unlabelled row is the same (only) lane.
      writeFileSync(
        input,
        JSON.stringify({ ...row, semantic_providers: undefined }) +
          "\n" +
          JSON.stringify({ ...row, file: "test/x.js" }) +
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
  it("passes no semantic-provider option to literal, synthetic, fixture and linked-provider compilation", async () => {
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
    const doCompile = new Function(
      "restoreBuiltins",
      "hasFixtureGraph",
      "compileMultipleSources",
      "compileSingleSource",
      "compilerBundle",
      `${worker.slice(start, end)}; return doCompile;`,
    )(
      () => ({ recycle: false }),
      (files: unknown) => !!files,
      multi,
      single,
      { compileWithTemporalGlobal: linked },
    );
    await doCompile("source", undefined, undefined, false, false, undefined, undefined, false, undefined, null);
    await doCompile("source", undefined, undefined, false, true, undefined, undefined, false, undefined, null);
    await doCompile(
      "source",
      undefined,
      undefined,
      false,
      true,
      { "fixture.js": "export const x=1;" },
      "main.js",
      false,
      undefined,
      null,
    );
    await doCompile("source", undefined, undefined, false, true, undefined, undefined, false, undefined, {});
    expect(observed).toHaveLength(4);
    for (const options of observed) {
      expect(options).toMatchObject({ deferTopLevelInit: true });
      expect(options).not.toHaveProperty("semanticProviders");
    }
  });
});
