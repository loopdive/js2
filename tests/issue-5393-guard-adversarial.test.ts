// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { runInNewContext } from "node:vm";
import { format } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";

// Exact specimens from the 9bde5d2 adversarial observations. These are now
// assertions: no guard filtering, and a successful compilation is NOT a pass.
const arrays = [
  ["literal", "var a=[1];Object.setPrototypeOf(a,{2:7});console.log(a[2]);"],
  ["alias", "var p={2:7};var q=p;var a=[1];Object.setPrototypeOf(a,q);console.log(a[2]);"],
  ["return", "function p(){return {2:7}}var a=[1];Object.setPrototypeOf(a,p());console.log(a[2]);"],
  ["field", "var box={p:{2:7}};var a=[1];Object.setPrototypeOf(a,box.p);console.log(a[2]);"],
  ["rebound", "var p={2:7};p=p;var a=[1];Object.setPrototypeOf(a,p);console.log(a[2]);"],
  ["chain", "var p=Object.create({2:7});var a=[1];Object.setPrototypeOf(a,p);console.log(a[2]);"],
  ["conditional", "var flag=true;var a=[1];Object.setPrototypeOf(a,flag?{2:7}:{2:8});console.log(a[2]);"],
];
const enumerations = [
  [
    "direct-effect",
    'var p={a:1};var o=Object.create(p,{a:{value:(p.b=2),enumerable:false}});var keys=[];for(var k in o)keys.push(k);console.log(keys.join(","));',
    "b",
  ],
  [
    "alias-effect",
    'var p={a:1};var q=p;var o=Object.create(p,{a:{value:(q.b=2),enumerable:false}});var keys=[];for(var k in o)keys.push(k);console.log(keys.join(","));',
    "b",
  ],
  [
    "rebound-alias-effect",
    'var p={a:1};var q=p;q=q;var o=Object.create(p,{a:{value:(q.b=2),enumerable:false}});var keys=[];for(var k in o)keys.push(k);console.log(keys.join(","));',
    "b",
  ],
  [
    "return-effect",
    'var p={a:1};function mutate(){p.b=2;return 3}var o=Object.create(p,{a:{value:mutate(),enumerable:false}});var keys=[];for(var k in o)keys.push(k);console.log(keys.join(","));',
    "b",
  ],
  [
    "rebound-return-effect",
    'var p={a:1};var q=p;q=q;function mutate(){q.b=2;return 3}var o=Object.create(p,{a:{value:mutate(),enumerable:false}});var keys=[];for(var k in o)keys.push(k);console.log(keys.join(","));',
    "b",
  ],
  // This observation happened to match, but a rebound receiver is not a proof.
  [
    "object-alias-delete",
    'var p={a:1};var o=Object.create(p,{a:{value:3,enumerable:false}});var q=o;q=q;delete q.a;var keys=[];for(var k in o)keys.push(k);console.log(keys.join(","));',
    "",
  ],
  [
    "rebound-later-write",
    'var p={a:1};var q=p;q=q;var o=Object.create(p,{a:{value:3,enumerable:false}});q.b=2;var keys=[];for(var k in o)keys.push(k);console.log(keys.join(","));',
    "b",
  ],
  [
    "unknown-value-call",
    'function value(){return 3}var p={a:1};var o=Object.create(p,{a:{value:value(),enumerable:false}});var keys=[];for(var k in o)keys.push(k);console.log(keys.join(","));',
    "",
  ],
  [
    "unknown-value-read",
    'var values={a:3};var p={a:1};var o=Object.create(p,{a:{value:values.a,enumerable:false}});var keys=[];for(var k in o)keys.push(k);console.log(keys.join(","));',
    "",
  ],
];
function reference(source: string): string[] {
  const writes: string[] = [];
  runInNewContext(source, { console: { log: (...args: unknown[]) => writes.push(format(...args)) } });
  return writes;
}

for (const optimize of [0, 2] as const) {
  describe(`#5393: conservative guard proofs (host optimize=${optimize})`, () => {
    it.each([
      ...arrays.map(([id, source]) => [`array-${id}`, source, "7", "JS2WASM_UNSUPPORTED_ARRAY_PROTOTYPE"]),
      ...enumerations.map(([id, source, expected]) => [`enum-${id}`, source, expected, "JS2WASM_UNSOUND_ENUMERATION"]),
    ])("refuses %s", async (_id, source, expected, diagnostic) => {
      expect(reference(source)).toEqual([expected]);
      const result = await compile(source, { allowJs: true, fileName: "adversarial.js", optimize });
      expect(result.success, JSON.stringify(result.errors)).toBe(false);
      expect(result.binary.length).toBe(0);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining(diagnostic),
        }),
      );
    });

    it.each([
      [
        "shadow-control",
        'var p={a:1};var o=Object.create(p,{a:{value:3,enumerable:false},b:{value:2,enumerable:true}});var keys=[];for(var k in o)keys.push(k);console.log(keys.join(","));',
        "b",
      ],
      [
        "immutable-alias-shadow",
        'var p={a:1};var q=p;var o=Object.create(q,{a:{value:3,enumerable:false},b:{value:2,enumerable:true}});var alias=o;var keys=[];for(var k in alias)keys.push(k);console.log(keys.join(","));',
        "b",
      ],
      ["original-array-prototype", "var a=[1];Object.setPrototypeOf(a,Array.prototype);console.log(a[0]);", "1"],
    ])("executes authenticated control %s", async (_id, source, expected) => {
      expect(reference(source)).toEqual([expected]);
      const result = await compile(source, {
        allowJs: true,
        fileName: "safe-control.js",
        deferTopLevelInit: true,
        optimize,
      });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const writes: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
        writes.push(format(...args));
      });
      try {
        const imports = result.importObject!;
        const { instance } = await WebAssembly.instantiate(result.binary, imports);
        (imports as any).__setInstance?.(instance);
        (instance.exports.__module_init as () => void)();
      } finally {
        spy.mockRestore();
      }
      expect(writes).toEqual([expected]);
    });
  });
}
