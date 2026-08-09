// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const MATCH_INDICES_RESIDUALS = [
  "indices-array-element.js",
  "indices-array-matched.js",
  "indices-array-non-unicode-match.js",
  "indices-array-properties.js",
  "indices-array-unicode-match.js",
  "indices-array-unicode-property-names.js",
  "indices-array-unmatched.js",
  "indices-array.js",
  "indices-groups-object-undefined.js",
  "indices-groups-object-unmatched.js",
  "indices-groups-object.js",
  "indices-groups-properties.js",
  "indices-property.js",
] as const;

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.run as () => number)();
}

describe("#3666 standalone RegExp match indices", () => {
  it.each(MATCH_INDICES_RESIDUALS)("passes maintained Test262 residual %s", { timeout: 60_000 }, async (file) => {
    const path = resolve("test262/test/built-ins/RegExp/match-indices", file);
    const result = await runTest262File(path, "issue-3666", 45_000, "standalone");
    expect(result.status, result.error ?? result.reason).toBe("pass");
  });

  it("preserves pair identity, null-proto groups, and no-d absence", async () => {
    await expect(
      runStandalone(`
        export function run(): number {
          const match: any = /(?<first>a)(?<missing>b)?/d.exec("a");
          const plain: any = /a/.exec("a");
          if (match === null || plain === null) return -1;

          let bits = 0;
          if (match.indices.groups.first === match.indices[1]) bits |= 1;
          if (match.indices.groups.missing === match.indices[2]) bits |= 2;
          if (match.indices[2] === undefined) bits |= 4;
          if (Object.getPrototypeOf(match.indices.groups) === null) bits |= 8;
          if (Object.getOwnPropertyDescriptor(plain, "indices") === undefined) bits |= 16;
          if (plain.indices === undefined) bits |= 32;
          return bits;
        }
      `),
    ).resolves.toBe(63);
  });

  it("executes nested function properties and later captured callbacks without changing value brands", async () => {
    await expect(
      runStandalone(`
        function harness() {}
        harness.compare = function (a, b) {
          return harness.compare.inner(a, b) === true;
        };
        harness.compare.inner = (function () {
          function inner(a, b) { return a === b; }
          return inner;
        })();

        function dispatch(a, b, callback, extra) {
          return callback(a, b, extra);
        }

        export function run(): number {
          const UNKNOWN = 0;
          function strict(a, b) { return a === b ? 1 : UNKNOWN; }
          function numeric() { return 7; }

          let bits = 0;
          if (harness.compare(1, 1) === true) bits |= 1;
          if (harness.compare.inner(1, 1) === true) bits |= 2;
          if (dispatch([1], [1], strict) === UNKNOWN) bits |= 4;
          if (dispatch(0, 0, numeric) === 7) bits |= 8;
          return bits;
        }
      `),
    ).resolves.toBe(15);
  });
});
