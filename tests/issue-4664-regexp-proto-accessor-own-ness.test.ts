// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4664) RegExp.prototype accessor descriptors live in the same mutable
// companion as the prototype's data methods. The companion, not the immutable
// member CSV, is authoritative after delete/redefinition. The getter closure
// also carries an internal receiver slot, so reflective invocation must use the
// receiver-aware method-0 dispatcher.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const TEST262 = existsSync(join(__dirname, "..", "test262", "harness", "assert.js"));

async function compileStandalone(source: string, extra: Record<string, unknown> = {}) {
  const result = await compile(source, {
    fileName: "issue-4664.ts",
    target: "standalone",
    ...extra,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  return result;
}

async function runNumber(source: string): Promise<number> {
  const result = await compileStandalone(source);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

/** Node 24 keeps Wasm exnref behind a process flag that worker pools cannot add. */
function runWithExnref(script: string, timeout = 180_000): string {
  const child = spawnSync(
    process.execPath,
    ["--experimental-wasm-exnref", "--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: join(__dirname, ".."),
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  expect(child.status, `${child.stderr}\n${child.stdout}`).toBe(0);
  return child.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .at(-1)!;
}

describe("#4664 RegExp.prototype accessor companion authority", () => {
  it.each(["global", "ignoreCase", "multiline"])(
    "keeps every own-property view coherent after deleting and redefining %s",
    { timeout: 30_000 },
    async (member) => {
      expect(
        await runNumber(`
          export function test(): number {
            const proto: any = RegExp.prototype;
            const key: any = "${member}".slice(0);
            const before: any = Object.getOwnPropertyDescriptor(proto, key);
            let score = 0;

            if (Object.prototype.hasOwnProperty.call(proto, key)) score |= 1;
            if (before !== undefined &&
                typeof before.get === "function" &&
                before.set === undefined &&
                before.enumerable === false &&
                before.configurable === true) score |= 2;
            if (proto[key] === undefined) score |= 4;

            if (delete proto[key]) score |= 8;
            if (!Object.prototype.hasOwnProperty.call(proto, key)) score |= 16;
            if (Object.getOwnPropertyDescriptor(proto, key) === undefined) score |= 32;

            const names: any = Object.getOwnPropertyNames(proto);
            let found = false;
            for (let i = 0; i < names.length; i++) {
              if (names[i] === key) found = true;
            }
            if (!found) score |= 64;
            if (proto[key] === undefined) score |= 128;

            Object.defineProperty(proto, key, {
              value: "restored",
              writable: true,
              enumerable: true,
              configurable: true
            });
            if (proto[key] === "restored" && Object.prototype.hasOwnProperty.call(proto, key)) score |= 256;

            delete proto[key];
            Object.defineProperty(proto, key, {
              get: function(): any { return this === proto ? "accessor" : "wrong receiver"; },
              configurable: true
            });
            if (proto[key] === "accessor") score |= 512;
            return score;
          }
        `),
      ).toBe(1023);
    },
  );

  it("dispatches the intrinsic getter with the original receiver", async () => {
    const compilerUrl = pathToFileURL(join(__dirname, "..", "src", "index.ts")).href;
    const source = `
        export function test(): number {
          const proto: any = RegExp.prototype;
          const descriptor: any = Object.getOwnPropertyDescriptor(proto, "global");
          let score = 0;
          if (descriptor.get.call(proto) === undefined) score |= 1;
          if (descriptor.get.call(/x/g) === true) score |= 2;
          try {
            descriptor.get.call({});
          } catch (error) {
            if (error instanceof TypeError) score |= 4;
          }
          if ((RegExp.prototype as any).global === undefined) score |= 8;
          if (proto.global === undefined) score |= 16;
          return score;
        }
      `;
    const output = runWithExnref(`
      const { compile } = await import(${JSON.stringify(compilerUrl)});
      const result = await compile(${JSON.stringify(source)}, {
        fileName: "issue-4664-exnref.ts",
        target: "standalone"
      });
      if (!result.success) throw new Error(JSON.stringify(result.errors));
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      console.log(JSON.stringify({ value: instance.exports.test() }));
    `);
    expect(JSON.parse(output)).toEqual({ value: 31 });
  });

  it("keeps a post-delete dynamic reader genuinely on the IR path", async () => {
    const previous = process.env.JS2WASM_FORCE_DYN_MEMBER_GET;
    process.env.JS2WASM_FORCE_DYN_MEMBER_GET = "1";
    let result: Awaited<ReturnType<typeof compile>>;
    try {
      result = await compileStandalone(
        `
          function reader(receiver: any, key: any): any {
            return receiver[key];
          }
          export function run(): number {
            const proto: any = RegExp.prototype;
            delete proto.global;
            const invoke: any = reader;
            return invoke(proto, "global") === undefined ? 1 : 0;
          }
        `,
        { experimentalIR: true, trackIrOutcomes: true, skipSemanticDiagnostics: true },
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_FORCE_DYN_MEMBER_GET");
      else process.env.JS2WASM_FORCE_DYN_MEMBER_GET = previous;
    }
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toEqual(["reader"]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  });

  it("emits no accessor companion for an unrelated RegExp instance read", async () => {
    const result = await compileStandalone(`export function test(): number { return /x/g.global ? 1 : 0; }`, {
      emitWat: true,
      // This assertion owns conditional emission, not IR selection. The test
      // above separately proves a genuine IR reader reaches the shared runtime.
      experimentalIR: false,
    });
    expect(result.wat).not.toContain("__nativeproto_seed_");
    expect(result.wat).not.toContain("__proto_method_-1073741823_get_global");
  });
});

describe.skipIf(!TEST262)("#4664 exact standalone Test262 rows", () => {
  const rows = [
    "built-ins/RegExp/prototype/global/S15.10.7.2_A9.js",
    "built-ins/RegExp/prototype/ignoreCase/S15.10.7.3_A9.js",
    "built-ins/RegExp/prototype/multiline/S15.10.7.4_A9.js",
  ];

  it("passes all three accessor-deletion rows through the assembled harness", { timeout: 180_000 }, () => {
    const runnerUrl = pathToFileURL(join(__dirname, "test262-runner.ts")).href;
    const absoluteRows = rows.map((rel) => join(__dirname, "..", "test262", "test", rel));
    const output = runWithExnref(`
      const { runTest262File } = await import(${JSON.stringify(runnerUrl)});
      const rows = ${JSON.stringify(absoluteRows)};
      const results = [];
      for (const row of rows) {
        const result = await runTest262File(row, "issue-4664", 30000, "standalone");
        results.push({ row, status: result.status, error: result.error ?? "" });
      }
      console.log(JSON.stringify(results));
    `);
    const results = JSON.parse(output) as { row: string; status: string; error: string }[];
    expect(
      results.map(({ status }) => status),
      JSON.stringify(results, null, 2),
    ).toEqual(["pass", "pass", "pass"]);
  });
});
