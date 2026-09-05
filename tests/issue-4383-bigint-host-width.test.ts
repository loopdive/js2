import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";
import { compileToWasm } from "./equivalence/helpers.js";

const WIDE = 170141183460469231731687303715884105851n; // 2^127 + 123

describe("#4383 JS-host BigInt arbitrary-width carrier", () => {
  it("keeps local, captured, and global ++/-- in the BigInt lane", async () => {
    const exports = await compileToWasm(`
      let moduleValue: bigint = ${WIDE}n;

      export function localPrefix(): bigint {
        let value: bigint = ${WIDE}n;
        return ++value;
      }
      export function localPostfix(): bigint {
        let value: bigint = ${WIDE}n;
        return value++;
      }
      export function capturedPrefix(): bigint {
        let value: bigint = ${WIDE}n;
        function inner(): bigint { return ++value; }
        return inner();
      }
      export function capturedPostfix(): bigint {
        let value: bigint = ${WIDE}n;
        function inner(): bigint { return value--; }
        return inner();
      }
      export function globalPrefix(): bigint { return ++moduleValue; }
      export function globalPostfix(): bigint { return moduleValue--; }
    `);

    expect(exports.localPrefix!()).toBe(WIDE + 1n);
    expect(exports.localPostfix!()).toBe(WIDE);
    expect(exports.capturedPrefix!()).toBe(WIDE + 1n);
    expect(exports.capturedPostfix!()).toBe(WIDE);
    expect(exports.globalPrefix!()).toBe(WIDE + 1n);
    expect(exports.globalPostfix!()).toBe(WIDE + 1n);
  });

  it("keeps bigint interface fields as externrefs", async () => {
    const exports = await compileToWasm(`
      interface Box { value: bigint; }
      const box: Box = { value: ${WIDE}n };
      const postfixBox: Box = { value: ${WIDE}n };
      const prefixBox: Box = { value: ${WIDE}n };
      const postfixMinusBox: Box = { value: ${WIDE}n };
      const prefixMinusBox: Box = { value: ${WIDE}n };
      const plusEqualsBox: Box = { value: ${WIDE}n };
      const minusEqualsBox: Box = { value: ${WIDE}n };
      export function get(): bigint { return box.value; }
      export function postfix(): bigint { return postfixBox.value++; }
      export function prefix(): bigint { return ++prefixBox.value; }
      export function postfixMinus(): bigint { return postfixMinusBox.value--; }
      export function prefixMinus(): bigint { return --prefixMinusBox.value; }
      export function plusEquals(): bigint { return plusEqualsBox.value += 1n; }
      export function minusEquals(): bigint { return minusEqualsBox.value -= 1n; }
      export function set(): bigint {
        box.value = ${WIDE}n + 1n;
        return box.value;
      }
    `);

    expect(exports.get!()).toBe(WIDE);
    expect(exports.postfix!()).toBe(WIDE);
    expect(exports.prefix!()).toBe(WIDE + 1n);
    expect(exports.postfixMinus!()).toBe(WIDE);
    expect(exports.prefixMinus!()).toBe(WIDE - 1n);
    expect(exports.plusEquals!()).toBe(WIDE + 1n);
    expect(exports.minusEquals!()).toBe(WIDE - 1n);
    expect(exports.set!()).toBe(WIDE + 1n);
  });

  it("keeps wide BigInts in array element updates and compound assignment", async () => {
    const exports = await compileToWasm(`
      const postfixValues: bigint[] = [${WIDE}n];
      const prefixValues: bigint[] = [${WIDE}n];
      const postfixMinusValues: bigint[] = [${WIDE}n];
      const prefixMinusValues: bigint[] = [${WIDE}n];
      const plusEqualsValues: bigint[] = [${WIDE}n];
      const minusEqualsValues: bigint[] = [${WIDE}n];
      const compoundValues: bigint[] = [${WIDE}n];
      export function postfix(): bigint { return postfixValues[0]++; }
      export function prefix(): bigint { return ++prefixValues[0]; }
      export function postfixMinus(): bigint { return postfixMinusValues[0]--; }
      export function prefixMinus(): bigint { return --prefixMinusValues[0]; }
      export function plusEquals(): bigint { return plusEqualsValues[0] += 1n; }
      export function minusEquals(): bigint { return minusEqualsValues[0] -= 1n; }
      export function compound(): bigint { return compoundValues[0] += 1n; }
    `);

    expect(exports.postfix!()).toBe(WIDE);
    expect(exports.prefix!()).toBe(WIDE + 1n);
    expect(exports.postfixMinus!()).toBe(WIDE);
    expect(exports.prefixMinus!()).toBe(WIDE - 1n);
    expect(exports.plusEquals!()).toBe(WIDE + 1n);
    expect(exports.minusEquals!()).toBe(WIDE - 1n);
    expect(exports.compound!()).toBe(WIDE + 1n);
  });

  it("evaluates BigInt array bases and keys exactly once per update", async () => {
    const exports = await compileToWasm(`
      const values: bigint[] = [${WIDE}n];
      let baseCalls = 0;
      let keyCalls = 0;
      function getValues(): bigint[] { baseCalls++; return values; }
      function getIndex(): number { keyCalls++; return 0; }
      export function update(): bigint { return getValues()[getIndex()]++; }
      export function counts(): number { return baseCalls * 10 + keyCalls; }
    `);

    expect(exports.update!()).toBe(WIDE);
    expect(exports.counts!()).toBe(11);
    expect(exports.update!()).toBe(WIDE + 1n);
    expect(exports.counts!()).toBe(22);
  });

  it("keeps Object(wideBigInt).valueOf() exact in JS-host mode", async () => {
    const exports = await compileToWasm(`
      export function objectValueOf(): bigint {
        return Object(${WIDE}n).valueOf();
      }
    `);

    expect(exports.objectValueOf!()).toBe(WIDE);
  });

  it.each(["standalone", "wasi"] as const)(
    "keeps %s Object(BigInt) boxing on the native i64 helper",
    async (target) => {
      const result = await compile(`export function test(): bigint { return Object(123n).valueOf(); }`, {
        target,
        emitWat: true,
        optimize: 0,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(result.imports.some((entry) => entry.name === "__new_BigInt")).toBe(false);
      expect(result.wat).toContain("(func $__new_BigInt (param i64) (result externref)");
    },
  );

  it("preserves a wide BigInt through any-return and module initialization", async () => {
    const exports = await compileToWasm(`
      const value: any = ${WIDE}n;
      export function direct(): any { return ${WIDE}n; }
      export function throughAny(): bigint { return value; }
    `);

    expect(exports.direct!()).toBe(WIDE);
    expect(exports.throughAny!()).toBe(WIDE);
  });

  it("does not feed native fast-mode strings to the host BigInt constructor", async () => {
    const result = await compile(
      `
        const value: any = ${WIDE}n;
        export function test(): bigint { return value; }
      `,
      { fast: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const built = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
    built.setInstance?.(instance);
    const test = instance.exports.test;
    expect(test).toBeTypeOf("function");
    expect((test as () => unknown)()).toBe(WIDE);
  });

  it("passes wide literals through conditional, logical, and nullish branches", async () => {
    const exports = await compileToWasm(`
      export function conditionalTrue(): bigint { return true ? ${WIDE}n : 0n; }
      export function conditionalFalse(): bigint { return false ? 0n : ${WIDE}n; }
      export function andWide(): bigint { return ${WIDE}n && ${WIDE}n; }
      export function andZero(): bigint { return 0n && ${WIDE}n; }
      export function orWide(): bigint { return ${WIDE}n || 0n; }
      export function orZero(): bigint { return 0n || ${WIDE}n; }
      export function nullishWide(): bigint { return null ?? ${WIDE}n; }
    `);

    expect(exports.conditionalTrue!()).toBe(WIDE);
    expect(exports.conditionalFalse!()).toBe(WIDE);
    expect(exports.andWide!()).toBe(WIDE);
    expect(exports.andZero!()).toBe(0n);
    expect(exports.orWide!()).toBe(WIDE);
    expect(exports.orZero!()).toBe(WIDE);
    expect(exports.nullishWide!()).toBe(WIDE);
  });

  it("keeps wide BigInts in host mixed-operand dispatch", async () => {
    const exports = await compileToWasm(`
      const one: any = 1n;
      export function addAny(): bigint { return ${WIDE}n + one; }
      export function multiplyAny(): bigint { return ${WIDE}n * one; }
    `);

    expect(exports.addAny!()).toBe(WIDE + 1n);
    expect(exports.multiplyAny!()).toBe(WIDE);
  });

  it("keeps BigInt, String, and Boolean constructors exact for wide literals", async () => {
    const exports = await compileToWasm(`
      export function bigintCtor(): bigint { return BigInt(${WIDE}n); }
      export function stringCtor(): string { return String(${WIDE}n); }
      export function booleanCtor(): boolean { return Boolean(${WIDE}n); }
    `);

    expect(exports.bigintCtor!()).toBe(WIDE);
    expect(exports.stringCtor!()).toBe(String(WIDE));
    // Boolean-valued Wasm exports use the established i32 ABI (1 = true).
    expect(exports.booleanCtor!()).toBe(1);
  });
});
