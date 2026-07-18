import { describe, expect, it } from "vitest";
import { HostRealmContaminationError, parseArgs, runTest } from "../scripts/run-test262-fyi.mjs";

describe("test262.fyi original-harness runner", () => {
  it("parses opt-in lane arguments", () => {
    expect(parseArgs(["--filter", "built-ins/Array", "--limit", "3", "--target", "standalone"])).toEqual({
      filters: ["built-ins/Array"],
      limit: 3,
      target: "standalone",
      json: undefined,
      list: false,
    });
  });

  it("rejects unsupported targets", () => {
    expect(() => parseArgs(["--target", "linear"])).toThrow("--target must be gc, standalone, or wasi");
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
        contents: 'throw new SyntaxError("too late");',
        flags: {},
        negative: { phase: "parse", type: "SyntaxError" },
        strictRerun: false,
      },
      "gc",
    );
    expect(runtimeInsteadOfParse.pass).toBe(false);
    expect(runtimeInsteadOfParse.phase).toBe("runtime");
  });

  // Keep this last: it deliberately leaves the Vitest fork's realm polluted.
  // The CLI supervisor recycles its source worker after observing this error.
  it("detects non-configurable intrinsic prototype mutations for worker recycling", async () => {
    const property = "__test262_fyi_nonconfigurable_probe__";
    expect(Object.prototype.hasOwnProperty.call(Array.prototype, property)).toBe(false);

    await expect(
      runTest(
        {
          file: "intrinsic-prototype-isolation.js",
          contents: `Object.defineProperty(Array.prototype, "${property}", { value: 1 });`,
          flags: {},
          negative: undefined,
          strictRerun: false,
        },
        "gc",
      ),
    ).rejects.toBeInstanceOf(HostRealmContaminationError);
  });
});
