// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import ts from "typescript";
import receipt from "../plan/agent-context/5753-call-reused-arguments-20260927.json";

const root = process.env.FUNCTION_CALL_CONTROL_ROOT;
const { compile } = await import(root ? pathToFileURL(resolve(root, "src/index.ts")).href : "../src/index.js");

const variants = [
  ["dense", ""],
  ["grow", "args.length = 14;"],
  ["deleted", "delete args[2];"],
  ["inherited", "delete args[2]; Object.setPrototypeOf(args, {2: 17});"],
  ["accessor", 'Object.defineProperty(args, "2", {get() { reads++; return 17; }});'],
  ["shrink-at-zero", 'Object.defineProperty(args, "0", {get() { reads++; args.length = 1; return undefined; }});'],
  ["grow-at-zero", 'Object.defineProperty(args, "0", {get() { reads++; args[12] = 17; return undefined; }});'],
  ["throwing", 'Object.defineProperty(args, "2", {get() { reads++; throw 19; }});'],
] as const;

it.each(variants)("preserves exact c6ece2eb Function.call outcome (not conformance): %s", async (variant, mutation) => {
  const source = `
    const callValue: any = Function.prototype.call;
    let reads = 0;
    let calls = 0;
    function classify(x: any): number { return x === undefined ? 0 : x === 17 ? 7 : x === 1 ? 1 : 9; }
    function target(this: any, a: any, b: any, c: any, d: any, e: any, f: any, g: any, h: any, i: any): number {
      calls++;
      return classify(a) + 10 * classify(b) + 100 * classify(i);
    }
    export function run(): number {
      const args: any[] = [undefined, 1, 1, 1, 1, 1, 1, 1, 1, 1];
      ${mutation}
      try { return callValue.apply(target, args) + 1000 * reads + 10000 * calls; }
      catch (e) { return (e === 19 ? 19 : -1) + 1000 * reads + 10000 * calls; }
    }
  `;
  const nativeExports: { run?: () => number } = {};
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  Function("exports", javascript)(nativeExports);
  const native = nativeExports.run!();
  const result = await compile(source, { target: "standalone", optimize: 0 });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  const actual = (instance.exports.run as () => number)();
  console.log(JSON.stringify({ variant, native, actual, compiler: root ?? "candidate", source }));
  const original = receipt.rows.find((row) => row.variant === variant);
  expect(original, "missing exact-parent receipt").toBeDefined();
  expect(source).toBe(original!.source);
  expect(native).toBe(original!.native);
  expect(actual).toBe(original!.baseline);
  // Six rows are correct in both; two retain explicitly recorded native mismatches.
  // Neither a preserved wrong result nor this comparison authorizes retirement.
  expect(actual === native).toBe(original!.conformant);
});
