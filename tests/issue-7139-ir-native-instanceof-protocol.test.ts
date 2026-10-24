// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WASI } from "node:wasi";
import { compile } from "../src/index.js";
import { irVal } from "../src/ir/nodes.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";

const SOURCE = `
class C{m():number{return 3;}}class D{m():number{return 5;}}
function check(o:any,K:any):boolean{return o instanceof K;}
export function forward(o:any,K:any):boolean{return check(o,K);}
export function makeC():any{return new C();}export function makeD():any{return new D();}
export function targetC():any{return C;}export function targetD():any{return D;}
export function seven():any{return 7;}export function zero():any{return 0;}
export function empty():any{return {};}
export function undefinedValue():any{return undefined;}
export function arrow():any{return ()=>1;}
export function handler():any{const F:any={};F[Symbol.hasInstance]=function(v:any):boolean{return v===7;};return F;}
export function nonCallable():any{const F:any={};F[Symbol.hasInstance]=1;return F;}
export function bound():any{function F(){};const K:any=F;Object.defineProperty(K,Symbol.hasInstance,{value:function(v:any):boolean{return v===7;}});return F.bind(null);}
export function twiceBound():any{function G(){};const K:any=G;Object.defineProperty(K,Symbol.hasInstance,{value:function(v:any):boolean{return v===7;}});return G.bind(null).bind(null);}
export function poison():any{const K:any=()=>1;Object.defineProperty(K,"prototype",{value:null});return K;}
export function symbolValue():any{return Symbol("prototype");}
export function prototypeValue(p:any):any{const K:any=()=>1;Object.defineProperty(K,"prototype",{value:p});return K;}
export function throwingHandler():any{const K:any={};Object.defineProperty(K,Symbol.hasInstance,{get:function():any{throw new RangeError("handler getter");}});return K;}
export function throwingPrototype():any{const K:any=()=>1;Object.defineProperty(K,"prototype",{get:function():any{throw new RangeError("prototype getter");}});return K;}
export function counter():any{return {count:0};}
export function readCount(c:any):number{return c.count;}
export function countedHandler(c:any):any{const K:any={};Object.defineProperty(K,Symbol.hasInstance,{get:function():any{c.count=c.count+1;return function(this:any,v:any):any{return this===K&&v===7?"yes":"";};}});return K;}
export function countedPrototype(c:any):any{const K:any=()=>1;Object.defineProperty(K,"prototype",{get:function():any{c.count=c.count+1;return {};}});return K;}
export function errorKind(e:any):number{return e instanceof TypeError?1:e instanceof RangeError?2:0;}
let order:number=0;
function left(v:any):any{order=order*10+1;return v;}
function right(v:any):any{order=order*10+2;return v;}
export function ordered(o:any,K:any):number{order=0;const result=left(o) instanceof right(K);return(result?100:0)+order;}
export function readOrder():number{return order;}
`;

