// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6832 — direct dynamic `%TypedArray%.prototype` HOFs read [[ArrayLength]],
 * while borrowed Array HOFs retain observable LengthOfArrayLike behavior.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-6832-typedarray-hof-internal-length.js",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports ?? [], "standalone compiler imports").toEqual([]);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module), "standalone Wasm imports").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { probe: () => number }).probe();
}

const HOF_CASES = [
  {
    name: "forEach",
    direct: `
      let calls = 0;
      a.forEach(function () { calls++; });
      return hits === 0 && calls === 3 ? 1 : 0;`,
    borrowed: `
      let calls = 0;
      Array.prototype.forEach.call(a, function () { calls++; });
      return hits === 1 && calls === 1 ? 1 : 0;`,
  },
  {
    name: "every",
    direct: `
      let calls = 0;
      const result = a.every(function (value) { calls++; return value > 0; });
      return hits === 0 && calls === 3 && result ? 1 : 0;`,
    borrowed: `
      let calls = 0;
      const result = Array.prototype.every.call(a, function (value) { calls++; return value === 1; });
      return hits === 1 && calls === 1 && result ? 1 : 0;`,
  },
  {
    name: "some",
    direct: `
      let calls = 0;
      const result = a.some(function (value) { calls++; return value === 3; });
      return hits === 0 && calls === 3 && result ? 1 : 0;`,
    borrowed: `
      let calls = 0;
      const result = Array.prototype.some.call(a, function (value) { calls++; return value === 3; });
      return hits === 1 && calls === 1 && !result ? 1 : 0;`,
  },
  {
    name: "reduce",
    direct: `
      let calls = 0;
      const result = a.reduce(function (acc, value) { calls++; return acc + value; }, 0);
      return hits === 0 && calls === 3 && result === 6 ? 1 : 0;`,
    borrowed: `
      let calls = 0;
      const result = Array.prototype.reduce.call(a, function (acc, value) { calls++; return acc + value; }, 0);
      return hits === 1 && calls === 1 && result === 1 ? 1 : 0;`,
  },
  {
    name: "reduceRight",
    direct: `
      let calls = 0;
      const result = a.reduceRight(function (acc, value) { calls++; return acc * 10 + value; }, 0);
      return hits === 0 && calls === 3 && result === 321 ? 1 : 0;`,
    borrowed: `
      let calls = 0;
      const result = Array.prototype.reduceRight.call(a, function (acc, value) { calls++; return acc * 10 + value; }, 0);
      return hits === 1 && calls === 1 && result === 1 ? 1 : 0;`,
  },
] as const;

function directLengthSource(body: string, receiver: "own" | "prototype"): string {
  const target = receiver === "own" ? "a" : "TA.prototype";
  return `
function run(TA) {
  const a = new TA([1, 2, 3]);
  let hits = 0;
  Object.defineProperty(${target}, "length", {
    configurable: true,
    get: function () { hits++; return 1; },
  });
  ${body}
}
export function probe() { return run(Float64Array); }
`;
}

function borrowedLengthSource(body: string): string {
  return `
function run(TA) {
  const a = new TA([1, 2, 3]);
  let hits = 0;
  Object.defineProperty(a, "length", {
    configurable: true,
    get: function () { hits++; return 1; },
  });
  ${body}
}
export function probe() { return run(Float64Array); }
`;
}

const PRESENCE_GATE_SOURCE = `
function run(TA) {
  const a = new TA([1, 2, 3]);
  let hits = 0;
  Object.defineProperty(a, "length", { get: function () { hits++; return 1; } });
  // This pre-scan-visible inherited index makes the generic HOF use HasProperty.
  Object.prototype[7] = 99;
  let calls = 0;
  const result = a.some(function (value, index, receiver) {
    calls++;
    return value === 3 && index === 2 && receiver === a;
  });
  return hits === 0 && calls === 3 && result ? 1 : 0;
}
export function probe() { return run(Float64Array); }
`;

