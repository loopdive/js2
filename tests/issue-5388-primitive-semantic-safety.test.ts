// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { collectUnsafePrimitiveFlows } from "../src/compiler/primitive-semantic-safety.js";

function diagnose(source: string): string[] {
  const fileName = "/primitive-safety.ts";
  const options = { strict: true, target: ts.ScriptTarget.ES2022 };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, fresh) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true)
      : read(name, languageVersion, onError, fresh);
  const program = ts.createProgram([fileName], options, host);
  return collectUnsafePrimitiveFlows(program.getTypeChecker(), program.getSourceFile(fileName)!).map(
    (finding) => finding.id,
  );
}

describe("#5388 — primitive origins respect actual use points", () => {
  it.each([
    `let value:unknown='old'; value=2; if(typeof value==='number'){const n:number=value;}`,
    `let value:any='old'; value=2; if(typeof value==='number'){const n:number=value;}`,
    `function f(value:unknown){if(typeof value==='number'){const n:number=value;return n+1;}return 0;}`,
    `const value:any='2'; const n:number=Number(value);`,
    `let value:any=2; const n:number=value; value='later';`,
    `let value:any='old'; value=2; const n:number=value;`,
    `let value:any=2; function unused(){value='later';} const n:number=value;`,
    `function f(value){return value+1;} console.log(f('x'));`,
    `const value:any=2; function f(x:number){return x+1;} console.log(f(value));`,
    `const n=2 as number;`,
    `function identity<T>(value:T):T{return value;} const n:number=identity(2);`,
    `let value:any=2; {let value:any='x'; value='y';} const n:number=value;`,
  ])("allows a preserved value flow: %s", (source) => {
    expect(diagnose(source)).toEqual([]);
  });

  it.each([
    `function add(x:number){return x+1;} const value:any='x'; console.log(add(value));`,
    `const value:any='x'; const n:number=value;`,
    `const n='x' as unknown as number;`,
    `const n='hello' as unknown as boolean;`,
    `function identity<T>(value:T):T{return value;} const n:number=identity('x' as unknown as number);`,
    `function lie<T>(value:T):T{return 'x' as unknown as T;} const n:number=lie(2);`,
    `function lie<T>(value:T):T{value='x' as unknown as T;return value;} const n:number=lie(2);`,
    `let value:any=2; value='x'; const n:number=value;`,
    `let value:any=2; if(Math.random()>0.5) value='x'; const n:number=value;`,
    `let value:any=2; if(typeof value==='number'){value='x'; const n:number=value;}`,
    `let value:any=2; function mutate(){value='x';} if(typeof value==='number'){mutate();const n:number=value;}`,
    `let value:any=2; const mutate=()=>{value='x';}; if(typeof value==='number'){mutate();const n:number=value;}`,
  ])("rejects an erased or invalidated assumption: %s", (source) => {
    expect(diagnose(source).length).toBeGreaterThan(0);
  });

  it("keeps the inaccurate-overload diagnostic", () => {
    expect(diagnose(`function value():number; function value():any{return 'x';} console.log(value()+1);`)).toContain(
      "JS2WASM_UNSOUND_OVERLOAD",
    );
  });
  it("allows the matching overload control", () => {
    expect(diagnose(`function value():number; function value():any{return 4;} console.log(value()+1);`)).toEqual([]);
  });
});
