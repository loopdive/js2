// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const artifacts = mkdtempSync(join(tmpdir(), "js2-5883-P-"));
import { createHash } from "node:crypto";

describe("5883 P externref nonempty storage pop", () => {
  for (const optimize of [0, 2] as const)
    for (const [shape, initializer, growth, expected] of [
      ["dense", "[1]", "", 100],
      ["Hole", "[1,,]", "", 1],
      ["unbacked", "[1]", "values.length=3;", 2],
      ["undefined", "[undefined]", "", 0],
      ["null", "[null]", "", 400],
      ["NaN", "[0/0]", "", 800],
      ["identity", "[marker]", "", 700],
    ] as const) {
      it(`${shape} O${optimize}`, async () => {
        const source = `export function pop(values:any):any {return values.pop();}
export function classify(value:any, marker:any):number {if(value===undefined)return 0;if(value===null)return 4;if(value===marker)return 7;if(value!==value)return 8;if(value===1)return 1;return 9;}
export function test():number {const marker:any={x:7};const values:any[]=${initializer};${growth}return classify(pop(values),marker)*100+values.length;}`;
        const result = await compile(source, {
          fileName: "5883-P-pop.ts",
          target: "standalone",
          nativeStrings: true,
          optimize,
          emitWat: true,
          trackIrOutcomes: true,
        });
        const watPath = join(artifacts, `pop-${shape}-O${optimize}.wat`);
        writeFileSync(watPath, result.wat);
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        const module = await WebAssembly.compile(result.binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = await WebAssembly.instantiate(module, {});
        let actual: number | string;
        try {
          actual = (instance.exports.test as () => number)();
        } catch (error) {
          actual = String(error);
        }
        const headers = [...result.wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)];
        const functions = headers.map((match, index) => ({
          name: match[1],
          index,
          body: result.wat.slice(match.index, headers[index + 1]?.index ?? result.wat.length),
        }));
        const pop = functions.find((fn) => fn.name === "pop")!;
        const dispatcher = functions.find((fn) => fn.name === "__call_m_pop_0")!;
        const storage = functions.find((fn) => fn.name === "__vec_pop")!;
        const get = functions.find((fn) => fn.name === "__vec_get")!;
        console.log(
          JSON.stringify({
            receipt: "5883-P",
            shape,
            optimize,
            source,
            sourceHash: createHash("sha256").update(source).digest("hex"),
            watPath,
            actual,
            expected,
            outcomes: result.irOutcomes,
            popIndex: pop?.index,
            dispatcherIndex: dispatcher?.index,
            storageIndex: storage?.index,
          }),
        );
        expect(pop.body).toMatch(new RegExp(`(?:return_call|call) ${dispatcher.index}\\b`));
        // The real source dispatcher contains the inlined pop/Get, or calls
        // the exact emitted storage pop; mere export presence is insufficient.
        if (!new RegExp(`(?:return_call|call) ${storage.index}\\b`).test(dispatcher.body)) {
          expect(dispatcher.body).toMatch(/__vpop_/);
          const getCall = dispatcher.body.search(new RegExp(`(?:return_call|call) ${get.index}\\b`));
          expect(getCall).toBeGreaterThanOrEqual(0);
          expect(dispatcher.body.search(/struct\.set \d+ 0/)).toBeGreaterThan(getCall);
          expect(get.body).toMatch(/array\.len/);
        }
        const capacityCheck = storage.body.indexOf("array.len");
        const decrement = storage.body.search(/struct\.set \d+ 0/);
        expect(capacityCheck).toBeGreaterThanOrEqual(0);
        expect(decrement).toBeGreaterThan(capacityCheck);
        expect(actual).toBe(expected);
      }, 120000);
    }
});

