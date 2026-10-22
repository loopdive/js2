// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { funcTypeKey, sameValTypes } from "../src/wasm/physical/function-types.js";
import { irTypeEquals, irVal } from "../src/ir/nodes.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "../src/ir/program/data.js";
import { canonicalProgramAbiValType } from "../src/codegen/program-abi-signatures.js";
import { coercionPlan } from "../src/codegen/coercion-plan.js";

async function execute(source: string, target: "standalone" | "wasi", expected: number) {
  const result = await compile(source, {
    fileName: "unsigned-member.ts",
    target,
    experimentalIR: true,
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings ?? []).toEqual([]);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  expect((instance.exports.run as () => number)()).toBe(expected);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const owners = result.irOutcomes?.filter((o) => o.unitKind === "function" || o.unitKind === "class-member") ?? [];
  expect(owners.length).toBeGreaterThanOrEqual(2);
  for (const owner of owners)
    expect(owner, JSON.stringify(result.irOutcomes)).toMatchObject({ irBodyEmitted: true, legacyBodyEmitted: false });
}

for (const target of ["standalone", "wasi"] as const) {
  describe(`#7138 unsigned dynamic member boundaries (${target})`, () => {
    for (const [name, annotation, initial, expected] of [
      ["maximum", "u32", "4294967295", 4294967295],
      ["high bit", "u32", "2147483648", 2147483648],
      ["negative wraps", "u32", "-1", 4294967295],
      ["large wraps", "u32", "4294967297", 1],
      ["signed control", "i32", "-1", -1],
      ["ordinary Number control", "number", "-1.5", -1.5],
      ["Boolean control", "boolean", "true", 1],
    ] as const) {
      it(`${name}: reader and caller prepare without a direct body`, async () => {
        await execute(
          `type u32=number; type i32=number;
          class C { value:${annotation}=${initial}; }
          function read(o:any):number { return o.value; }
          export function run():number { return read(new C()); }`,
          target,
          expected,
        );
      });
    }
    for (const [name, declaration, reader, body, expected] of [
      [
        "computed string key",
        "class C { value:u32=-1; }",
        "function read(o:any,k:string):number{return o[k];}",
        'return read(new C(),"value");',
        4294967295,
      ],
      [
        "inherited field",
        "class B { value:u32=-1; } class C extends B{}",
        "function read(o:any):number{return o.value;}",
        "return read(new C());",
        4294967295,
      ],
      [
        "local receiver",
        "class C { value:u32=-1; }",
        "function read(o:any):number{return o.value;}",
        "const c=new C();return read(c);",
        4294967295,
      ],
      [
        "numeric use",
        "class C { value:u32=-1; }",
        "function read(o:any):number{return o.value-1;}",
        "return read(new C());",
        4294967294,
      ],
      [
        "early return",
        "class C { value:u32=-1; }",
        "function read(o:any,n:number):number{if(n>0)return o.value;return 0;}",
        "return read(new C(),1);",
        4294967295,
      ],
    ] as const) {
      it(name, async () =>
        execute(`type u32=number;${declaration}${reader}export function run():number{${body}}`, target, expected),
      );
    }
    for (const [name, declaration, helper, body, expected] of [
      [
        "Boolean key",
        "class C{true:u32=-1;}",
        "function read(o:any,k:boolean):number{return o[k];}",
        "return read(new C(),true);",
        4294967295,
      ],
      [
        "numeric key",
        "class C{2:u32=-1;}",
        "function read(o:any,k:number):number{return o[k];}",
        "return read(new C(),2);",
        4294967295,
      ],
      [
        "Boolean store value",
        "class C{value:u32=0;}",
        "function edit(o:any,n:boolean):number{o.value=n;return o.value;}",
        "return edit(new C(),true);",
        1,
      ],
      [
        "inherited store",
        "class B{value:u32=0;}class C extends B{}",
        "function edit(o:any,n:number):number{o.value=n;return o.value;}",
        "return edit(new C(),-1);",
        4294967295,
      ],
      [
        "store body effects",
        "class C{value:u32=0;count:number=0;}",
        "function edit(o:any,n:number):number{o.count=o.count-(-1);o.value=n;return o.value;}",
        "const c=new C();const n=edit(c,-1);return n+c.count;",
        4294967296,
      ],
    ] as const) {
      it(name, async () =>
        execute(`type u32=number;${declaration}${helper}export function run():number{${body}}`, target, expected),
      );
    }
    for (const computed of [false, true]) {
      for (const [name, value, expected] of [
        ["negative", "-1", 4294967295],
        ["high bit", "2147483648", 2147483648],
        ["wrap", "4294967297", 1],
        ["fraction", "-7.9", 4294967289],
        ["large finite", "1180591620717412352000", 1048576],
        ["NaN", "NaN", 0],
        ["Infinity", "Infinity", 0],
      ] as const) {
        it(`${computed ? "computed" : "named"} store: ${name}`, async () => {
          const member = computed ? "o[k]" : "o.value";
          await execute(
            `type u32=number;class C{value:u32=0;}
            function edit(o:any,k:string,n:number):number{${member}=n;return ${member};}
            export function run():number{return edit(new C(),"value",${value});}`,
            target,
            expected,
          );
        });
      }
    }
  });
}

describe("#7138 shared carrier boundary", () => {
  const unsigned = { kind: "i32", uint32: true } as const;
  it("keeps unsigned signatures distinct from signed, Boolean and Symbol slots", () => {
    for (const other of [
      { kind: "i32" },
      { kind: "i32", int32: true },
      { kind: "i32", boolean: true },
      { kind: "i32", symbol: true },
    ] as const) {
      expect(canonicalProgramAbiValType(unsigned)).not.toBe(canonicalProgramAbiValType(other));
      expect(funcTypeKey([unsigned], [])).not.toBe(funcTypeKey([other], []));
      expect(sameValTypes([unsigned], [other])).toBe(false);
      expect(irTypeEquals(irVal(unsigned), irVal(other))).toBe(false);
    }
  });
  it("preserves metadata in the prepared data copier and detects its loss", () => {
    const type = irVal(unsigned);
    const copy = freezePreparedIrValue(type, "uint32-field");
    expect(copy).toEqual(type);
    expect(preparedIrDataMismatch(copy, type)).toBeUndefined();
    expect(preparedIrDataMismatch(copy, irVal({ kind: "i32" }))).toBeDefined();
  });
  it("refuses an unsigned store plan without the exact conversion provider", () => {
    const helpers = { boxNumberIdx: 7, unboxNumberIdx: 8 };
    expect(coercionPlan({ kind: "f64" }, unsigned, helpers)).toBeNull();
    expect(coercionPlan({ kind: "f64" }, unsigned, { ...helpers, toUint32Idx: 9 })?.instrs).toEqual([
      { op: "call", funcIdx: 9 },
    ]);
    expect(coercionPlan(unsigned, { kind: "externref" }, helpers)?.instrs).toEqual([
      { op: "f64.convert_i32_u" },
      { op: "call", funcIdx: 7 },
    ]);
  });
});
