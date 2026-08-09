// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { loadOriginalHarnessTests } from "../scripts/test262-fyi-reader.mjs";
import { runTest } from "../scripts/run-test262-fyi.mjs";

const moduleNegativePaths = [
  "language/module-code/early-dup-top-function-async-generator.js",
  "language/module-code/early-dup-top-function-async.js",
  "language/module-code/early-dup-top-function-generator.js",
  "language/module-code/early-dup-top-function.js",
] as const;

type OriginalHarnessRecord = Awaited<ReturnType<typeof loadOriginalHarnessTests>>[number];

describe("#3504 FYI flag-only Module goal", () => {
  let records: OriginalHarnessRecord[];

  beforeAll(async () => {
    records = await loadOriginalHarnessTests([...moduleNegativePaths]);
  });

  it("preserves the reader's Module flag for all four exact parse negatives", async () => {
    expect(records.map((record) => record.file).sort()).toEqual([...moduleNegativePaths].sort());

    for (const record of records) {
      expect(record.flags?.module, record.file).toBe(true);
      expect(record.negative, record.file).toEqual({ phase: "parse", type: "SyntaxError" });
      expect(/\b(?:import|export)\b/.test(record.contents), record.file).toBe(false);

      for (const target of ["gc", "standalone"] as const) {
        const result = await runTest(record, target);
        expect(result, `${target}: ${record.file}`).toMatchObject({ pass: true, reachedTest: false });
      }
    }
  }, 60_000);

  it.each(["gc", "standalone"] as const)("keeps Script duplicate functions last-wins in %s", async (target) => {
    const result = await runTest(
      {
        file: "script-duplicate-top-functions.js",
        contents: `
          function selected() { return 1; }
          function selected() { return 2; }
          if (selected() !== 2) throw new Error("Script duplicate did not use the last declaration");
        `,
        flags: {},
        negative: undefined,
        strictRerun: false,
      },
      target,
    );

    expect(result).toMatchObject({ pass: true });
  });

  it.each(["gc", "standalone"] as const)(
    "ignores import/export text in Script trivia and strings in %s",
    async (target) => {
      const result = await runTest(
        {
          file: "script-module-keyword-text.js",
          contents: `
          // import value from "./fixture.js";
          /* export default value; */
          var message = "import and export are only text";
          function selected() { return 1; }
          function selected() { return 2; }
          if (selected() !== 2) throw new Error("Script text was treated as Module syntax");
        `,
          flags: {},
          negative: undefined,
          strictRerun: false,
        },
        target,
      );

      expect(result).toMatchObject({ pass: true });
    },
  );
});
