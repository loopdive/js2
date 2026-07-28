/**
 * TS2345 false positive: parameter type inferred from a JS default value.
 *
 * TypeScript infers an unannotated JS parameter's type from its default-value
 * initializer, so `function f(prerelease = "")` becomes `prerelease: string`.
 * A call site passing anything wider trips TS2345 — and because 2345 is in
 * HARD_TS_DIAG_CODES, that single diagnostic aborted the whole compile before
 * codegen ever ran.
 *
 * The shape below is reduced from TypeScript's own shipped bundle
 * (`node_modules/typescript/lib/_tsc.js`, `src/compiler/semver.ts`), which was
 * the first hard blocker when compiling the `typescript` npm package: the
 * original `.ts` source declares `prerelease?: string | readonly string[]`, but
 * that annotation is erased in the published JS, leaving only the `""` default.
 *
 * In a JS file the inferred type is a TypeScript fiction with no runtime
 * meaning, so it must not gate codegen. An explicit annotation or a JSDoc type
 * tag IS the author's stated intent and stays hard.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const errorText = (r: Awaited<ReturnType<typeof compile>>) =>
  r.errors.map((e) => `${e.message} @ ${e.line}:${e.column}`).join("; ");

describe("TS2345 on a JS parameter typed from its default value", () => {
  it("does not block codegen for the semver.ts shape from the tsc bundle", async () => {
    const result = await compile(
      `
      function isArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
      class Version {
        constructor(major, minor = 0, patch = 0, prerelease = "") {
          this.major = major;
          this.minor = minor;
          this.patch = patch;
          this.prerelease = prerelease ? (isArray(prerelease) ? prerelease : prerelease.split(".")) : [];
        }
      }
      export function run() {
        const v = new Version(1, 2, 3, ["0"]);
        return v.prerelease.length;
      }
    `,
      { allowJs: true, fileName: "semver.js" },
    );

    expect(result.success, `Compile failed: ${errorText(result)}`).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("stays hard when the JS parameter carries a JSDoc type tag", async () => {
    const result = await compile(
      `
      /**
       * @param {string} prerelease
       */
      function tag(prerelease = "") { return prerelease; }
      export function run() { return tag(["0"]); }
    `,
      { allowJs: true, fileName: "jsdoc.js" },
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 2345)).toBe(true);
  });

  it("stays hard for an annotated parameter in a TypeScript file", async () => {
    const result = await compile(
      `
      function tag(prerelease: string = ""): string { return prerelease; }
      export function run(): string { return tag(["0"]); }
    `,
      { fileName: "annotated.ts" },
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 2345)).toBe(true);
  });

  it("stays hard for a default-typed parameter in a TypeScript file", async () => {
    // Same inference, but in .ts the author chose not to annotate and TS's
    // inference is meaningful — js2wasm is a TypeScript compiler, so respect it.
    const result = await compile(
      `
      function tag(prerelease = "") { return prerelease; }
      export function run() { return tag(["0"]); }
    `,
      { fileName: "inferred.ts" },
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.code === 2345)).toBe(true);
  });
});
