// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5137 — DataView setters must return the canonical `undefined` value.
 *
 * The native setter write is already correct. The residual defect was in the
 * two expression-position carriers: statically typed DataView calls used the
 * direct native accessor arm, while widened/reflective calls used
 * `ensureDvAccessorHelper`. Both used `ref.null.extern`, which is JavaScript
 * `null` after the standalone value model separated it from `undefined`.
 *
 * The exact ES2015 cohort is deliberately kept here, rather than represented
 * by a hand-written approximation: every row runs through the maintained
 * `runTest262File` runner in both host and standalone lanes. The standalone
 * lane also checks its actual Wasm import manifest before instantiation.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";

type Lane = "host" | "standalone";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262_ROOT = join(REPO_ROOT, "test262");

const SETTER_MEMBERS = [
  "setFloat32",
  "setFloat64",
  "setInt16",
  "setInt32",
  "setInt8",
  "setUint16",
  "setUint32",
] as const;

const EXACT_ROWS = SETTER_MEMBERS.flatMap((member) => [
  `built-ins/DataView/prototype/${member}/set-values-return-undefined.js`,
  `built-ins/DataView/prototype/${member}/no-value-arg.js`,
]);

/**
 * One source module exercises both result producers, a direct getter, and the
 * write itself. The statically typed receiver selects `emitDataViewAccessor`
 * and the `any` receiver selects the runtime-receiver helper.
 */
const CARRIER_CONTROL_SOURCE = `
  export function test(): number {
    let checks = 0;

    const direct = new DataView(new ArrayBuffer(8));
    const directResult: any = direct.setUint16(0, 0x1234, false);
    if (directResult === undefined) checks += 1;
    if (directResult !== null) checks += 2;
    if (typeof directResult === "undefined") checks += 4;
    if (direct.getUint16(0, false) === 0x1234) checks += 8;
    if (direct.getUint8(0) === 0x12 && direct.getUint8(1) === 0x34) checks += 16;

    // A statement-position setter remains a void operation and still writes.
    direct.setUint8(2, 0x56);
    if (direct.getUint8(2) === 0x56) checks += 32;

    // The any receiver is the closed-method/runtime helper route.
    const dynamic: any = new DataView(new ArrayBuffer(8));
    const dynamicResult: any = dynamic.setUint32(0, 0x01020304, false);
    if (dynamicResult === undefined) checks += 64;
    if (dynamicResult !== null) checks += 128;
    if (typeof dynamicResult === "undefined") checks += 256;
    if (dynamic.getUint32(0, false) === 0x01020304) checks += 512;
    if (
      dynamic.getUint8(0) === 1 &&
      dynamic.getUint8(1) === 2 &&
      dynamic.getUint8(2) === 3 &&
      dynamic.getUint8(3) === 4
    ) checks += 1024;

    const directRead: any = direct.getUint16(0, false);
    if (directRead === 0x1234 && typeof directRead === "number" && directRead !== null) checks += 2048;
    const dynamicRead: any = dynamic.getUint32(0, false);
    if (dynamicRead === 0x01020304 && typeof dynamicRead === "number" && dynamicRead !== null) checks += 4096;

    return checks;
  }
`;

/** Missing value coercion remains observable while the result is undefined. */
const MISSING_VALUE_CONTROL_SOURCE = `
  export function test(): number {
    let checks = 0;
    const dv = new DataView(new ArrayBuffer(8));

    const floatResult: any = dv.setFloat32(0);
    if (floatResult === undefined) checks += 1;
    if (floatResult !== null) checks += 2;
    const floatValue: any = dv.getFloat32(0);
    if (floatValue !== floatValue) checks += 4;

    dv.setInt32(0, 42);
    const intResult: any = dv.setInt32(0);
    if (intResult === undefined) checks += 8;
    if (intResult !== null) checks += 16;
    if (dv.getInt32(0) === 0) checks += 32;

    return checks;
  }
`;

/** The index RangeError fires before converting the setter value. */
const INDEX_ORDER_CONTROL_SOURCE = `
  let evaluated = 0;
  const value: any = { valueOf: function(): number { evaluated += 1; return 7; } };
  export function test(): number {
    const dv = new DataView(new ArrayBuffer(8));
    try { dv.setInt16(-1, value); } catch (e) {}
    return evaluated === 0 ? 1 : 0;
  }
`;

/** The bounds RangeError fires only after evaluating the setter value. */
const BOUNDS_ORDER_CONTROL_SOURCE = `
  let evaluated = 0;
  function value(): number { evaluated += 1; return 7; }
  export function test(): number {
    const dv = new DataView(new ArrayBuffer(8));
    try { dv.setInt16(100, value()); } catch (e) {}
    return evaluated === 1 ? 1 : 0;
  }
`;

