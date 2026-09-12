// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const cases = [
  {
    name: "first-class generator factory exports its state through the closure ABI",
    source:
      "function* base(){yield 1;}export function test(){var factory=base;var gen=factory();return gen.next().value===1?1:0;}",
  },
  {
    name: "a captured native state survives a first-class factory call",
    source:
      "function* base(){yield 1;}export function test(){var gen=base();function* outer(){return yield* gen;}var factory=outer;return factory().next().value===1?1:0;}",
  },
  {
    name: "deleting native protocol shadows restores inherited methods",
    source:
      "function* base(){yield 1;}export function test(){var gen=base(),caught=0;gen.next=undefined;function* outer(){yield* gen;}try{outer().next();}catch(e){if(e instanceof TypeError)caught++;}delete gen.next;gen[Symbol.iterator]=undefined;try{outer().next();}catch(e){if(e instanceof TypeError)caught++;}delete gen[Symbol.iterator];return caught===2&&gen.next().value===1?1:0;}",
  },
  {
    name: "native string generators keep a valid protocol return wrapper",
    source:
      "function* base(){yield* 'ab';}export function test(){var gen=base();var first=gen.next(),second=gen.next(),done=gen.next();return first.value==='a'&&second.value==='b'&&done.done?1:0;}",
  },
];

describe("#5199 native generator protocol bridge", () => {
  for (const item of cases) {
    it(item.name, async () => {
      const result = await compile(item.source, { target: "standalone", skipSemanticDiagnostics: true });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      expect(result.imports).toEqual([]);
      expect(WebAssembly.validate(result.binary!)).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary!, {});
      expect((instance.exports.test as () => number)()).toBe(1);
    });
  }

  it("keeps a deliberately legacy rest-parameter generator producer runnable", async () => {
    // Rest parameters are intentionally outside the native generator candidate
    // gate. This positive control proves the generator protocol work does not
    // accidentally erase the existing host-buffer producer path.
    const result = await compile(
      "export function test():number{function* legacy(...values:number[]){yield values[0];return 9;}const iterator:any=legacy(7);const first:any=iterator.next();const done:any=iterator.next();return first.value===7&&!first.done&&done.done&&done.value===9?1:0;}",
      { fileName: "issue-5199-legacy-producer.ts", target: "gc", skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(WebAssembly.validate(result.binary!)).toBe(true);
    expect(result.imports.some((entry) => entry.name === "__create_generator")).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => number)()).toBe(1);
  });
});
