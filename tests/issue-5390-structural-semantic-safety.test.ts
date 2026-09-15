// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { collectStructuralUnsoundness } from "../src/compiler/structural-semantic-safety.js";

function diagnose(source: string): string[] {
  const fileName = "/structural-safety.ts";
  const options = { strict: true, target: ts.ScriptTarget.ES2022 };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true)
      : read(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fileName], options, host);
  return collectStructuralUnsoundness(program.getTypeChecker(), program.getSourceFile(fileName)!).map(
    (diagnostic) => diagnostic.id,
  );
}

describe("#5390 — visible structural mutations with incompatible compiler carriers", () => {
  it.each([
    `const a: number[] = [1]; const b: (number | string)[] = a; b[0] = 'x';`,
    `const a: number[] = [1]; const b: (number | string)[] = a; const index = 0; b[index] = 'x';`,
    `const a: number[] = [1]; const b: (number | string)[] = a; b.push('x');`,
    `const a: string[] = ['x']; const b: (number | string)[] = a; b[0] = 2;`,
    `const a = [{x:1}]; const b: {x:number|string}[] = a; b[0].x = 'x';`,
  ])("rejects widened array mutation: %s", (source) => {
    expect(diagnose(source)).toContain("JS2WASM_UNSOUND_ARRAY_MUTATION");
  });

  it.each([
    `const a: {x?:number} = {x:1}; const b: {x?:number|string} = a; b.x = 'x';`,
    `const a: {x:number} = {x:1}; const b: {x?:number} = a; delete b.x;`,
  ])("rejects invalidating structural alias mutation: %s", (source) => {
    expect(diagnose(source)).toContain("JS2WASM_UNSOUND_STRUCTURAL_ALIAS");
  });

  it.each([
    `const change = (o:{x:number|string}) => o.x = 'x'; const a:{x:number|string} = {x:1}; if(typeof a.x === 'number') { change(a); console.log(a.x + 1); }`,
    `function change(o:{x?:number}) { delete o.x; } const a:{x?:number} = {x:1}; if(a.x !== undefined) { change(a); console.log(a.x === undefined); }`,
    `function change(o:{x:number|string}) { o.x = 'x'; } const a:{x:number|string} = {x:1}; if(typeof a.x === 'number') { change(a); console.log(a.x + 1); }`,
  ])("rejects visibly invalidated refinement: %s", (source) => {
    expect(diagnose(source)).toContain("JS2WASM_UNSOUND_REFINEMENT");
  });

  it.each([
    `const a:number[]=[1]; let b:(number|string)[]=a; b=['independent']; b[0]='x';`,
    `const a:number[]=[1]; const b:number[]=a; b[0]=4;`,
    `const a:{x?:number}={x:1}; const b:{x?:number}=a; b.x=4;`,
    `function change(o:{x:number|string}) {o.x=4;} const a:{x:number|string}={x:1}; if(typeof a.x === 'number') {change(a); console.log(a.x+1);}`,
    `const a:number[]=[1]; const b:readonly (number|string)[]=a; console.log(b[0]);`,
    `const a:{x:number}={x:1}; const b:{x?:number|string}={x:2}; b.x='x';`,
    `const a={x:1}; const b=true ? a : {x:''}; b.x='x'; console.log(a.x+1);`,
    `const a:number[]=[1]; { const a:(number|string)[]=[1]; const b=a; b[0]='x'; }`,
    `function change(o:{x:number|string}) {o.x='x';} const a:{x:number|string}={x:1}; change(a); console.log(a.x+1);`,
  ])("preserves safe or already supported control: %s", (source) => {
    expect(diagnose(source)).toEqual([]);
  });
});

describe("#5391 — unsupported unresolved generic object spread", () => {
  it("reports generic spread separately from alias unsoundness", () => {
    expect(diagnose(`function merge<T,U>(a:T,b:U):T&U {return {...a,...b};}`)).toEqual([
      "JS2WASM_UNSUPPORTED_GENERIC_SPREAD",
      "JS2WASM_UNSUPPORTED_GENERIC_SPREAD",
    ]);
  });
  it("allows concrete object spread", () => {
    expect(diagnose(`const a={x:1}; const b={...a,y:2};`)).toEqual([]);
  });
});
