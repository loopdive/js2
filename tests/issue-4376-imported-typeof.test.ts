// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

it.each(["gc", "standalone"] as const)("classifies imported runtime bindings in %s", async (target) => {
  const result = await compileMulti(
    {
      "/imports/owner.ts": `
      export const object:any={answer:42};
      export function callable():number {return 42;}
      export const absent:any=undefined;
      export interface Shape { answer:number; }
      export let changing:any={answer:1};
      export function clear():void {changing=undefined;}
      export default object;
    `,
      "/imports/main.ts": `
      import defaultObject,{object as alias,callable,absent,changing,clear} from "./owner.ts";
      import type {Shape} from "./owner.ts";
      import * as namespace from "./owner.ts";
      if (typeof alias==="undefined") throw new Error("import alias is bound");
      export function run():number {
        if (typeof alias!=="object" || typeof defaultObject!=="object") return -1;
        if (typeof callable!=="function" || typeof namespace!=="object") return -2;
        if (typeof absent!=="undefined" || typeof missingName!=="undefined") return -3;
        if (typeof Shape!=="undefined") return -5;
        const objectKind=typeof alias;
        const functionKind=typeof callable;
        const namespaceKind=typeof namespace;
        if (objectKind!=="object" || functionKind!=="function" || namespaceKind!=="object") return -4;
        if (typeof changing!=="object") return -6;
        clear();
        if (typeof changing!=="undefined") return -7;
        return alias.answer;
      }
    `,
    },
    "/imports/main.ts",
    { target, skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
  (result.importObject as { __setInstance?: (instance: WebAssembly.Instance) => void } | undefined)?.__setInstance?.(
    instance,
  );
  expect((instance.exports.run as () => number)()).toBe(42);
});
