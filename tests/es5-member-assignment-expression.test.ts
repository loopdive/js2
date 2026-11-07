// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

for (const strict of [false, true]) {
  for (const [name, prefix, body, expected] of [
    ["object", "", "let o = {x:0}; return (o.x = 7) + o.x;", 14],
    ["vector", "", "let a = [0]; return (a[0] = 7) + a[0];", 14],
    ["growing vector", "", "let a = [0]; return (a[3] = 7) + a[3] + a.length;", 18],
    ["signed vector", "", "let a = [0]; return (a[0] = (-1 | 0)) + a[0];", -2],
    ["object bracket", "", 'let o={x:0};return(o["x"]=7)+o.x;', 14],
    ["class bracket field", "class C {x:number=0;}", 'let c=new C();return(c["x"]=7)+c.x;', 14],
    [
      "class bracket setter",
      "class C {x:number=0;set value(v:number){this.x=v+1;}}",
      'let c=new C();return(c["value"]=7)+c.x;',
      15,
    ],
    ["mixed chain", "", "let o={x:0};let a=[0];let v=0;v=o.x=a[0]=7;return v+o.x+a[0];", 21],
    ["object string result", "", 'let o={x:"old"};return(o.x="éλ")==="éλ" && o.x==="éλ"?1:0;', 1],
    ["object boolean result", "", "let o={x:false};return(o.x=true) && o.x?1:0;", 1],
    [
      "function object string result",
      "function subject():number{return 0;}",
      'return(subject.value="éλ")==="éλ"?1:0;',
      1,
    ],
    [
      "function object boolean result",
      "function subject():number{return 0;}",
      "return(subject.value=true)===true?1:0;",
      1,
    ],
    [
      "native field keeps logical result",
      "type i32=number;class C{x:i32;constructor(){this.x=0;}}",
      "const c=new C();return(c.x=7.75);",
      7.75,
    ],
    ["negative zero", "", "let o = {x:1}; return 1 / (o.x = -0);", -Infinity],
    [
      "private field",
      "class C { #x:number=0; setIt():number { return (this.#x=7)+this.#x; } }",
      "return new C().setIt();",
      14,
    ],
    [
      "static private",
      "class C { static #x:number=0; static setIt():number { return (C.#x=7)+C.#x; } }",
      "return C.setIt();",
      14,
    ],
    [
      "super setter",
      "class B { x:number=0; set value(v:number){this.x=v+1;} } class C extends B { setIt():number{return(super.value=7)+this.x;} }",
      "return new C().setIt();",
      15,
    ],
    ["function object", "function subject():number{return 0;}", "return (subject.value = 7) === 7 ? 1 : 0;", 1],
    ["class field", "class C { x:number=0; }", "let c = new C(); return (c.x = 7) + c.x;", 14],
    [
      "setter",
      "class C { x:number=0; set value(v:number) { this.x = v + 1; } }",
      "let c = new C(); return (c.value = 7) + c.x;",
      15,
    ],
  ] as const) {
    it(`member assignment ${name} (${strict ? "explicit strict directive" : "module strictness"})`, async () => {
      const result = await compile(`${prefix} export function run():number{${strict ? '"use strict";' : ""}${body}}`, {
        target: "standalone",
        trackIrOutcomes: true,
      });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      expect(result.irPostClaimErrors).toEqual([]);
      const run = result.irOutcomes?.find((row) => row.displayName === "run");
      expect(run?.irBodyEmitted, JSON.stringify(run)).toBe(true);
      if (name === "private field" || name === "static private" || name === "super setter") {
        const method = result.irOutcomes?.find((row) => row.displayName.includes("setIt"));
        expect(method?.irBodyEmitted, JSON.stringify(result.irOutcomes)).toBe(true);
      }
      const module = await WebAssembly.compile(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = await WebAssembly.instantiate(module, {});
      expect((instance.exports.run as () => number)()).toBe(expected);
    });
  }
}

for (const element of [false, true]) {
  for (const abrupt of [false, true]) {
    it(`member reference and RHS order (element=${element}, abrupt=${abrupt})`, async () => {
      const result = await compile(
        `let trace=0;
function receiver(o:{x:number}):{x:number}{trace=trace*10+1;return o;}
function key():number{trace=trace*10+1;return 0;}
function rhs():number{trace=trace*10+2;${abrupt ? 'if(trace===12)throw "stop";' : ""}return 7;}
export function run():number{
 let o={x:3};let a=[3];let answer=5;let caught=0;
 try { answer = (${element ? "a[key()]" : "receiver(o).x"} = rhs()); } catch(e){caught=1;}
 if(trace!==12 || answer!==${abrupt ? 5 : 7} || caught!==${abrupt ? 1 : 0})return 0;
 return ${element ? "a[0]" : "o.x"}===${abrupt ? 3 : 7}?1:0;
}`,
        { target: "standalone", trackIrOutcomes: true },
      );
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      expect(result.irPostClaimErrors).toEqual([]);
      for (const name of ["run", "rhs", element ? "key" : "receiver"]) {
        const row = result.irOutcomes?.find((row) => row.displayName === name);
        expect(row?.irBodyEmitted, JSON.stringify(row)).toBe(true);
      }
      const module = await WebAssembly.compile(result.binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = await WebAssembly.instantiate(module, {});
      expect((instance.exports.run as () => number)()).toBe(1);
    });
  }
}

for (const access of [".x", '["x"]']) {
  for (const value of ['"éλ"', "true"]) {
    it(`retains planned dynamic member-store preclaim boundary ${access} ${value}`, async () => {
      const result = await compile(
        `function subject(){return 0;}
subject.f=function(m,k){if(k===9)return;var y=(m${access}=${value});if(y!==${value})throw "bad";throw m;};
var result=0;try{subject.f(2,0);}catch(e){if(e===2)result=1;}
if(result!==1)throw "failed";`,
        {
          fileName: "sloppy-member.js",
          allowJs: true,
          skipSemanticDiagnostics: true,
          target: "standalone",
          trackIrOutcomes: true,
          deferTopLevelInit: true,
        },
      );
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      expect(result.irPostClaimErrors).toEqual([]);
      const init = result.irOutcomes?.find((row) => row.displayName === "<module-init>");
      expect(init?.irBodyEmitted, JSON.stringify(init)).toBe(false);
      expect(init?.stage).toBe("select");
      expect(init?.kind === "unsupported" && init.code).toBe("operand-coercion-unsupported");
    });
  }
}

it("mixed chain evaluates stateful receivers once and calls setters inside out", async () => {
  const result = await compile(
    `let trace=0;let calls=0;
class C { x:number=0; id:number=1; set value(v:number){ trace=trace*10+this.id; this.x=v+1; } }
function choose(first:C,second:C):C { calls=calls+1;return calls===1?first:second; }
export function run():number {
 const first=new C();const second=new C();second.id=2;
 choose(first,second).value = choose(first,second).value = 7;
 if(calls!==2 || trace!==21 || first.x!==8 || second.x!==8)return 0;
 return 1;
}`,
    { target: "standalone", trackIrOutcomes: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.irPostClaimErrors).toEqual([]);
  for (const name of ["run", "choose", "C_set_value"]) {
    const row = result.irOutcomes?.find((row) => row.displayName === name);
    expect(row?.irBodyEmitted, JSON.stringify(result.irOutcomes)).toBe(true);
  }
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as () => number)()).toBe(1);
});
