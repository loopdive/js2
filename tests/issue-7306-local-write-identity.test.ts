// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { collectLatticeParamFacts, localIsRewritten } from "../src/ir/lattice-param-facts.js";
import { selectStaticPredicateCall } from "../src/ir/static-predicates/selection.js";
import { localValueDeclaration } from "../src/ir/module-bindings.js";
import { irVal } from "../src/ir/index.js";

function fixture(body: string) {
  const file = "/issue7306.js";
  const options = { allowJs: true, noLib: true, target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, version) =>
    name === file ? ts.createSourceFile(name, `function f() { ${body} }`, version, true, ts.ScriptKind.JS) : undefined;
  const program = ts.createProgram([file], options, host);
  const source = program.getSourceFile(file)!;
  const checker = program.getTypeChecker();
  const fn = source.statements[0] as ts.FunctionDeclaration;
  const declaration = (fn.body!.statements[0] as ts.VariableStatement).declarationList.declarations[0]!;
  return { source, declaration, resolve: (id: ts.Identifier) => localValueDeclaration(id, checker) };
}

for (const body of [
  "let x=1; { let x=2; x=3; }",
  "let x=1; function g() { let x=2; x++; }",
  "let x=1; function g(x) { x=3; }",
  "let x=1; function g() { x=3; var x; }",
  "let x=1; try {} catch(x) { x=3; }",
  "let x=1; for(let x of [2]) { x++; }",
  "let x=1; function g() { var x=2; }",
  "let x=1; const o={x:2}; o.x=3;",
])
  it(`ignores distinct binding: ${body}`, () => {
    const { declaration, resolve } = fixture(body);
    expect(localIsRewritten(declaration, resolve)).toBe(false);
  });

for (const tail of [
  "x=2;",
  "x+=2;",
  "x++;",
  "function g(){x=2;}",
  "[x]=[2];",
  "({x}=o);",
  "({a:x}=o);",
  "[x=2]=[];",
  "for(x of [2]) {}",
  "for(x in {}) {}",
  "var x='s';",
  "for(var x of [2]) {}",
  "for(var x in {}) {}",
  "(x)=2;",
  "(x as any)=2;",
])
  it(`retains real write: ${tail}`, () => {
    const { declaration, resolve } = fixture(`var x=1; ${tail}`);
    expect(localIsRewritten(declaration, resolve)).toBe(true);
  });

for (const tail of ['eval("x=2");', '(eval)("x=2");', "with(o) { x=2; }"]) {
  it(`dynamic scope remains conservative: ${tail}`, () => {
    const { declaration, resolve } = fixture(`let x=1; ${tail}`);
    expect(localIsRewritten(declaration, resolve)).toBe(true);
  });
}

it("does not reuse another resolver's proof", () => {
  const { declaration, resolve } = fixture("let x=1; {let x=2; x=3;}");
  expect(localIsRewritten(declaration, resolve)).toBe(false);
  expect(localIsRewritten(declaration, () => undefined)).toBe(true);
  expect(localIsRewritten(declaration)).toBe(true);
});

it("unresolved same-name targets remain conservative", () => {
  const { declaration } = fixture("let x=1; {let x=2; x=3;}");
  expect(localIsRewritten(declaration, () => undefined)).toBe(true);
});

for (const [tail, admitted] of [
  ["{let x=2; x=3;}", true],
  ["function g(x) { x=3; }", true],
  ["function g() { x=3; }", false],
  ["var x='s';", false],
] as const) {
  it(`ES5 predicate selector consumes binding identity: ${tail}`, () => {
    const { source, resolve } = fixture(`var x=1; ${tail} if(Array.isArray(x)) return 0;`);
    let call: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) call = node;
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(call).toBeDefined();
    const verdict = selectStaticPredicateCall(call!, {
      isAmbientNamespace: (id) => resolve(id) === undefined,
      isGlobalUndefined: () => false,
      localDeclaration: (id) => {
        const d = resolve(id);
        return d && ts.isVariableDeclaration(d) ? d : undefined;
      },
      valueDeclaration: resolve,
      family: (node) => (ts.isNumericLiteral(node) ? "number" : "unknown"),
      additiveLane: { numberToString: false, leafReadsElement: () => false },
      isStringMethodCall: () => false,
      declaredSlotFamily: () => "unknown",
      argumentSlotFamily: () => undefined,
    });
    expect(verdict?.admitted).toBe(admitted);
  });
}

// Without a resolver (a bare selector), the same write definition applies by name.
for (const tail of [
  "var x=5;",
  "for(var x of [2]) {}",
  "for(var x in {}) {}",
  "(x as any)=2;",
  'eval("x=2");',
  "with(o) { x=2; }",
])
  it(`counts the same writes without a resolver: ${tail}`, () => {
    const { declaration } = fixture(`var x=1; ${tail}`);
    expect(localIsRewritten(declaration)).toBe(true);
  });

// mixedConditionalCarrierLocal: a repeated `var` replaces the conditional's carrier.
it("a repeated var initializer rewrites the mixed-conditional local", () => {
  const { declaration, resolve } = fixture('var v = c ? 4294967295 : "unlikely"; var v = 5;');
  expect(localIsRewritten(declaration, resolve)).toBe(true);
  expect(localIsRewritten(declaration)).toBe(true);
});

// The call graph: `var f = …` rebinds a function declaration, so `f()` has no direct-call edge.
it("a var initializer rebinds a function declaration", () => {
  const { source, resolve } = fixture(
    "var h = 0; function g() { return 1; } var g = function () { return 2; }; return g();",
  );
  const fn = (source.statements[0] as ts.FunctionDeclaration).body!.statements[1] as ts.FunctionDeclaration;
  expect(localIsRewritten(fn, resolve)).toBe(true);
  expect(localIsRewritten(fn)).toBe(true);
});

// Parameter facts read the same write definition: a `var` re-declaring the
// parameter writes it, and `with` / direct `eval` may write any parameter.
for (const [body, fact] of [
  ["return p + 1;", "number"],
  ['var p = "s"; return p + 1;', undefined],
  ['eval("p = 2"); return p + 1;', undefined],
] as const)
  it(`parameter fact for f(p) { ${body} }`, () => {
    const source = ts.createSourceFile(
      "/p.js",
      `function f(p) { ${body} }`,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.JS,
    );
    const fn = source.statements[0] as ts.FunctionDeclaration;
    const facts = collectLatticeParamFacts(fn, [{ name: "p", type: irVal({ kind: "f64" }) }]);
    expect(facts?.get(fn.parameters[0]!)).toBe(fact);
  });