const ARRAY_CONTROLS_SOURCE = `
export function probe() {
  const dense = [1, 2, 3];
  let denseCalls = 0;
  const denseResult = dense.some(function (value) { denseCalls++; return value === 2; });
  const sparse = [1, , 3];
  let sparseCalls = 0;
  const sparseResult = sparse.some(function (value) { sparseCalls++; return value === 3; });
  return denseResult && denseCalls === 2 && sparseResult && sparseCalls === 2 ? 1 : 0;
}
`;

const CALLBACK_AND_REDUCER_SOURCE = `
function run(TA) {
  const a = new TA([1, 2, 3]);
  let receiverOk = 1;
  let someOrder = 0;
  const someResult = a.some(function (value, index, receiver) {
    someOrder = someOrder * 10 + index;
    if (receiver !== a) receiverOk = 0;
    return index === 1;
  });
  let everyOrder = 0;
  const everyResult = a.every(function (value, index, receiver) {
    everyOrder = everyOrder * 10 + index;
    if (receiver !== a) receiverOk = 0;
    return index < 1;
  });
  const forward = a.reduce(function (acc, value) { return acc * 10 + value; }, 0);
  const backward = a.reduceRight(function (acc, value) { return acc * 10 + value; }, 0);
  return receiverOk === 1 && someResult && !everyResult && someOrder === 1 && everyOrder === 1 && forward === 123 && backward === 321
    ? 1
    : 0;
}
export function probe() { return run(Float64Array); }
`;

const MUTATION_AND_DETACH_SOURCE = `
function run(TA) {
  const mutated = new TA([1, 2, 3]);
  let sum = 0;
  mutated.forEach(function (value, index) {
    if (index === 0) mutated[1] = 7;
    sum += value;
  });
  const detached = new TA([1, 2, 3]);
  const buffer = detached.buffer;
  let calls = 0;
  detached.some(function () {
    if (calls === 0) buffer.__detached__ = true;
    calls++;
    return false;
  });
  return sum === 11 && calls === 3 ? 1 : 0;
}
export function probe() { return run(Float64Array); }
`;

const LIVE_LENGTH_SOURCE = `
function run(TA) {
  const buffer = new ArrayBuffer(2, { maxByteLength: 4 });
  const a = new TA(buffer);
  buffer.resize(3);
  let calls = 0;
  a.forEach(function () { calls++; });
  return calls === 3 ? 1 : 0;
}
export function probe() { return run(Int8Array); }
`;

describe("#6832 direct dynamic TypedArray HOF internal lengths", () => {
  describe("own length accessors", () => {
    for (const hof of HOF_CASES) {
      it(`ignores ${hof.name}`, async () => {
        expect(await runStandalone(directLengthSource(hof.direct, "own")), hof.name).toBe(1);
      });
    }
  });

  describe("prototype length accessors", () => {
    for (const hof of HOF_CASES) {
      it(`ignores ${hof.name}`, async () => {
        expect(await runStandalone(directLengthSource(hof.direct, "prototype")), hof.name).toBe(1);
      });
    }
  });

  describe("borrowed Array HOFs", () => {
    for (const hof of HOF_CASES) {
      it(`keeps ${hof.name} on observable LengthOfArrayLike`, async () => {
        expect(await runStandalone(borrowedLengthSource(hof.borrowed)), hof.name).toBe(1);
      });
    }
  });

  it("covers both no-presence-gate and presence-gate TypedArray clone shapes", async () => {
    expect(await runStandalone(PRESENCE_GATE_SOURCE)).toBe(1);
  });

  it("leaves dense and sparse generic Array HOF behavior unchanged", async () => {
    expect(await runStandalone(ARRAY_CONTROLS_SOURCE)).toBe(1);
  });

  it("keeps callback receiver identity, short-circuit order, and reducer direction", async () => {
    expect(await runStandalone(CALLBACK_AND_REDUCER_SOURCE)).toBe(1);
  });

  it("preserves mutation visibility, post-callback detachment, and live tracking length", async () => {
    expect(await runStandalone(MUTATION_AND_DETACH_SOURCE)).toBe(1);
    expect(await runStandalone(LIVE_LENGTH_SOURCE)).toBe(1);
  });
});
