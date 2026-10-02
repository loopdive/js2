// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildVecPopBody, type VecPopEntry } from "../src/codegen/vec-pop-body.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const artifacts = mkdtempSync(join(tmpdir(), "js2-5883-P-"));
import { createHash } from "node:crypto";

function unique<T>(matches: T[], label: string): T {
  if (matches.length !== 1) throw new Error(`${label}: expected one match, found ${matches.length}`);
  return matches[0]!;
}

// Extract only a matching carrier's then-arm, including nested empty guards.
function balancedThen(body: string, start: number): string {
  const then = /^\s*\(then\b/.exec(body.slice(start));
  if (!then) throw new Error("missing then-arm");
  const open = start + then[0].indexOf("(");
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "(") depth++;
    if (body[i] === ")" && --depth === 0) return body.slice(open + 5, i);
  }
  throw new Error("unbalanced then-arm");
}

function externrefArm(body: string, vec: number): string {
  const test = unique(
    [...body.matchAll(new RegExp(`ref\\.test \\(ref ${vec}\\)\\s+\\(if\\b`, "g"))],
    "externref carrier",
  );
  return balancedThen(body, test.index! + test[0].length);
}

function provePopGet(popBody: string, getBody: string, vec: number, arr: number, get: number) {
  const arm = externrefArm(popBody, vec);
  const getArm = externrefArm(getBody, vec);
  const getCall = unique([...arm.matchAll(new RegExp(`\\bcall ${get}\\b`, "g"))], "exact Get call").index!;
  const decrement = unique(
    [...arm.matchAll(new RegExp(`struct\\.set ${vec} 0\\b`, "g"))],
    "externref length write",
  ).index!;
  // Backreferences tie both call operands and the write to the same locals.
  const sequence = unique(
    [
      ...arm.matchAll(
        new RegExp(
          `local\\.get (\\d+)\\s+extern\\.convert_any\\s+local\\.get (\\d+)\\s+i32\\.const 1\\s+i32\\.sub\\s+call ${get}\\s+` +
            `local\\.get \\1\\s+local\\.get \\2\\s+i32\\.const 1\\s+i32\\.sub\\s+struct\\.set ${vec} 0\\b`,
          "g",
        ),
      ),
    ],
    "same receiver/length Get-before-write sequence",
  );
  const binding = new RegExp(
    `ref\\.cast \\(ref ${vec}\\)\\s+local\\.(?:tee|set) ${sequence[1]}\\s+` +
      `(?:local\\.get ${sequence[1]}\\s+)?struct\\.get ${vec} 0\\s+local\\.(?:tee|set) ${sequence[2]}\\b`,
  );
  if (!binding.test(arm.slice(0, sequence.index))) throw new Error("missing matching receiver/length binding");
  // The two unsigned bounds feed this exact conditional, not another carrier.
  const guard = unique(
    [
      ...getArm.matchAll(
        new RegExp(
          `local\\.get 1\\s+local\\.get (\\d+)\\s+ref\\.cast \\(ref ${vec}\\)\\s+struct\\.get ${vec} 0\\s+i32\\.lt_u\\s+` +
            `local\\.get 1\\s+local\\.get \\1\\s+ref\\.cast \\(ref ${vec}\\)\\s+struct\\.get ${vec} 1\\s+` +
            `array\\.len\\s+i32\\.lt_u\\s+i32\\.and\\s+\\(if \\(result externref\\)`,
          "g",
        ),
      ),
    ],
    "matching logical-length/capacity guard",
  );
  const read = balancedThen(getArm, guard.index! + guard[0].length);
  if (
    !new RegExp(
      `^\\s*local\\.get ${guard[1]}\\s+ref\\.cast \\(ref ${vec}\\)\\s+struct\\.get ${vec} 1\\s+` +
        `local\\.get 1\\s+array\\.get ${arr}\\b`,
    ).test(read)
  )
    throw new Error("missing guarded externref backing read");
  return { arm, getArm, getCall, decrement, capacityCheck: getArm.indexOf("array.len"), sequence: sequence[0] };
}

