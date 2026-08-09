import { describe, expect, it } from "vitest";
import { parseArgs, runTest } from "../scripts/run-test262-fyi.mjs";

describe("test262.fyi original-harness runner", () => {
  it("parses opt-in lane arguments", () => {
    expect(parseArgs(["--filter", "built-ins/Array", "--limit", "3", "--target", "standalone"])).toEqual({
      filters: ["built-ins/Array"],
      pathsFile: undefined,
      limit: 3,
      workers: 2,
      target: "standalone",
      json: undefined,
      list: false,
    });

    expect(parseArgs(["--paths-file", "sample-paths.txt"]).pathsFile).toMatch(/sample-paths\.txt$/);
  });

  it("rejects unsupported targets", () => {
    expect(() => parseArgs(["--target", "linear"])).toThrow("--target must be gc, standalone, or wasi");
    expect(() => parseArgs(["--workers", "5"])).toThrow("--workers must be an integer between 1 and 4");
  });

  it("runs raw top-level assert property dispatch after exports are wired", async () => {
    const result = await runTest(
      {
        file: "raw-assert-property.js",
        contents: `
          function assert(value) {
            if (value === true) return;
            throw new Error("assert failed");
          }
          assert.sameValue = function (actual, expected) {
            if (actual === expected) return;
            throw new Error("sameValue failed");
          };
          assert.sameValue(1, 1);
        `,
        flags: {},
        negative: undefined,
        strictRerun: false,
      },
      "gc",
    );

    expect(result).toMatchObject({ pass: true, phase: "runtime" });
  });

  it("binds script-goal top-level this to the global object", async () => {
    const result = await runTest(
      {
        file: "script-top-level-this.js",
        contents: `
          var observedGlobal = this;
          if (observedGlobal !== globalThis) {
            throw new Error("top-level script this was not globalThis");
          }
        `,
        flags: {},
        negative: undefined,
        strictRerun: false,
      },
      "gc",
    );

    expect(result).toMatchObject({ pass: true, phase: "runtime" });
  });

  it("requires negative failures to occur in the declared phase", async () => {
    const compileInsteadOfRuntime = await runTest(
      {
        file: "runtime-negative-compile-error.js",
        contents: "const = ;",
        flags: {},
        negative: { phase: "runtime", type: "TypeError" },
        strictRerun: false,
      },
      "gc",
    );
    expect(compileInsteadOfRuntime.pass).toBe(false);
    expect(compileInsteadOfRuntime.phase).toBe("compile");

    const runtimeInsteadOfParse = await runTest(
      {
        file: "parse-negative-runtime-throw.js",
        contents: 'var initialized = 1; throw new SyntaxError("too late");',
        flags: {},
        negative: { phase: "parse", type: "SyntaxError" },
        strictRerun: false,
      },
      "gc",
    );
    expect(runtimeInsteadOfParse.pass).toBe(false);
    expect(runtimeInsteadOfParse.phase).toBe("compile");
  });

  it("uses the project worker's script-global async contract", async () => {
    const result = await runTest(
      {
        file: "async-global-done.js",
        contents: `
          if (!Object.prototype.hasOwnProperty.call(globalThis, "$DONE")) {
            throw new Error("missing script-global $DONE");
          }
          console.log("Test262:AsyncTestComplete");
        `,
        flags: { async: true },
        negative: undefined,
        strictRerun: false,
      },
      "gc",
    );

    expect(result).toMatchObject({ pass: true, phase: "runtime" });
  });

  it("does not turn an intentionally unobserved dynamic-import rejection into a failure", async () => {
    const result = await runTest(
      {
        file: "dynamic-import-syntax.js",
        contents: `import("./missing_FIXTURE.js");`,
        flags: {},
        negative: undefined,
        strictRerun: false,
      },
      "gc",
    );

    expect(result).toMatchObject({ pass: true, phase: "runtime" });
  });

  it("uses UTC in source workers for reproducible Date verdicts", async () => {
    const inheritedTimeZone = process.env.TZ;
    process.env.TZ = "Europe/Berlin";
    const result = await (async () => {
      try {
        return await runTest(
          {
            file: "date-without-offset.js",
            contents: `
              if (Date.parse("2016-01-01T00:00:00") !== Date.parse("2016-01-01T00:00:00Z")) {
                throw new Error("source worker did not run in UTC");
              }
            `,
            flags: {},
            negative: undefined,
            strictRerun: false,
          },
          "gc",
        );
      } finally {
        if (inheritedTimeZone === undefined) Reflect.deleteProperty(process.env, "TZ");
        else process.env.TZ = inheritedTimeZone;
      }
    })();

    expect(result).toMatchObject({ pass: true, phase: "runtime" });
  });

  it("runs the strict variant through the same isolated worker contract", async () => {
    const result = await runTest(
      {
        file: "strict-builtin-metadata.js",
        contents: `
          var strict = (function () { return this === undefined; })();
          if (strict && !Object.prototype.hasOwnProperty.call(Array.prototype.map, "length")) {
            throw new Error("strict rerun inherited missing function metadata");
          }
        `,
        flags: {},
        negative: undefined,
        strictRerun: true,
      },
      "gc",
    );

    expect(result).toMatchObject({ pass: true, phase: "runtime" });
  });

  it("recycles after nested intrinsic objects are mutated", async () => {
    const result = await runTest(
      {
        file: "strict-unscopables-isolation.js",
        contents: `
          var strict = (function () { return this === undefined; })();
          var unscopables = Array.prototype[Symbol.unscopables];
          if (strict) {
            if (!Object.prototype.hasOwnProperty.call(unscopables, "copyWithin")) {
              throw new Error("strict rerun inherited a polluted @@unscopables object");
            }
          } else {
            delete unscopables.copyWithin;
          }
        `,
        flags: {},
        negative: undefined,
        strictRerun: true,
      },
      "gc",
    );

    expect(result).toMatchObject({ pass: true, phase: "runtime" });
  });
});
