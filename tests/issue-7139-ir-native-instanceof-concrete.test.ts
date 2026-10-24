// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { WASI } from "node:wasi";
import { compile } from "../src/index.js";

const SOURCE = `
class C{}
export function target():any{return C;}
export function handler():any{const K:any={};K[Symbol.hasInstance]=function(v:any):boolean{return v===7||v===true||v==="ok"||v===null||v===-1||v===4294967295||v===2147483648||v==="object";};return K;}
export function numberLeft(v:number,K:any):boolean{return v instanceof K;}
export function unsignedLeft(v:number,K:any):boolean{return (v>>>0) instanceof K;}
export function integerLeft(v:number,K:any):boolean{return (v|0) instanceof K;}
export function booleanLeft(v:boolean,K:any):boolean{return v instanceof K;}
export function stringLeft(v:string,K:any):boolean{return v instanceof K;}
export function stringCase(K:any,good:boolean):boolean{return stringLeft(good?"ok":"no",K);}
export function nullLeft(K:any):boolean{return null instanceof K;}
export function logicalRight(K:any,P:any):boolean{return 7 instanceof (K||P);}
export function logicalLeft(K:any,P:any):boolean{return (K||P) instanceof 7;}
export function typeofLeft(K:any,P:any):boolean{return (typeof K) instanceof P;}
export function numberRight(v:any):boolean{return v instanceof 7;}
export function booleanRight(v:any):boolean{return v instanceof true;}
export function stringRight(v:any):boolean{return v instanceof "ok";}
export function nullRight(v:any):boolean{return v instanceof null;}
let order:number=0;
function leftNumber():number{order=order*10+1;return 7;}
function rightTarget(K:any):any{order=order*10+2;return K;}
export function ordered(K:any):number{order=0;const result=leftNumber() instanceof rightTarget(K);return(result?100:0)+order;}
function leftValue(v:any):any{order=order*10+1;return v;}
function rightNumber():number{order=order*10+2;return 7;}
export function invalidOrdered(v:any):boolean{order=0;return leftValue(v) instanceof rightNumber();}
export function readOrder():number{return order;}
export function errorKind(e:any):number{return e instanceof TypeError?1:0;}
`;

const IR_FUNCTIONS = [
  "numberLeft",
  "unsignedLeft",
  "integerLeft",
  "booleanLeft",
  "stringLeft",
  "stringCase",
  "nullLeft",
  "logicalRight",
  "logicalLeft",
  "typeofLeft",
  "numberRight",
  "booleanRight",
  "stringRight",
  "nullRight",
  "leftNumber",
  "rightTarget",
  "ordered",
  "leftValue",
  "rightNumber",
  "invalidOrdered",
];

for (const target of ["standalone", "wasi"] as const) {
  describe(`native concrete instanceof operands: ${target}`, () => {
    let result: Awaited<ReturnType<typeof compile>>;
    let x: Record<string, any>;
    beforeAll(async () => {
      result = await compile(SOURCE, {
        target,
        experimentalIR: true,
        trackIrOutcomes: true,
        skipSemanticDiagnostics: true,
      });
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(result.irPostClaimErrors).toEqual([]);
      const module = new WebAssembly.Module(result.binary);
      expect(WebAssembly.Module.imports(module).filter((i) => i.module !== "wasi_snapshot_preview1")).toEqual([]);
      const wasi =
        target === "wasi" ? new WASI({ version: "preview1", args: [], env: {}, returnOnExit: true }) : undefined;
      const instance = new WebAssembly.Instance(module, {
        ...(result.importObject ?? {}),
        ...(wasi ? wasi.getImportObject() : {}),
      });
      x = instance.exports;
      if (wasi && typeof x._start === "function") expect(wasi.start(instance)).toBe(0);
      else x.__module_init?.();
    });
    for (const name of IR_FUNCTIONS) {
      it(`owns ${name} only through IR`, () => {
        const rows = result.irOutcomes?.filter((row) => row.unitKind === "function" && row.displayName === name);
        expect(rows).toHaveLength(1);
        expect(rows![0].irBodyEmitted, rows![0].kind).toBe(true);
        expect(rows![0].legacyBodyEmitted).toBe(false);
        expect(rows![0].directBodyEmissions).toBe(0);
      });
    }
    for (const [name, value, other] of [
      ["numberLeft", 7, 8],
      ["booleanLeft", true, false],
    ] as const) {
      it(`preserves the ${name} value and brand for a custom handler`, () => {
        expect(x[name](value, x.handler())).toBe(1);
        expect(x[name](other, x.handler())).toBe(0);
        expect(x[name](value, x.target())).toBe(0);
      });
    }
    it("preserves uint32 values above the signed boundary", () => {
      expect(x.unsignedLeft(-1, x.handler())).toBe(1);
      expect(x.unsignedLeft(-2147483648, x.handler())).toBe(1);
      expect(x.unsignedLeft(0, x.handler())).toBe(0);
      expect(x.unsignedLeft(-1, x.target())).toBe(0);
    });
    it("preserves signed int32 values", () => {
      expect(x.integerLeft(-1, x.handler())).toBe(1);
      expect(x.integerLeft(4294967295, x.handler())).toBe(1);
      expect(x.integerLeft(0, x.handler())).toBe(0);
    });
    it("preserves native strings for a custom handler", () => {
      expect(x.stringCase(x.handler(), true)).toBe(1);
      expect(x.stringCase(x.handler(), false)).toBe(0);
      expect(x.stringCase(x.target(), true)).toBe(0);
    });
    it("retains composed dynamic operands", () => {
      expect(x.logicalRight(x.handler(), null)).toBe(1);
      expect(x.logicalRight(null, x.handler())).toBe(1);
      expect(x.logicalRight(x.target(), null)).toBe(0);
    });
    it("keeps typeof's native string carrier in the prepared body", () => {
      expect(x.typeofLeft(null, x.handler())).toBe(1);
      expect(x.typeofLeft(null, x.target())).toBe(0);
    });
    it("passes null through the custom-handler protocol", () => {
      expect(x.nullLeft(x.handler())).toBe(1);
      expect(x.nullLeft(x.target())).toBe(0);
    });
    for (const name of ["numberRight", "booleanRight", "stringRight", "nullRight", "invalidOrdered", "logicalLeft"]) {
      it(`throws TypeError for ${name} after evaluating both operands`, () => {
        let caught: unknown;
        try {
          x[name](null);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(WebAssembly.Exception);
        const error = caught as WebAssembly.Exception;
        expect(error.is(x.__exn_tag)).toBe(true);
        expect(x.errorKind(error.getArg(x.__exn_tag, 0))).toBe(1);
        if (name === "invalidOrdered") expect(x.readOrder()).toBe(12);
      });
    }
    it("evaluates concrete left then dynamic right once", () => {
      expect(x.ordered(x.handler())).toBe(112);
      expect(x.ordered(x.target())).toBe(12);
    });
  });
}