describe("5883 direct published storage Get (not source IR read conformance)", () => {
  for (const optimize of [0, 2] as const)
    for (const [shape, declaration, expected, backing] of [
      ["externref-values", "const a:any[]=[1,,undefined,null,NaN,marker];", [1, 0, 0, 4, 8, 7], "externref"],
      ["f64-values", "const a:number[]=[1,,undefined,NaN] as number[];", [1, 0, 0, 8], "f64"],
      ["externref-unbacked", "const a:any[]=[1];a.length=3;", [1, 0, 0], "externref"],
      ["f64-unbacked", "const a:number[]=[1];a.length=3;", [1, 0, 0], "f64"],
    ] as const) {
      it(`${shape} O${optimize}`, async () => {
        const source = `const marker:any={x:7};
export function receiver():any {${declaration}return a;}
export function classify(value:any):number {if(value===undefined)return 0;if(value===null)return 4;if(value!==value)return 8;if(value===1)return 1;if(value===marker)return 7;return 9;}`;
        // Use the existing public bridge option, not a fabricated registry or
        // export-section patch. These calls exercise the allocated, filled Get
        // body directly; P above separately proves ordinary source reachability.
        const result = await compile(source, {
          fileName: "5883-direct-storage-get.ts",
          target: "standalone",
          hostBridge: "always",
          nativeStrings: true,
          optimize,
          emitWat: true,
          trackIrOutcomes: true,
        });
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        const watPath = join(artifacts, `get-${shape}-O${optimize}.wat`);
        writeFileSync(watPath, result.wat);
        const module = await WebAssembly.compile(result.binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        expect(WebAssembly.Module.exports(module)).toContainEqual({ name: "__vec_get", kind: "function" });
        const instance = await WebAssembly.instantiate(module, {});
        const receiver = (instance.exports.receiver as () => unknown)();
        const get = instance.exports.__vec_get as (receiver: unknown, index: number) => unknown;
        const classify = instance.exports.classify as (value: unknown) => number;
        const actual = expected.map((_, index) => classify(get(receiver, index)));
        const headers = [...result.wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)];
        const receiverHeader = headers.findIndex((match) => match[1] === "receiver");
        expect(receiverHeader).toBeGreaterThanOrEqual(0);
        const receiverBody = result.wat.slice(headers[receiverHeader]!.index, headers[receiverHeader + 1]?.index);
        const types = [...result.wat.matchAll(/^ {2}\(type \$([^\s(]+)/gm)];
        const arrType = types.findIndex((match) => match[1] === `__arr_${backing}`);
        expect(arrType).toBeGreaterThanOrEqual(0);
        // Pin the actual source-created backing, not its TS annotation.
        expect(receiverBody).toMatch(new RegExp(`array.new_fixed ${arrType} \\d+`));
        console.log(
          JSON.stringify({
            receipt: "5883-direct-storage-Get",
            shape,
            optimize,
            source,
            sourceHash: createHash("sha256").update(source).digest("hex"),
            watPath,
            backing,
            actual,
            expected,
            outcomes: result.irOutcomes,
          }),
        );
        expect(actual).toEqual(expected);
      }, 120000);
    }
});

describe("5883 lookup preservation receipts (NOT JavaScript conformance)", () => {
  // Exact paired 647343cc/candidate sources and receipts are recorded in the
  // P handoff. 310 preserves the observed defect: these overrides are ignored.
  // Do not present these controls as proving own/prototype/getter semantics.
  const cases = {
    own: "(values as any).pop=function():number{return 7;};",
    prototype: "(Array.prototype as any).pop=function():number{return 8;};",
    getter:
      "Object.defineProperty(values,'pop',{get:function():any{trace=trace*10+1;return function():number{trace=trace*10+2;return 7;};}});",
    order: "(values as any).pop=function():number{trace=trace*10+2;return 7;};",
  };
  for (const optimize of [0, 2] as const)
    for (const [name, setup] of Object.entries(cases))
      it(`${name} O${optimize}: fixed preservation receipt`, async () => {
        const source = `let trace:number=0;export function pop(values:any):any {return values.pop();}
export function test():number {const values:any[]=[1];${setup}trace=trace*10+3;const value=pop(values);return trace*100+value*10+values.length;}`;
        const result = await compile(source, {
          fileName: "5883-P-lookup.ts",
          target: "standalone",
          nativeStrings: true,
          optimize,
        });
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        const module = await WebAssembly.compile(result.binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = await WebAssembly.instantiate(module, {});
        const actual = (instance.exports.test as () => number)();
        console.log(
          JSON.stringify({
            receipt: "5883-P-lookup-preservation-not-conformance",
            name,
            optimize,
            source,
            sourceHash: createHash("sha256").update(source).digest("hex"),
            actual,
            fixedBaseline: 310,
          }),
        );
        expect(actual).toBe(310);
      }, 120000);
});