async function instantiateNative(source: string, target: "standalone" | "wasi", experimentalIR: boolean) {
  const result = await compile(source, { target, experimentalIR, trackIrOutcomes: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors).toEqual([]);
  const importsInBinary = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
  expect(importsInBinary.filter((entry) => entry.module !== "wasi_snapshot_preview1")).toEqual([]);
  const wasi = target === "wasi" ? new WASI({ version: "preview1", args: [], env: {}, returnOnExit: true }) : undefined;
  const imports = { ...(result.importObject ?? {}), ...(wasi ? { wasi_snapshot_preview1: wasi.wasiImport } : {}) };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const x: Record<string, any> = instance.exports;
  if (wasi && typeof x._start === "function") expect(wasi.start(instance)).toBe(0);
  else x.__module_init?.();
  return { result, x };
}

for (const target of ["standalone", "wasi"] as const) {
  describe(`IR native instanceof protocol: ${target}`, () => {
    let result: Awaited<ReturnType<typeof compile>>;
    let x: Record<string, any>;
    beforeAll(async () => {
      ({ result, x } = await instantiateNative(SOURCE, target, true));
    });
    it("emits the complete checker and forwarding chain without legacy bodies", () => {
      for (const name of ["check", "forward", "left", "right", "ordered"]) {
        const rows = result.irOutcomes?.filter((o) => o.displayName === name);
        expect(rows).toHaveLength(1);
        expect(rows![0].irBodyEmitted).toBe(true);
        expect(rows![0].legacyBodyEmitted).toBe(false);
        expect(rows![0].directBodyEmissions).toBe(0);
      }
    });
    it("keeps same-layout class identities distinct", () => {
      expect(x.forward(x.makeC(), x.targetC())).toBe(1);
      expect(x.forward(x.makeD(), x.targetC())).toBe(0);
      expect(x.forward(x.makeD(), x.targetD())).toBe(1);
    });
    it("returns false for primitive left operands with a valid class target", () => {
      expect(x.forward(x.seven(), x.targetC())).toBe(0);
      expect(x.forward(null, x.targetC())).toBe(0);
      expect(x.forward(x.undefinedValue(), x.targetC())).toBe(0);
    });
    function expectNativeError(run: () => unknown, kind: number): void {
      let caught: unknown;
      try {
        run();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WebAssembly.Exception);
      const error = caught as WebAssembly.Exception;
      expect(error.is(x.__exn_tag)).toBe(true);
      expect(x.errorKind(error.getArg(x.__exn_tag, 0))).toBe(kind);
    }
    for (const name of ["null", "undefined", "number", "object", "arrow", "handler"]) {
      it(`throws a real TypeError for invalid RHS: ${name}`, () => {
        const target =
          name === "null"
            ? null
            : name === "undefined"
              ? x.undefinedValue()
              : name === "number"
                ? x.seven()
                : name === "object"
                  ? x.empty()
                  : name === "arrow"
                    ? x.arrow()
                    : x.nonCallable();
        expectNativeError(() => x.forward(x.empty(), target), 1);
      });
    }
    it("invokes a custom handler even for primitive left values", () => {
      const k = x.handler();
      expect(x.forward(x.seven(), k)).toBe(1);
      expect(x.forward(x.zero(), k)).toBe(0);
    });
    it("propagates a throwing hasInstance getter", () =>
      expectNativeError(() => x.forward(x.seven(), x.throwingHandler()), 2));
    it("validates a callable's non-object prototype", () =>
      expectNativeError(() => x.forward(x.empty(), x.poison()), 1));
    it("rejects a Symbol prototype while preserving primitive-left false", () => {
      const target = x.prototypeValue(x.symbolValue());
      expectNativeError(() => x.forward(x.empty(), target), 1);
      expect(x.forward(x.seven(), target)).toBe(0);
    });
    it("does not read the prototype for a primitive left operand", () =>
      expect(x.forward(x.seven(), x.throwingPrototype())).toBe(0));
    it("propagates a throwing prototype getter for an object left operand", () =>
      expectNativeError(() => x.forward(x.empty(), x.throwingPrototype()), 2));
    it("delegates a bound target to its full custom operator", () => {
      const k = x.bound();
      expect(x.forward(x.seven(), k)).toBe(1);
      expect(x.forward(x.zero(), k)).toBe(0);
    });
    it("preserves a custom handler through a bound-of-bound target", () =>
      expect(x.forward(x.seven(), x.twiceBound())).toBe(1));
    it("reads the handler once and preserves its receiver, argument and ToBoolean result", () => {
      const c = x.counter(),
        k = x.countedHandler(c);
      expect(x.forward(x.seven(), k)).toBe(1);
      expect(x.readCount(c)).toBe(1);
      expect(x.forward(x.zero(), k)).toBe(0);
      expect(x.readCount(c)).toBe(2);
    });
    it("reads the callable prototype once per object operand", () => {
      const c = x.counter(),
        k = x.countedPrototype(c);
      expect(x.forward(x.empty(), k)).toBe(0);
      expect(x.readCount(c)).toBe(1);
      expect(x.forward(x.empty(), k)).toBe(0);
      expect(x.readCount(c)).toBe(2);
    });
    it("does not run a prototype getter for a primitive operand", () => {
      const c = x.counter(),
        k = x.countedPrototype(c);
      expect(x.forward(x.seven(), k)).toBe(0);
      expect(x.readCount(c)).toBe(0);
    });
    it("rejects a non-callable target even when the left operand is primitive", () => {
      expectNativeError(() => x.forward(x.seven(), x.empty()), 1);
    });
    it("evaluates the two operand calls once, left to right", () => {
      expect(x.ordered(x.makeC(), x.targetC())).toBe(112);
      expect(x.ordered(x.makeD(), x.targetC())).toBe(12);
    });
    it("evaluates both operands before the invalid-RHS error", () => {
      expectNativeError(() => x.ordered(x.empty(), null), 1);
      expect(x.readOrder()).toBe(12);
    });
  });
}

describe("native bound operator without a custom-handler demand", () => {
  for (const target of ["standalone", "wasi"] as const) {
    for (const experimentalIR of [false, true]) {
      it(`${target}, IR=${experimentalIR}: preserves false for an unrelated object`, async () => {
        const { x } = await instantiateNative(
          `
          function F(){}
          export function check(o:any,K:any):boolean{return o instanceof K;}
          export function bound():any{return F.bind(null);}
          export function empty():any{return {};}
        `,
          target,
          experimentalIR,
        );
        expect(x.check(x.empty(), x.bound())).toBe(0);
        expect(x.check(null, x.bound())).toBe(0);
      });
    }
  }
});

afterEach(() => vi.restoreAllMocks());
describe("native instanceof exact-provider contract", () => {
  for (const target of ["standalone", "wasi"] as const) {
    for (const fault of ["arity", "carrier"] as const)
      it(`fails closed for a claimed operator ${fault} fault (${target})`, async () => {
        const original = IrFunctionBuilder.prototype.emitCall;
        let tampered = 0;
        vi.spyOn(IrFunctionBuilder.prototype, "emitCall").mockImplementation(function (target, args, resultType) {
          if (target.binding.kind === "runtime" && target.binding.symbol === "__instanceof_operator") {
            tampered++;
            const wrong =
              fault === "carrier" ? this.emitConst({ kind: "f64", value: 3 }, irVal({ kind: "f64" })) : undefined;
            return original.call(this, target, wrong === undefined ? args.slice(0, 1) : [wrong, wrong], resultType);
          }
          return original.call(this, target, args, resultType);
        });
        const result = await compile("export function check(o:any,K:any):boolean{return o instanceof K;}", {
          target,
          experimentalIR: true,
          trackIrOutcomes: true,
        });
        expect(tampered).toBeGreaterThan(0);
        expect(result.success).toBe(false);
        expect(result.binary.length).toBe(0);
        const row = result.irOutcomes?.find((o) => o.displayName === "check");
        expect(row?.kind).toBe("invariant");
        expect(row?.stage).toBe("verify");
        expect(row?.code).toBe("verifier-failure");
        expect(row?.irBodyEmitted).toBe(false);
        expect(row?.detail).toContain(
          fault === "arity"
            ? "passes 1 argument(s) but the module declares 2"
            : "arg 0 carrier f64 contradicts the module-declared externref",
        );
        expect(row?.legacyBodyEmitted).toBe(false);
      });
  }
});