describe("5883 pop dispatcher terminal contract", () => {
  for (const [name, entries] of [
    ["empty", []],
    ["skipped carrier", [undefined]],
    ["carrier", [{ elemKey: "externref", vecTypeIdx: 0, arrTypeIdx: 1, isNativeStr: false, storageGet: undefined }]],
  ] as const) {
    it(name, () => {
      const result = buildVecPopBody(entries as readonly (Readonly<VecPopEntry> | undefined)[], undefined);
      expect(result.body.at(-1)).toEqual({ op: "unreachable" });
      // The explicit terminal instruction supplements, rather than replaces,
      // the original returning fallback / carrier dispatch.
      expect(result.body.at(-2)?.op).toBe(name === "carrier" ? "if" : "return");
    });
  }
});

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
        const namedFunction = (name: string) =>
          unique(
            functions.filter((fn) => fn.name === name),
            name,
          );
        const pop = namedFunction("pop");
        const dispatcher = namedFunction("__call_m_pop_0");
        const storage = namedFunction("__vec_pop");
        const get = namedFunction("__vec_get");
        const types = [...result.wat.matchAll(/^ {2}\(type \$([^\s(]+)/gm)];
        const namedType = (name: string) =>
          unique(
            types.map((match, index) => ({ name: match[1], index })).filter((type) => type.name === name),
            name,
          ).index;
        const vec = namedType("__vec_externref");
        const arr = namedType("__arr_externref");
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
        const directStorage = new RegExp(`(?:return_call|call) ${storage.index}\\b`).test(dispatcher.body);
        if (!directStorage) {
          expect(dispatcher.body).toMatch(/__vpop_/);
        }
        const selected = directStorage ? storage.body : dispatcher.body;
        const proof = provePopGet(selected, get.body, vec, arr, get.index);
        expect(proof.getCall).toBeGreaterThanOrEqual(0);
        expect(proof.decrement).toBeGreaterThan(proof.getCall);
        expect(proof.getArm).toMatch(/array\.len/);
        expect(proof.capacityCheck).toBeGreaterThanOrEqual(0);
        if (shape === "dense" && optimize === 0) {
          // Mutate only instrument input strings, never the emitted module.
          const call = `call ${get.index}`;
          const write = `struct.set ${vec} 0`;
          const mutateArm = (arm: string) => selected.replace(proof.arm, arm);
          expect(() => provePopGet(mutateArm(proof.arm.replace(call, "nop")), get.body, vec, arr, get.index)).toThrow(
            "exact Get call",
          );
          expect(() =>
            provePopGet(mutateArm(proof.arm.replace(write, `struct.set ${vec + 1} 0`)), get.body, vec, arr, get.index),
          ).toThrow("externref length write");
          const reversed = proof.sequence
            .replace(call, "__GET_CALL__")
            .replace(write, call)
            .replace("__GET_CALL__", write);
          expect(() =>
            provePopGet(mutateArm(proof.arm.replace(proof.sequence, reversed)), get.body, vec, arr, get.index),
          ).toThrow("same receiver/length Get-before-write sequence");
          const capacityCount = (body: string) => [...body.matchAll(/\barray\.len\b/g)].length;
          expect(capacityCount(proof.getArm)).toBe(1);
          const withoutCapacity = get.body.replace(proof.getArm, proof.getArm.replace("array.len", "nop"));
          expect(capacityCount(externrefArm(withoutCapacity, vec))).toBe(0);
          expect(capacityCount(withoutCapacity)).toBe(capacityCount(get.body) - 1);
          const movedCapacity = withoutCapacity.replace(/\n {2}\)\s*$/, "\n    array.len\n  )");
          expect(movedCapacity).not.toBe(withoutCapacity);
          expect(capacityCount(externrefArm(movedCapacity, vec))).toBe(0);
          expect(capacityCount(movedCapacity)).toBe(capacityCount(get.body));
          expect(() => provePopGet(selected, movedCapacity, vec, arr, get.index)).toThrow(
            "matching logical-length/capacity guard",
          );
        }
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
