import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

it.each(
  ["s === '0'", "/^[0-9]+$/.test(s)"].flatMap((predicate) => ["single", "multi"].map((mode) => ({ predicate, mode }))),
)("runs a Version-like generic every initializer with $predicate ($mode)", async ({ predicate, mode }) => {
  const source = `
    export function every<T>(array: readonly T[] | undefined, callback: (element: T, index: number) => boolean): boolean {
      if (array !== undefined) {
        for (let i = 0; i < array.length; i++) {
          if (!callback(array[i], i)) return false;
        }
      }
      return true;
    }
    class Version {
      static readonly zero = new Version(["0"]);
      readonly valid: boolean;
      constructor(prerelease: string | readonly string[] = "") {
        const parts = prerelease ? Array.isArray(prerelease) ? prerelease : prerelease.split(".") : [];
        this.valid = every(parts, s => ${predicate});
      }
    }
    export function run(): number { return Version.zero.valid ? 1 : -1; }
  `;
  const options = { target: "standalone" as const, skipSemanticDiagnostics: true };
  const split = source.indexOf("    class Version");
  const result =
    mode === "single"
      ? await compile(source, options)
      : await compileMulti(
          {
            "./core.ts": source.slice(0, split),
            "./entry.ts": `import { every } from './core.js';\n${source.slice(split)}`,
          },
          "./entry.ts",
          options,
        );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  runStandalone(result.binary);
});

function runStandalone(binary: Uint8Array): void {
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-wasm-exnref",
      "--input-type=module",
      "-e",
      `
    import { readFileSync } from "node:fs";
    const module = new WebAssembly.Module(readFileSync(0));
    if (WebAssembly.Module.imports(module).length) throw new Error("Unexpected imports");
    const instance = await WebAssembly.instantiate(module, {});
    console.log(instance.exports.run());
  `,
    ],
    { input: binary, encoding: "utf8", timeout: 10000 },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim()).toBe("1");
}

it.each(["null", "undefined", "3", "({})"])(
  "rejects non-callable generic callback %s with TypeError",
  async (value) => {
    const result = await compile(
      `
    let reads = 0;
    export function invoke<T>(callback: (value: T) => boolean, value: T): boolean { return callback((reads++, value)); }
    export function run(): number {
      try { invoke(${value} as any, "x"); }
      catch (error) { return error instanceof TypeError && reads === 1 ? 1 : -1; }
      return -2;
    }
  `,
      { target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    runStandalone(result.binary);
  },
);

it("initializes overloaded Version with module-level predicates and a barrel import", async () => {
  const result = await compileMulti(
    {
      "./core.ts": `
      export const emptyArray: readonly never[] = [];
      export function isArray(value: any): value is readonly any[] { return Array.isArray(value); }
      export function every<T, U extends T>(array: readonly T[], callback: (element: T, index: number) => element is U): array is readonly U[];
      export function every<T>(array: readonly T[] | undefined, callback: (element: T, index: number) => boolean): boolean;
      export function every<T>(array: readonly T[] | undefined, callback: (element: T, index: number) => boolean): boolean {
        if (array !== undefined) for (let i = 0; i < array.length; i++) if (!callback(array[i], i)) return false;
        return true;
      }
    `,
      "./barrel.ts": `export * from './core.js'; export * from './semver.js';`,
      "./semver.ts": String.raw`
      import { emptyArray, every, isArray } from './barrel.js';
      const prereleasePartRegExp = /^(?:0|[1-9]\d*|[a-z-][a-z0-9-]*)$/i;
      const buildPartRegExp = /^[a-z0-9-]+$/i;
      export class Version {
        static readonly zero = new Version(0, 0, 0, ["0"]);
        readonly valid: boolean;
        readonly prerelease: readonly string[];
        readonly build: readonly string[];
        constructor(text: string);
        constructor(major: number, minor?: number, patch?: number, prerelease?: string | readonly string[], build?: string | readonly string[]);
        constructor(major: number | string, minor = 0, patch = 0, prerelease: string | readonly string[] = "", build: string | readonly string[] = "") {
          const prereleaseArray = prerelease ? isArray(prerelease) ? prerelease : prerelease.split(".") : emptyArray;
          const buildArray = build ? isArray(build) ? build : build.split(".") : emptyArray;
          this.valid = every(prereleaseArray, s => prereleasePartRegExp.test(s)) && every(buildArray, s => buildPartRegExp.test(s));
          this.prerelease = prereleaseArray;
          this.build = buildArray;
        }
      }
    `,
      "./entry.ts": `import { Version } from './barrel.js'; export function run(): number {
      return Version.zero.valid && Version.zero.prerelease[0] === "0" && Version.zero.build.length === 0 ? 1 : -1;
    }`,
    },
    "./entry.ts",
    { target: "standalone", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  runStandalone(result.binary);
});
