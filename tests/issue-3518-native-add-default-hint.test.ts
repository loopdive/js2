// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { isPrimitiveConcatProducer } from "../src/codegen/native-addition.js";

it.each([
  ['"text"', true],
  ["1 + 2", true],
  ['true ? "a" : "b"', true],
  ["void effect()", true],
  ["typeof unknownValue", true],
  ["!unknownValue", true],
  ["value", false],
  ["value as string", false],
  ["({valueOf(){return 1}}) as string", false],
  ['"" + value', false],
  ['("" + value) + "tail"', false],
  ["Symbol()", false],
  ["1n", false],
  ['(() => "value")()', false],
  ['condition ? "literal" : unknownValue', false],
] as const)("primitive batching proof for %s is %s", (expression, admitted) => {
  const source = ts.createSourceFile("producer.ts", `const probe = (${expression});`, ts.ScriptTarget.Latest, true);
  const statement = source.statements[0] as ts.VariableStatement;
  expect(isPrimitiveConcatProducer(statement.declarationList.declarations[0]!.initializer!)).toBe(admitted);
});

const cases = [
  {
    name: "any plus number uses default hint and retains explicit String hint",
    body: 'const value:any={n:7}; let defaults=0;let strings=0;let receivers=0;value[Symbol.toPrimitive]=function(h:any):any{if(this===value)receivers++;if(h==="default")defaults++;if(h==="string")strings++;return h==="string"?"K":this.n;};const n=value+1;const text=String(value);return n===8 && text==="K" && defaults===1 && strings===1 && receivers===2?1:0;',
  },
  {
    name: "number plus any evaluates both expressions before default conversion",
    body: 'let trace=0;function left():number{trace=trace*10+1;return 2;}function right():any{trace=trace*10+2;return {[Symbol.toPrimitive](hint:any){trace=trace*10+(hint==="default"?3:9);return 7;}};}const value=left()+right();return trace*10+(value===9?1:0);',
  },
  {
    name: "any plus number preserves a string result chosen after conversion",
    body: 'const value:any={[Symbol.toPrimitive](hint:any){return hint==="default"?"K":7;}};const result=value+1;return typeof result==="string" && result==="K1"?1:0;',
  },
  {
    name: "right Symbol refuses after both evaluations",
    body: 'let trace=0; function left():string{trace=trace*10+1;return "L";} function right():any{trace=trace*10+2;return Symbol("s");} try{const text=left()+right();trace+=text.length;}catch(e){trace=trace*10+(e instanceof TypeError?3:9);} return trace;',
  },
  {
    name: "numeric plus Symbol refuses without treating id as number",
    body: 'const symbol:any=Symbol("s"); try{const value=7+symbol;return value;}catch(e){return e instanceof TypeError?1:9;}',
  },
  {
    name: "exotic Symbol result converted once then refused",
    body: 'let trace=0; const value:any={[Symbol.toPrimitive](hint:any){trace=trace*10+(hint==="default"?1:9);return Symbol("s");}}; try{const text=""+value;trace+=text.length;}catch(e){trace=trace*10+(e instanceof TypeError?2:9);} return trace;',
  },
  {
    name: "right conversion exception wins over left Symbol refusal",
    body: 'let trace=0; const sentinel:any={marker:47}; const left:any=Symbol("s"); const right:any={valueOf(){trace=trace*10+1;throw sentinel;}}; try{const value=left+right;trace+=value;}catch(e){trace=trace*10+(e===sentinel?2:9);} return trace;',
  },
  {
    name: "ordinary numeric values do not resemble Symbol carriers",
    body: "function add(left:any,right:any):any{return left+right;} return add(1,2)===3 && add(0,4)===4?1:0;",
  },
  {
    name: "assertions cannot turn numeric addition into string concatenation",
    body: "const left:any=2; const right:any=3; const result:any=(left as string)+(right as string); return result===5?1:0;",
  },
  {
    name: "wrapper default differs from String and template",
    body: 'const value:any = new String("xy"); value.toString = function(){return "own";}; return (("" + value) === "xy" ? 1:0) + (String(value) === "own" ? 2:0) + (`${value}` === "own" ? 4:0);',
  },
  {
    name: "wrapper both operand orders",
    body: 'const value:any = new String("xy"); value.toString = function(){return "wrong";}; return (("L" + value) === "Lxy" ? 1:0) + ((value + "R") === "xyR" ? 2:0);',
  },
  {
    name: "both expressions precede either conversion",
    body: 'let trace=0; const left:any={valueOf(){trace=trace*10+3;return "L";}}; const right:any={valueOf(){trace=trace*10+4;return "R";}}; function l():any{trace=trace*10+1;return left;} function r():any{trace=trace*10+2;return right;} const text=l()+r(); return trace*10+(text === "LR"?1:0);',
  },
  {
    name: "string branch evaluates right before left conversion",
    body: 'let trace=0; const left:any={valueOf(){trace=trace*10+3;return "L";}}; function l():any{trace=trace*10+1;return left;} function r():string{trace=trace*10+2;return "R";} const text=l()+r(); return trace*10+(text === "LR"?1:0);',
  },
  {
    name: "right throw precedes left conversion",
    body: 'let trace=0; const sentinel:any={marker:41}; const left:any={valueOf(){trace=trace*10+3;return "L";}}; function r():string{trace=trace*10+2;throw sentinel;} try{const text=left+r(); trace+=text.length;}catch(e){trace=trace*10+(e===sentinel?4:9);} return trace;',
  },
  {
    name: "left conversion throw suppresses right conversion",
    body: 'let trace=0; const sentinel:any={marker:42}; const left:any={valueOf(){trace=trace*10+3;throw sentinel;}}; const right:any={valueOf(){trace=trace*10+4;return "R";}}; function r():any{trace=trace*10+2;return right;} try{const text=left+r();trace+=text.length;}catch(e){trace=trace*10+(e===sentinel?5:9);} return trace;',
  },
  {
    name: "left-associated nested conversion order",
    body: 'let trace=0; const value:any={valueOf(){trace=trace*10+1;return "V";}}; function tail():string{trace=trace*10+2;return "T";} const text=(""+value)+tail(); return trace*10+(text === "VT"?1:0);',
  },
  {
    name: "right-associated nested conversion order",
    body: 'let trace=0; const value:any={valueOf(){trace=trace*10+1;return "V";}}; function tail():string{trace=trace*10+2;return "T";} const text=value+(""+tail()); return trace*10+(text === "VT"?1:0);',
  },
  {
    name: "nominal numeric conversion follows right evaluation",
    body: 'let trace=0; class Value{valueOf():number{trace=trace*10+3;return 7;}} function right():string{trace=trace*10+2;return "R";} const text=new Value()+right(); return trace*10+(text === "7R"?1:0);',
  },
  {
    name: "primitive nullish and boolean operands",
    body: 'function cat(value:any):string{return ""+value;} return (cat(null)==="null"?1:0)+(cat(undefined)==="undefined"?2:0)+(cat(false)==="false"?4:0)+(cat(7)==="7"?8:0);',
  },
  {
    name: "exotic receives default hint and original receiver",
    body: 'let trace=0; const value:any={ marker:7, [Symbol.toPrimitive](hint:any){trace=trace*10+(hint==="default"?1:2);return this.marker;}}; const text=""+value; const explicit=String(value); return trace*100+(text==="7"?10:0)+(explicit==="7"?1:0);',
  },
  {
    name: "Symbol refuses after right evaluation",
    body: 'let trace=0; function right():string{trace=2;return "x";} try{const text=(Symbol("x") as any)+right();trace+=text.length;}catch(e){trace=trace*10+(e instanceof TypeError?3:9);} return trace;',
  },
  {
    name: "valueOf object result falls through once",
    body: 'let trace=0; const value:any={valueOf(){trace=trace*10+1;return {};},toString(){trace=trace*10+2;return "ok";}}; const text=""+value; return trace*10+(text==="ok"?1:0);',
  },
  {
    name: "property compound addition reads RHS then writes once",
    body: 'let trace=0; let stored:any="L"; const holder:any={get value(){trace=trace*10+1;return stored;},set value(v:any){trace=trace*10+4;stored=v;}}; function right():any{trace=trace*10+2;return {valueOf(){trace=trace*10+3;return "R";}};} holder.value+=right(); return trace*10+(stored==="LR"?1:0);',
  },
  {
    name: "native callable left preserves dynamic right default conversion",
    body: 'let trace=0; const value:any={valueOf(){trace=trace*10+3;return "R";},toString(){trace=trace*10+9;return "wrong";}}; const text=(trace=trace*10+1,Array)+(trace=trace*10+2,value as string); return trace*10+(text.indexOf("[native code]")>=0 && text.slice(-1)==="R"?1:0);',
  },
  {
    name: "native callable right preserves dynamic left default conversion",
    body: 'let trace=0; const value:any={valueOf(){trace=trace*10+3;return "L";},toString(){trace=trace*10+9;return "wrong";}}; const text=(trace=trace*10+1,value as string)+(trace=trace*10+2,Array); return trace*10+(text.indexOf("[native code]")>=0 && text.charAt(0)==="L"?1:0);',
  },
  {
    name: "native callable left-associated conversion precedes outer evaluation",
    body: 'let trace=0; const value:any={valueOf(){trace=trace*10+3;return "V";},toString(){trace=trace*10+9;return "wrong";}}; function tail():string{trace=trace*10+4;return "T";} const text=((trace=trace*10+1,Array)+(trace=trace*10+2,value as string))+tail(); return trace*10+(text.indexOf("[native code]")>=0 && text.slice(-2)==="VT"?1:0);',
  },
  {
    name: "native callable right-associated evaluation precedes outer conversion",
    body: 'let trace=0; const value:any={valueOf(){trace=trace*10+4;return "V";},toString(){trace=trace*10+9;return "wrong";}}; function tail():string{trace=trace*10+3;return "T";} const text=(trace=trace*10+1,value as string)+((trace=trace*10+2,Array)+tail()); return trace*10+(text.indexOf("[native code]")>=0 && text.charAt(0)==="V" && text.slice(-1)==="T"?1:0);',
  },
] as const;
it.each(cases)("native addition preserves $name", async ({ body }) => {
  const source = `export function run():number { ${body} }`;
  const js = source
    .replace(/:\s*(any|string|number)\b/g, "")
    .replace(/\s+as\s+(any|string|number|unknown)\b/g, "")
    .replace(/^export /gm, "");
  const oracle = new Function(js + "\nreturn run;")() as () => number;
  const expected = oracle();
  const result = await compile(source, { target: "standalone" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.imports).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  expect((instance.exports.run as () => number)()).toBe(expected);
});

it("proven primitive producers retain actual native batching", async () => {
  const source = 'export function run(seed:number):number { return (`${seed}` + "middle" + `${seed+1}`).length; }';
  const result = await compile(source, { target: "standalone", emitWat: true });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.imports).toEqual([]);
  expect(result.wat).toContain("__str_concat_4");
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  for (const seed of [2, 17])
    expect((instance.exports.run as (n: number) => number)(seed)).toBe(`${seed}middle${seed + 1}`.length);
});
