// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { stampAllocationOwners } from "../src/wasm/physical/allocation-owner.js";

it("distinguishes identical module instances without claiming foreign handles", async () => {
  const compiled = await compile(
    `
    const object:any={marker:1};
    Object.assign(object,{answer:42});
    const handles=new Map<any,number>();
    export function original():any {return object;}
    export function keep(value:any):void {handles.set(value,1);}
    export function held(value:any):boolean {return handles.has(value);}
    export function create():any {return {marker:1};}
    export function physical(value:any):number {return value.marker;}
    export function reflected():number {return Object.getOwnPropertyNames(object).length;}
  `,
    { target: "standalone", standaloneAllocationOwnerExport: "owns" },
  );
  expect(compiled.success, JSON.stringify(compiled.errors)).toBe(true);
  const module = new WebAssembly.Module(compiled.binary);
  const first = new WebAssembly.Instance(module, compiled.importObject);
  const second = new WebAssembly.Instance(module, compiled.importObject);
  const a = (first.exports.original as Function)();
  const b = (second.exports.original as Function)();
  const ownsA = first.exports.owns as Function;
  const ownsB = second.exports.owns as Function;
  expect(ownsA(a)).toBe(1);
  expect(ownsA(b)).toBe(0);
  expect(ownsB(a)).toBe(0);
  expect(ownsB(b)).toBe(1);
  (first.exports.keep as Function)(b);
  expect((first.exports.held as Function)(b)).toBe(1);
  expect(ownsA(b)).toBe(0);
  expect(ownsB(b)).toBe(1);
  expect(ownsA((first.exports.create as Function)())).toBe(1);
  expect((first.exports.physical as Function)(a)).toBe(1);
  expect((first.exports.reflected as Function)()).toBe(2);
  for (const value of [undefined, null, 1, "text", {}, () => 42]) expect(ownsA(value)).toBe(0);
});

it("preserves inherited fields, captured closures, and native carriers", async () => {
  const source = `
    class Base { value=20; }
    class Child extends Base { other=22; sum(){return this.value+this.other;} }
    export function child():any {return new Child();}
    export function sum():number {return new Child().sum();}
    export function closure():any {const object=new Child();return ()=>object.sum();}
    export function invoke():number {const object=new Child();const fn=()=>object.sum();return fn();}
    export function array():any {return [1,2,3];}
    export function promise():any {return Promise.resolve(42);}
    export function error():any {return new Error("owned");}
    export function names():number {
      const names=Object.getOwnPropertyNames(new Child());
      return (names.includes("value") ? 1 : 0) + (names.includes("other") ? 2 : 0) + (names.includes("$allocationOwner") ? 4 : 0);
    }
  `;
  const compiled = await compile(source, { target: "standalone", standaloneAllocationOwnerExport: "owns" });
  expect(compiled.success, JSON.stringify(compiled.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(compiled.binary), compiled.importObject);
  const owns = instance.exports.owns as Function;
  for (const name of ["child", "closure", "array", "promise", "error"]) {
    expect(owns((instance.exports[name] as Function)()), name).toBe(1);
  }
  expect((instance.exports.sum as Function)()).toBe(42);
  expect((instance.exports.invoke as Function)()).toBe(42);
  // The extra token is physical metadata, never a JavaScript property.
  const control = await compile(source, { target: "standalone" });
  expect(control.success, JSON.stringify(control.errors)).toBe(true);
  const baseline = new WebAssembly.Instance(new WebAssembly.Module(control.binary), control.importObject);
  const names = (instance.exports.names as Function)();
  expect(names).toBe((baseline.exports.names as Function)());
  expect(names & 4).toBe(0);
});

it("stamps subtype constant allocations and remaps exported globals", () => {
  const mod = createEmptyModule();
  mod.types.push(
    {
      kind: "struct",
      name: "Base",
      fields: [{ name: "value", type: { kind: "i32" }, mutable: true }],
      superTypeIdx: -1,
    },
    {
      kind: "struct",
      name: "Child",
      superTypeIdx: 0,
      fields: [
        { name: "value", type: { kind: "i32" }, mutable: true },
        { name: "other", type: { kind: "i64" }, mutable: false },
        { name: "packed", type: { kind: "i8" }, mutable: true },
      ],
    },
    { kind: "func", params: [], results: [{ kind: "i32" }] },
  );
  mod.globals.push({
    name: "child",
    type: { kind: "ref_null", typeIdx: 1 },
    mutable: false,
    init: [
      { op: "i32.const", value: 20 },
      { op: "i64.const", value: 22n },
      { op: "i32.const", value: 7 },
      { op: "struct.new", typeIdx: 1 },
    ],
  });
  mod.functions.push({
    name: "sum",
    typeIdx: 2,
    exported: true,
    locals: [],
    body: [
      { op: "global.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: 1, fieldIdx: 0 },
      { op: "global.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: 1, fieldIdx: 1 },
      { op: "i32.wrap_i64" },
      { op: "i32.add" },
    ],
  });
  const globalDescriptor = { kind: "global" as const, index: 0 };
  mod.exports.push(
    { name: "sum", desc: { kind: "func", index: 0 } },
    { name: "child", desc: globalDescriptor },
    { name: "alias", desc: globalDescriptor },
  );
  stampAllocationOwners(mod, "owns");
  expect(mod.globals).toHaveLength(2);
  expect(mod.imports).toEqual([]);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(emitBinary(mod)), {});
  expect((instance.exports.sum as Function)()).toBe(42);
  expect((instance.exports.owns as Function)((instance.exports.child as WebAssembly.Global).value)).toBe(1);
  expect((instance.exports.alias as WebAssembly.Global).value).toBe(
    (instance.exports.child as WebAssembly.Global).value,
  );
});