/**
 * Reflective access is standalone-only: the host lane intentionally delegates
 * this shape to the JavaScript DataView binding, whose receiver representation
 * is different. Standalone's DataView prototype closure must use the same
 * helper carrier as a closed any-receiver call.
 */
const REFLECTIVE_CONTROL_SOURCE = `
  export function test(): number {
    const dynamic: any = new DataView(new ArrayBuffer(8));
    const setter: any = DataView.prototype.setInt16;
    const result: any = setter.call(dynamic, 2, -0x1234, true);
    let checks = 0;
    if (result === undefined) checks += 1;
    if (result !== null) checks += 2;
    if (typeof result === "undefined") checks += 4;
    if (dynamic.getInt16(2, true) === -0x1234) checks += 8;
    if (dynamic.getUint8(2) === 0xcc && dynamic.getUint8(3) === 0xed) checks += 16;
    return checks;
  }
`;

async function runControl(source: string, lane: Lane): Promise<{ value: number; imports: string[] }> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5137-es2015-dataview-setter-undefined-carrier.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(
    result.success,
    `${lane} control compile failed:\n${result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")}`,
  ).toBe(true);
  if (!result.success) return { value: -1, imports: [] };

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
  if (lane === "standalone") {
    expect(imports, "standalone DataView controls must emit zero imports").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return { value: (instance.exports as { test: () => number }).test(), imports };
  }

  const built = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setInstance?.(instance);
  return { value: (instance.exports as { test: () => number }).test(), imports };
}

async function runExactRow(relativePath: string, lane: Lane) {
  const filePath = join(TEST262_ROOT, "test", relativePath);
  try {
    return await runTest262File(filePath, `issue-5137-${lane}`, 120_000, lane === "standalone" ? lane : undefined);
  } finally {
    restoreHostBuiltins();
  }
}

describe("#5137 ES2015 DataView setter undefined carrier", () => {
  it("direct and helper carriers preserve undefined, bytes, and getter values in host mode", async () => {
    const outcome = await runControl(CARRIER_CONTROL_SOURCE, "host");
    expect(outcome.value).toBe(8191);
  });

  it("direct and helper carriers preserve undefined, bytes, and getter values host-free", async () => {
    const outcome = await runControl(CARRIER_CONTROL_SOURCE, "standalone");
    expect(outcome.value).toBe(8191);
    expect(outcome.imports).toEqual([]);
  });

  it("missing-value coercion still writes NaN/zero and returns undefined in host mode", async () => {
    expect((await runControl(MISSING_VALUE_CONTROL_SOURCE, "host")).value).toBe(63);
  });

  it("missing-value coercion still writes NaN/zero and returns undefined host-free", async () => {
    const outcome = await runControl(MISSING_VALUE_CONTROL_SOURCE, "standalone");
    expect(outcome.value).toBe(63);
    expect(outcome.imports).toEqual([]);
  });

  it("keeps index-before-value coercion order in both lanes", async () => {
    expect((await runControl(INDEX_ORDER_CONTROL_SOURCE, "host")).value).toBe(1);
    expect((await runControl(INDEX_ORDER_CONTROL_SOURCE, "standalone")).value).toBe(1);
  });

  it("keeps value-before-bounds coercion order in both lanes", async () => {
    expect((await runControl(BOUNDS_ORDER_CONTROL_SOURCE, "host")).value).toBe(1);
    expect((await runControl(BOUNDS_ORDER_CONTROL_SOURCE, "standalone")).value).toBe(1);
  });

  it("reflective DataView prototype setter uses the helper carrier host-free", async () => {
    const outcome = await runControl(REFLECTIVE_CONTROL_SOURCE, "standalone");
    expect(outcome.value).toBe(31);
    expect(outcome.imports).toEqual([]);
  });

  for (const relativePath of EXACT_ROWS) {
    it(`host exact Test262 row: ${relativePath}`, { timeout: 180_000 }, async () => {
      const result = await runExactRow(relativePath, "host");
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    });

    it(`standalone exact Test262 row: ${relativePath}`, { timeout: 180_000 }, async () => {
      const result = await runExactRow(relativePath, "standalone");
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    });
  }

  it("standalone exact cohort repeats deterministically", { timeout: 180_000 }, async () => {
    for (const relativePath of EXACT_ROWS) {
      const result = await runExactRow(relativePath, "standalone");
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    }
  });
});
