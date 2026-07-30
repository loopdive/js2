import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
var nonAsciiStartChars = "\\u00aa\\u00b5\\u00ba\\u00c0-\\u00d6";
var nonAsciiStart = new RegExp("[" + nonAsciiStartChars + "]");
var nonAsciiPart = new RegExp("[" + nonAsciiStartChars + "\\u0300-\\u036f]");

function isIdentifierStart(code: number): boolean {
  return code >= 0xaa && nonAsciiStart.test(String.fromCharCode(code));
}

function isIdentifierChar(code: number): boolean {
  return code >= 0xaa && nonAsciiPart.test(String.fromCharCode(code));
}

function isRegExpIdentifierStart(code: number): boolean {
  return isIdentifierStart(code) || code === 0x24 || code === 0x5f;
}

function isRegExpIdentifierPart(code: number): boolean {
  return isIdentifierChar(code) || code === 0x24 || code === 0x5f;
}

export function run(): number {
  if (!isIdentifierStart(0xaa) || isIdentifierStart(0x41)) return 0;
  if (isIdentifierStart(0xd7)) return 0;
  if (!isIdentifierChar(0x0301) || isIdentifierChar(0x41)) return 0;
  if (isIdentifierChar(0x0370)) return 0;
  if (!isRegExpIdentifierStart(0x24)) return 0;
  if (!isRegExpIdentifierPart(0x5f)) return 0;
  return 1;
}
`;

describe("#3791 standalone native RegExp.test IR bridge", () => {
  it("loads the existing native carrier and emits the identifier helpers through IR", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-3791-ir-native-regexp-test.ts",
      target: "standalone",
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toEqual(
      expect.arrayContaining([
        "isIdentifierStart",
        "isIdentifierChar",
        "isRegExpIdentifierStart",
        "isRegExpIdentifierPart",
      ]),
    );

    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  });

  it("keeps reassigned and stateful RegExp carriers on the legacy path", async () => {
    const result = await compile(
      `
      var reassigned = new RegExp("a");
      reassigned = new RegExp("b");
      var destructured = new RegExp("a");
      [destructured] = [new RegExp("c")];
      var stateful = new RegExp("a", "g");
      function reassignedTest(value: string): boolean {
        return reassigned.test(value);
      }
      function destructuredTest(value: string): boolean {
        return destructured.test(value);
      }
      function statefulTest(value: string): boolean {
        return stateful.test(value);
      }
      export function run() {
        return reassignedTest("b") && statefulTest("a") ? 1 : 0;
      }
      `,
      {
        fileName: "issue-3791-ir-native-regexp-test-fallbacks.ts",
        target: "standalone",
        trackIrOutcomes: true,
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("reassignedTest");
    expect(result.irCompiledFuncs ?? []).not.toContain("destructuredTest");
    expect(result.irCompiledFuncs ?? []).not.toContain("statefulTest");
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.run as () => number)()).toBe(1);

    const destructuringWrites = await compile(
      `
      var forOfDestructured = new RegExp("a");
      for ([forOfDestructured] of [[new RegExp("d")]]) break;
      var objectRest = new RegExp("a");
      ({ ...objectRest } = { replacement: new RegExp("e") });
      function forOfDestructuredTest(value: string): boolean {
        return forOfDestructured.test(value);
      }
      function objectRestTest(value: string): boolean {
        return objectRest.test(value);
      }
      export function run(): number {
        return 1;
      }
      `,
      {
        fileName: "issue-3791-ir-native-regexp-test-destructuring-writes.ts",
        target: "standalone",
        trackIrOutcomes: true,
        skipSemanticDiagnostics: true,
      },
    );
    expect(destructuringWrites.success, destructuringWrites.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(destructuringWrites.irPostClaimErrors ?? []).toEqual([]);
    expect(destructuringWrites.irCompiledFuncs ?? []).not.toContain("forOfDestructuredTest");
    expect(destructuringWrites.irCompiledFuncs ?? []).not.toContain("objectRestTest");
  });

  it("projects only exact stable numeric-array globals at direct-call boundaries", async () => {
    const stable = await compile(
      `
      var stableSet = [3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181];
      var secondStableSet = [2, 7, 11, 19];

      function includesValue(value, set) {
        var position = 0;
        for (var index = 0; index < set.length; index += 2) {
          position += set[index];
          if (position > value) return false;
          position += set[index + 1];
          if (position >= value) return true;
        }
        return false;
      }
      function usesStable(value) {
        return includesValue(value, stableSet);
      }
      function usesSecondStable(value) {
        return includesValue(value, secondStableSet);
      }
      function groundAbi(value: any, set: number[]): boolean {
        return includesValue(value, set);
      }
      export function run() {
        return usesStable(5) && usesSecondStable(2) && groundAbi(5, stableSet) ? 1 : 0;
      }
      `,
      {
        fileName: "issue-3791-static-numeric-array-call.ts",
        target: "standalone",
        trackIrOutcomes: true,
        allowJs: true,
        skipSemanticDiagnostics: true,
        optimize: 4,
      },
    );

    expect(stable.success, stable.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(stable.irPostClaimErrors ?? []).toEqual([]);
    expect(stable.irCompiledFuncs ?? []).toContain("usesStable");
    expect(stable.irCompiledFuncs ?? []).toContain("usesSecondStable");
    const { instance } = await WebAssembly.instantiate(stable.binary, {});
    expect((instance.exports.run as () => number)()).toBe(1);

    const fallback = await compile(
      `
      var reassignedSet = [1];
      reassignedSet = [2];
      var sourceSet = [13];
      var aliasedSet = sourceSet;
      function read(value, set) {
        return set[0] === value;
      }
      function usesReassigned(value) {
        return read(value, reassignedSet);
      }
      function usesAlias(value) {
        return read(value, aliasedSet);
      }
      export function run() {
        return usesReassigned(2) && usesAlias(13) ? 1 : 0;
      }
      `,
      {
        fileName: "issue-3791-static-numeric-array-fallbacks.mjs",
        target: "standalone",
        trackIrOutcomes: true,
        allowJs: true,
        skipSemanticDiagnostics: true,
      },
    );
    expect(fallback.success, fallback.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(fallback.irCompiledFuncs ?? []).not.toContain("usesReassigned");
    expect(fallback.irCompiledFuncs ?? []).not.toContain("usesAlias");
  });

  it("rejects a numeric-array global when the direct callee parameter is any", async () => {
    const result = await compile(
      `
      var values = [1];
      function takesAny(value: any): number {
        return value[0];
      }
      function read(): number {
        return takesAny(values);
      }
      export function run(): number {
        return read();
      }
      `,
      {
        fileName: "issue-3791-numeric-array-any-param.ts",
        target: "standalone",
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("read");
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  });

  it("accounts for preceding static-spread elements before proving the vec parameter", async () => {
    const result = await compile(
      `
      var values = [9];
      function target(head: number, set: number[], tail: any): number {
        return 1;
      }
      function read(): number {
        return target(...[1, [2]], values);
      }
      export function run(): number {
        return read();
      }
      `,
      {
        fileName: "issue-3791-numeric-array-spread-offset.ts",
        target: "standalone",
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("read");
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "read")).toEqual(
      expect.objectContaining({ kind: "unsupported", stage: "select" }),
    );
  });

  it.each([
    ["standalone fast", { target: "standalone" as const, fast: true }],
    ["gc fast", { target: "gc" as const, fast: true }],
  ])("keeps numeric-array globals on direct codegen for %s", async (_label, mode) => {
    const result = await compile(
      `
      var values = [1];
      function first(input: number[]): number {
        return input.slice(0)[0];
      }
      function read(): number {
        return first(values);
      }
      export function run(): number {
        return read();
      }
      `,
      {
        ...mode,
        fileName: "issue-3791-fast-numeric-array.ts",
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("read");
    const module = await WebAssembly.compile(result.binary);
    if (mode.target === "standalone") {
      const instance = await WebAssembly.instantiate(module, {});
      expect((instance.exports.run as () => number)()).toBe(1);
    }
  });

  it("admits the native RegExp carrier only for standalone, not WASI", async () => {
    const wasi = await compile(SOURCE, {
      fileName: "issue-3791-ir-native-regexp-test-wasi.ts",
      target: "wasi",
      trackIrOutcomes: true,
    });

    expect(wasi.success, wasi.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(wasi.irPostClaimErrors ?? []).toEqual([]);
    expect(wasi.irCompiledFuncs ?? []).not.toContain("isIdentifierStart");
    expect(wasi.irCompiledFuncs ?? []).not.toContain("isIdentifierChar");
    expect(wasi.irCompiledFuncs ?? []).not.toContain("isRegExpIdentifierStart");
    expect(wasi.irCompiledFuncs ?? []).not.toContain("isRegExpIdentifierPart");
  });

  it("keeps lexical module arrays on the TDZ-aware legacy path", async () => {
    const source = `
      var observed = readBeforeInit();
      const late = [1];
      function first(input: number[]): number {
        return input[0];
      }
      function readBeforeInit(): number {
        return first(late);
      }
      export function run(): number {
        return observed;
      }
    `;
    const [legacy, ir] = await Promise.all([
      compile(source, {
        fileName: "issue-3791-numeric-array-tdz-legacy.ts",
        target: "standalone",
        experimentalIR: false,
      }),
      compile(source, {
        fileName: "issue-3791-numeric-array-tdz-ir.ts",
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
      }),
    ]);

    expect(legacy.success, legacy.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(ir.success, ir.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(ir.irPostClaimErrors ?? []).toEqual([]);
    expect(ir.irCompiledFuncs ?? []).not.toContain("readBeforeInit");
    await expect(WebAssembly.instantiate(legacy.binary, {})).rejects.toBeDefined();
    await expect(WebAssembly.instantiate(ir.binary, {})).rejects.toBeDefined();

    const regexpSource = `
      var observed = readRegExpBeforeInit();
      const lateRegExp = new RegExp("a");
      function readRegExpBeforeInit(): number {
        return lateRegExp.test("a") ? 1 : 0;
      }
      export function run(): number {
        return observed;
      }
    `;
    const [legacyRegExp, irRegExp] = await Promise.all([
      compile(regexpSource, {
        fileName: "issue-3791-regexp-tdz-legacy.ts",
        target: "standalone",
        experimentalIR: false,
      }),
      compile(regexpSource, {
        fileName: "issue-3791-regexp-tdz-ir.ts",
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
      }),
    ]);

    expect(legacyRegExp.success, legacyRegExp.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(irRegExp.success, irRegExp.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(irRegExp.irPostClaimErrors ?? []).toEqual([]);
    expect(irRegExp.irCompiledFuncs ?? []).not.toContain("readRegExpBeforeInit");
    await expect(WebAssembly.instantiate(legacyRegExp.binary, {})).rejects.toBeDefined();
    await expect(WebAssembly.instantiate(irRegExp.binary, {})).rejects.toBeDefined();
  });
});
