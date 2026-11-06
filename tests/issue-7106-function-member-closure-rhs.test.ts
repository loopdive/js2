// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

// The original Test262 RHS bytes are retained. Its receiver stub is deliberately
// isolated: this whole file is not a whole-harness acceptance measurement.
const SOURCE = `
function assert(): number { return 0; }
assert._isSameValue = function (a, b) {
  if (a === b) {
    // Handle +/-0 vs. -/+0
    return a !== 0 || 1 / a === 1 / b;
  }

  // Handle NaN vs. NaN
  return a !== a && b !== b;
};
function subject(): number { return 0; }
subject.equal = function (a, b) { return a === b; };
export function equalNumbers(): number { return assert._isSameValue(2, 2) ? 1 : 0; }
export function distinctSignedZero(): number { return assert._isSameValue(0, -0) ? 0 : 1; }
export function equalNaN(): number { return assert._isSameValue(0 / 0, 0 / 0) ? 1 : 0; }
export function heterogeneous(): number {
  if (subject.equal(1, "1")) return 0;
  if (!subject.equal(true, true)) return 0;
  return 1;
}
export function objectIdentity(): number {
  const value = { key: 1 };
  return subject.equal(value, value) && !subject.equal(value, { key: 1 }) ? 1 : 0;
}
export function install(): void { subject.equal = function (a, b) { return a === b; }; }
// A direct verifier only reads the old value and invokes the real IR installer.
export function freshIdentity(): number {
  const first = subject.equal;
  install();
  return first === subject.equal ? 0 : 1;
}
export function sharedSignature(): number {
  const legacy = function (a, b) { return arguments.length === 2 && a !== b; };
  return legacy(1, 2) && subject.equal(1, 1) && !subject.equal(1, "1") ? 1 : 0;
}
`;
let compiled: CompileResult;
let guest: Record<string, () => number>;
function requirePrepared(result: CompileResult, name: string): void {
  const row = result.irOutcomes?.find((entry) => entry.displayName === name);
  expect(row, JSON.stringify(result.irOutcomes)).toMatchObject({
    kind: "emitted",
    irBodyEmitted: true,
    legacyBodyEmitted: false,
    directBodyEmissions: 0,
    preparedComponentId: expect.any(String),
  });
  expect(row).not.toHaveProperty("r2Withdrawal");
}
async function instantiate(
  result: CompileResult,
  initialization: "required" | "if-present" = "required",
): Promise<Record<string, () => number>> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const init = instance.exports.__module_init;
  if (initialization === "required" || init !== undefined) {
    expect(typeof init).toBe("function");
    (init as () => void)();
  }
  return instance.exports as Record<string, () => number>;
}
const OPTIONS = {
  target: "standalone",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

describe("#7106 exact function-member RHS physical ABI", () => {
  beforeAll(async () => {
    compiled = await compile(SOURCE, OPTIONS);
    guest = await instantiate(compiled);
  }, 35_000);
  it("executes original SameValue RHS bytes under genuine IR module initialization", () => {
    requirePrepared(compiled, "<module-init>");
    for (const name of ["equalNumbers", "distinctSignedZero", "equalNaN"]) {
      requirePrepared(compiled, name);
      expect(guest[name]!()).toBe(1);
    }
  });
  it("converts raw canonical slots into actual dynamic values for heterogeneous equality", () => {
    requirePrepared(compiled, "heterogeneous");
    expect(guest.heterogeneous!()).toBe(1);
  });
  it("keeps actual object identity across the closure boundary", () => {
    requirePrepared(compiled, "objectIdentity");
    expect(guest.objectIdentity!()).toBe(1);
  });
  it("allocates a fresh RHS closure on each genuine IR installation", () => {
    requirePrepared(compiled, "install");
    expect(guest.freshIdentity!()).toBe(1);
  });
  it("does not borrow a distinct legacy source's inline body or arity facts", () => {
    expect(guest.sharedSignature!()).toBe(1);
  });
});

const REFUSALS = [
  ["mutated parameter", "subject.equal = function (a) { a = 42; return a === 42; }; return subject.equal(0) ? 1 : 0;"],
  [
    "captured local",
    "const captured = 41; subject.equal = function (a) { return a === captured; }; return subject.equal(41) ? 1 : 0;",
  ],
  [
    "rest parameter",
    "subject.equal = function (...args) { return args.length === 2; }; return subject.equal(1, 2) ? 1 : 0;",
  ],
  ["default parameter", "subject.equal = function (a = 1) { return a === 1; }; return subject.equal() ? 1 : 0;"],
  ["open result", "subject.equal = function (a) { return a; }; return subject.equal(1);"],
  [
    "shadowed receiver",
    "const subject = {}; subject.equal = function (a) { return a === 2; }; return subject.equal(2) ? 1 : 0;",
  ],
] as const;
describe("#7106 member RHS bounded refusal", () => {
  it.each(REFUSALS)(
    "keeps %s on the unchanged generic/direct route",
    async (_name, body) => {
      const result = await compile(
        `function subject(): number { return 0; } export function run(): number { ${body} }`,
        OPTIONS,
      );
      const exports = await instantiate(result, "if-present");
      const row = result.irOutcomes?.find((entry) => entry.displayName === "run");
      expect(row?.irBodyEmitted).not.toBe(true);
      expect(row?.legacyBodyEmitted).toBe(true);
      expect(exports.run!()).toBe(1);
    },
    35_000,
  );
});
