import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it("keeps dynamic coercion inside its catch and at each executed use", async () => {
  const result = await compile(
    `
    const token:any = {marker:73};
    function caught(input:any):number {
      const value = input;
      try { return +value; } catch(e) { return e === token ? 73 : -1; }
    }
    function repeated(input:any):number {
      const value = input;
      return +value + +value;
    }
    function conditional(input:any, use:boolean):number {
      const value = input;
      if (use) return +value;
      return 19;
    }
    function assigned(input:any):number {
      let value:any = 0; value = input;
      try {return +value;} catch(e) {return e===token?73:-1;}
    }
    export function assignment():number {return assigned({valueOf():any {throw token;}});}
    export function exception():number {
      return caught({valueOf():any {throw token;}});
    }
    export function effects():number {
      let count = 0;
      const sum = repeated({valueOf():number {count++;return count;}});
      return sum * 10 + count;
    }
    export function skipped():number {
      return conditional({valueOf():any {throw token;}}, false);
    }
  `,
    { target: "standalone", platform: "deno", hostBridge: "always" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  const e = instance.exports as Record<string, () => number>;
  expect(e.exception()).toBe(73);
  expect(e.effects()).toBe(32);
  expect(e.assignment()).toBe(73);
  expect(e.skipped()).toBe(19);
});
