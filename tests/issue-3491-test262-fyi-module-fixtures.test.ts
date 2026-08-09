// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverFixtureGraph,
  discoverTestPaths,
  loadOriginalHarnessTests,
  staticFixtureSpecifiers,
} from "../scripts/test262-fyi-reader.mjs";
import { runTest } from "../scripts/run-test262-fyi.mjs";

const TEST_ROOT = join(import.meta.dirname, "..", "test262", "test");
const CIRCULAR_PATH = "language/module-code/instn-star-props-circular.js";
const NEGATIVE_PATH = "language/module-code/ambiguous-export-bindings/error-import-named.js";

function upstreamSource(path: string): string {
  return readFileSync(join(TEST_ROOT, path), "utf8");
}

describe("#3491 — FYI static Test262 fixture graphs", () => {
  it("discovers one-level fixture imports under their pinned virtual paths", () => {
    const path = "language/module-code/instn-iee-bndng-let.js";
    const graph = discoverFixtureGraph(path, upstreamSource(path));

    expect(graph.entryFile).toBe(`./${path}`);
    expect(Object.keys(graph.fixtureFiles)).toEqual(["./language/module-code/instn-iee-bndng-let_FIXTURE.js"]);
    expect(graph.fixtureFiles["./language/module-code/instn-iee-bndng-let_FIXTURE.js"]).toBe(
      upstreamSource("language/module-code/instn-iee-bndng-let_FIXTURE.js"),
    );
  });

  it("walks transitive fixture exports", () => {
    const path = "language/module-code/instn-iee-err-dflt-thru-star.js";
    const graph = discoverFixtureGraph(path, upstreamSource(path));

    expect(Object.keys(graph.fixtureFiles)).toEqual([
      "./language/module-code/instn-iee-err-dflt-thru-star-int_FIXTURE.js",
      "./language/module-code/instn-iee-err-dflt-thru-star-dflt_FIXTURE.js",
    ]);
  });

  it("terminates circular export-star discovery without duplicating modules", () => {
    const graph = discoverFixtureGraph(CIRCULAR_PATH, upstreamSource(CIRCULAR_PATH));

    expect(Object.keys(graph.fixtureFiles)).toEqual([
      "./language/module-code/instn-star-props-circular-a_FIXTURE.js",
      "./language/module-code/instn-star-props-circular-b_FIXTURE.js",
    ]);
  });

  it("rejects missing static fixtures instead of accepting an unrelated resolution error", () => {
    expect(() =>
      discoverFixtureGraph("language/module-code/missing-control.js", 'import "./missing-control_FIXTURE.js";'),
    ).toThrow(
      "missing Test262 fixture imported by language/module-code/missing-control.js: ./missing-control_FIXTURE.js",
    );
  });

  it("recognizes side-effect imports but ignores comments, templates, and dynamic imports", () => {
    const source = `
      /* import x from "./comment_FIXTURE.js"; */
      const example = \`export * from "./template_FIXTURE.js";\`;
      import "./side-effect_FIXTURE.js";
      import("./dynamic_FIXTURE.js");
      export * from "./export_FIXTURE.js";
    `;

    expect(staticFixtureSpecifiers(source)).toEqual(["./side-effect_FIXTURE.js", "./export_FIXTURE.js"]);
  });

  it("keeps fixtures out of test records and preserves the literal FYI entry assembly", async () => {
    const fixturePath = "language/module-code/instn-star-props-circular-a_FIXTURE.js";
    const discoveredPaths = discoverTestPaths();
    expect(discoveredPaths).toContain(CIRCULAR_PATH);
    expect(discoveredPaths).not.toContain(fixturePath);

    const tests = await loadOriginalHarnessTests([CIRCULAR_PATH, fixturePath]);
    expect(tests).toHaveLength(1);
    expect(tests[0].file).toBe(CIRCULAR_PATH);
    expect(tests[0].contents.endsWith(upstreamSource(CIRCULAR_PATH))).toBe(true);
    expect(tests[0].fixtureFiles["./language/module-code/instn-star-props-circular-a_FIXTURE.js"]).toBe(
      upstreamSource(fixturePath),
    );
  });

  it("links the circular namespace graph in standalone and gc", { timeout: 60_000 }, async () => {
    const [test] = await loadOriginalHarnessTests([CIRCULAR_PATH]);
    const [standalone, gc] = await Promise.all([runTest(test, "standalone"), runTest(test, "gc")]);

    expect(standalone).toMatchObject({ pass: true, phase: "runtime" });
    // #3493 preserves graph setup and fills the multi-source member
    // dispatchers, so the former pre-setExports `unreachable` frontier is
    // gone. Both lanes must now execute the real circular graph.
    expect(gc).toMatchObject({ pass: true, phase: "runtime" });
  });

  it(
    "does not false-pass a resolution-negative test because its fixture graph was absent",
    { timeout: 60_000 },
    async () => {
      const [test] = await loadOriginalHarnessTests([NEGATIVE_PATH]);
      expect(Object.keys(test.fixtureFiles)).toHaveLength(3);

      const results = await Promise.all([runTest(test, "gc"), runTest(test, "standalone")]);
      for (const result of results) {
        expect(result.pass).toBe(false);
        expect(result.detail).not.toMatch(/cannot find module|module not found|missing Test262 fixture/i);
      }
    },
  );
});
