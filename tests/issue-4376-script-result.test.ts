// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

it.each(["inline", "imported", "dynamic"])(
  "preserves undefined script completion through %s encoding",
  async (mode) => {
    const program = "export function program():undefined { return undefined; }";
    const result = await compileMulti(
      {
        "/result/program.ts": program,
        "/result/entry.ts": `
${mode === "imported" ? 'import {program} from "./program.ts";' : program}
let scriptResult = "";
function encode(value:any,arrayElement=false):string|undefined {
  if(value===null) return "null";
  const kind=typeof value;
  if(kind==="string") return '"'+value+'"';
  if(kind==="boolean") return value?"true":"false";
  if(kind==="number") return value!==value || value===Infinity || value===-Infinity?"null":String(value);
  if(kind==="bigint") return String(value);
  if(kind==="undefined" || kind==="function" || kind==="symbol") return arrayElement?"null":undefined;
  if(Array.isArray(value)) {
    let result="[";
    for(let index=0;index<value.length;index++) {
      if(index!==0) result+=",";
      result+=encode(value[index],true);
    }
    return result+"]";
  }
  let result="{";
  let first=true;
  for(const key in value) {
    const encoded=encode(value[key]);
    if(encoded===undefined) continue;
    if(!first) result+=",";
    first=false;
    result+=key+":"+encoded;
  }
  return result+"}";
}
export function run():number {
  try {
  ${mode === "dynamic" ? "const invoke:any=encode; const encoded=invoke(program());" : "const encoded=encode(program());"}
  if(encoded===undefined) { scriptResult=""; return 0; }
  scriptResult=encoded;
  return 1;
  } catch(error) {
    const value:any=error;
    const encoded=encode({name:value!=null && typeof value.name==="string"?value.name:"Error",message:String(value)});
    if(encoded===undefined) throw new Error("cannot encode exception");
    scriptResult=encoded;
    return -1;
  }
}
export function length():number { return scriptResult.length; }
export function checkControl(index:number):number {
  const invoke:any=encode;
  const values:any[]=[undefined,null,"x",true,42,[1,2]];
  const expected:any[]=[undefined,"null",'"x"',"true","42","[1,2]"];
  const actual=invoke(values[index]);
  return actual===expected[index]?42:0;
}
`,
      },
      "/result/entry.ts",
      {
        target: "standalone",
        platform: "deno",
        skipSemanticDiagnostics: true,
        deferTopLevelInit: true,
        standaloneSymbolState: "export",
        allowJs: true,
      },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
    (instance.exports.__module_init as () => void)();
    expect((instance.exports.run as () => number)()).toBe(0);
    expect((instance.exports.length as () => number)()).toBe(0);
    for (let index = 0; index < 6; index++)
      expect((instance.exports.checkControl as (index: number) => number)(index)).toBe(42);
  },
);
