// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { genericCallbackResultCall, genericCallbackResultDeclaration } from "../src/codegen/generic-callback-result.js";
import { compile, wrapExports } from "../src/index.js";
import { ts } from "../src/ts-api.js";

function typedSource(source: string): { checker: ts.TypeChecker; sourceFile: ts.SourceFile } {
  const fileName = "/generic-callback-result.ts";
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const sourceFile = ts.createSourceFile(fileName, source, options.target!, true, ts.ScriptKind.TS);
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? source : undefined);
  host.getSourceFile = (name) => (name === fileName ? sourceFile : undefined);
  host.writeFile = () => {};
  const program = ts.createProgram([fileName], options, host);
  return { checker: program.getTypeChecker(), sourceFile };
}

function typedSources(sources: Readonly<Record<string, string>>): {
  checker: ts.TypeChecker;
  sourceFiles: ReadonlyMap<string, ts.SourceFile>;
} {
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const sourceFiles = new Map(
    Object.entries(sources).map(([fileName, source]) => [
      fileName,
      ts.createSourceFile(fileName, source, options.target!, true, ts.ScriptKind.TS),
    ]),
  );
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (name) => sourceFiles.has(name);
  host.readFile = (name) => sources[name];
  host.getSourceFile = (name) => sourceFiles.get(name);
  host.writeFile = () => {};
  const program = ts.createProgram([...sourceFiles.keys()], options, host);
  return { checker: program.getTypeChecker(), sourceFiles };
}

function namedFunctions(sourceFile: ts.SourceFile): Map<string, ts.FunctionDeclaration> {
  const functions = new Map<string, ts.FunctionDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions;
}

function initializedCalls(sourceFile: ts.SourceFile): Map<string, ts.CallExpression> {
  const calls = new Map<string, ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      calls.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

type ScannerPropertyFixtureOptions = {
  additionalObjectProperty?: string;
  factoryMutation?: string;
  factoryBindingMutation?: string;
  factoryArgument?: string;
  factoryKind?: "function" | "async function" | "function*";
  factoryParameter?: string;
  factoryReturn?: string;
  methodBindingMutation?: string;
  extraProperty?: string;
  receiverMutation?: string;
  receiverEscape?: string;
  lookAheadBody?: string;
  forwardedArgument?: string;
};

function scannerPropertySource(options: ScannerPropertyFixtureOptions): string {
  return `
export {};
interface Scanner {
  lookAhead<T>(callback: () => T): T;
}
${options.factoryKind ?? "function"} createScanner(${options.factoryParameter ?? ""}): Scanner {
  function speculationHelper<T>(callback: () => T): T {
    const result = callback();
    return result;
  }
  function lookAhead<T>(callback: () => T): T {
    ${options.lookAheadBody ?? "return speculationHelper(callback);"}
  }
  ${options.methodBindingMutation ?? ""}
  ${options.extraProperty ?? ""}
  const scannerImpl = { lookAhead${options.extraProperty ? ", mutateSelected" : ""}${options.additionalObjectProperty ? `, ${options.additionalObjectProperty}` : ""} };
  ${options.factoryMutation ?? ""}
  ${options.factoryReturn ?? "return scannerImpl;"}
}
${options.factoryBindingMutation ?? ""}
function consumeScanner(_scanner: Scanner): void {}
const scanner = createScanner(${options.factoryArgument ?? ""});
${options.receiverMutation ?? ""}
${options.receiverEscape ?? ""}
function parserSpeculationHelper<T>(callback: () => T, shared: T): T {
  const result = scanner.lookAhead(${options.forwardedArgument ?? "callback"});
  return result;
}
`;
}

function scannerPropertyFixture(options: ScannerPropertyFixtureOptions) {
  return typedSource(scannerPropertySource(options));
}

describe("#1058 generic callback-result semantic detector", () => {
  const source = `
export {};
interface TypeNode { kind: number; }

function speculationHelper<T>(callback: () => T, isLookahead: boolean): T {
  return callback();
}
function tryParse<T>(callback: () => T): T {
  return speculationHelper(callback, false);
}
function parseKeywordAndNoDot(): TypeNode | undefined {
  return { kind: 150 };
}

interface Scanner {
  lookAhead<T>(callback: () => T): T;
  tryScan<T>(callback: () => T): T;
}
function createScanner(): Scanner {
  function scannerSpeculationHelper<T>(callback: () => T, lookahead: boolean): T {
    const result = callback();
    return result;
  }
  function lookAhead<T>(callback: () => T): T {
    return scannerSpeculationHelper(callback, true);
  }
  function tryScan<T>(callback: () => T): T {
    return scannerSpeculationHelper(callback, false);
  }
  const scannerImpl = { lookAhead, tryScan };
  return scannerImpl;
}
const scanner = createScanner();
function parserSpeculationHelper<T>(callback: () => T, lookahead: boolean): T {
  const result = lookahead ? scanner.lookAhead(callback) : scanner.tryScan(callback);
  return result;
}
function parserTryParse<T>(callback: () => T): T {
  return parserSpeculationHelper(callback, false);
}

function wrongResult<T, U>(callback: () => T): U { throw 0; }
function wrongCallback<T, U>(callback: () => U): T { throw 0; }
function wrappedResult<T>(callback: () => T): T | undefined { return callback(); }
function argumentCallback<T>(callback: (value: number) => T): T { return callback(0); }
function optionalCallback<T>(callback?: () => T): T { throw 0; }
function ambiguousCallbacks<T>(left: () => T, right: () => T): T { return left() || right(); }
function wrongBody<T>(callback: () => T, value: T): T { callback(); return value; }
function castSharedValue<T>(callback: () => T, value: unknown): T { callback(); return value as T; }
function unusedCallback<T>(callback: () => T, value: T): T { return value; }
function alternateReturn<T>(callback: () => T, value: T, alternate: boolean): T {
  if (alternate) return callback();
  return value;
}
function conditionalSharedBranch<T>(callback: () => T, value: T, alternate: boolean): T {
  return alternate ? callback() : value;
}
function constrainedCurrentNode<T extends TypeNode | undefined>(
  callback: () => T,
  current: TypeNode | undefined,
): T {
  if (current) return current as T;
  return callback();
}
function nestedBlockResult<T>(callback: () => T, useNestedBlock: boolean): T {
  if (useNestedBlock) {
    const result = callback();
    return result;
  }
  return callback();
}
function reassignedCallback<T>(callback: () => T, value: T): T {
  callback = () => value;
  return callback();
}
function reassignedResult<T>(callback: () => T, value: T): T {
  let result = callback();
  result = value;
  return result;
}
function fakeForward<T>(callback: () => T, value: T): T { return value; }
function forwardsToFake<T>(callback: () => T, value: T): T { return fakeForward(callback, value); }
async function asyncCallback<T>(callback: () => T): T { return callback(); }
function* generatorCallback<T>(callback: () => T): T { return callback(); }
function redeclaredCallback<T>(callback: () => T, value: T): T {
  var callback = () => value;
  return callback();
}
function destructuredCallbackRedeclaration<T>(callback: () => T, value: T): T {
  var { replacement: callback } = { replacement: () => value };
  return callback();
}
function loopCallbackRedeclaration<T>(callback: () => T, value: T): T {
  for (var callback of [() => value]) {}
  return callback();
}
function callbackFunctionCollision<T>(callback: () => T, value: T): T {
  function callback(): T { return value; }
  return callback();
}
function duplicateCallbackParameter<T>(callback: () => T, callback: number): T {
  return callback();
}
function duplicateDestructuredCallbackParameter<T>(callback: () => T, { replacement: callback }: any): T {
  return callback();
}
function mappedArgumentsCallback<T>(callback: () => T, value: T): T {
  arguments[0] = () => value;
  return callback();
}
function nestedArgumentsCallback<T>(callback: () => T, value: T): T {
  (() => { arguments[0] = () => value; })();
  return callback();
}
function destructuredResultRedeclaration<T>(callback: () => T, value: T): T {
  const result = callback();
  var { replacement: result } = { replacement: value };
  return result;
}
function loopResultRedeclaration<T>(callback: () => T, value: T): T {
  const result = callback();
  for (var result of [value]) {}
  return result;
}
function initializedResultRedeclaration<T>(callback: () => T, value: T): T {
  const result = callback();
  var result = value;
  return result;
}

const scalarCall = tryParse(() => true);
const referenceCall = tryParse(parseKeywordAndNoDot);
const scannerReferenceCall = parserTryParse(parseKeywordAndNoDot);
`;

  it("admits the dispatcher and its forwarding wrapper", () => {
    const { checker, sourceFile } = typedSource(source);
    const functions = namedFunctions(sourceFile);
    const ctx = { checker };

    const dispatcher = genericCallbackResultDeclaration(ctx, functions.get("speculationHelper")!);
    const wrapper = genericCallbackResultDeclaration(ctx, functions.get("tryParse")!);

    expect(dispatcher?.callbackParameterIndex).toBe(0);
    expect(wrapper?.callbackParameterIndex).toBe(0);
    expect(dispatcher?.resultTypeParameter.flags & ts.TypeFlags.TypeParameter).not.toBe(0);
    expect(wrapper?.resultTypeParameter.flags & ts.TypeFlags.TypeParameter).not.toBe(0);
  });

  it("admits a constraint-backed asserted fallback before the callback result", () => {
    const { checker, sourceFile } = typedSource(source);
    const declaration = namedFunctions(sourceFile).get("constrainedCurrentNode")!;

    expect(genericCallbackResultDeclaration({ checker }, declaration)?.callbackParameterIndex).toBe(0);
  });

  it("admits a stable callback-derived const inside a nested block", () => {
    const { checker, sourceFile } = typedSource(source);
    const declaration = namedFunctions(sourceFile).get("nestedBlockResult")!;

    expect(genericCallbackResultDeclaration({ checker }, declaration)?.callbackParameterIndex).toBe(0);
  });

  it("follows a stable factory receiver to its shorthand scanner methods", () => {
    const { checker, sourceFile } = typedSource(source);
    const functions = namedFunctions(sourceFile);
    const ctx = { checker };

    expect(genericCallbackResultDeclaration(ctx, functions.get("scannerSpeculationHelper")!)).not.toBeNull();
    expect(genericCallbackResultDeclaration(ctx, functions.get("lookAhead")!)).not.toBeNull();
    expect(genericCallbackResultDeclaration(ctx, functions.get("tryScan")!)).not.toBeNull();
    expect(genericCallbackResultDeclaration(ctx, functions.get("parserSpeculationHelper")!)).not.toBeNull();
    expect(genericCallbackResultDeclaration(ctx, functions.get("parserTryParse")!)).not.toBeNull();
  });

  it.each([
    ["logical-not", "!scanner.lookAhead"],
    ["typeof", 'typeof scanner.lookAhead === "function"'],
    ["void", "void scanner.lookAhead"],
  ])("keeps scanner provenance across a non-mutating %s read", (_name, read) => {
    const { checker, sourceFile } = scannerPropertyFixture({
      receiverMutation: `const observation = ${read};`,
    });
    const declaration = namedFunctions(sourceFile).get("parserSpeculationHelper")!;

    expect(genericCallbackResultDeclaration({ checker }, declaration)).not.toBeNull();
  });

  it("resolves scalar and reference callback results at direct calls", () => {
    const { checker, sourceFile } = typedSource(source);
    const calls = initializedCalls(sourceFile);
    const ctx = { checker };

    const scalar = genericCallbackResultCall(ctx, calls.get("scalarCall")!);
    const reference = genericCallbackResultCall(ctx, calls.get("referenceCall")!);
    const scannerReference = genericCallbackResultCall(ctx, calls.get("scannerReferenceCall")!);

    expect(checker.typeToString(scalar!.callbackResultType)).toBe("boolean");
    expect(checker.typeToString(scalar!.resultType)).toBe("boolean");
    expect(checker.typeToString(reference!.callbackResultType)).toBe("TypeNode | undefined");
    expect(checker.typeToString(reference!.resultType)).toBe("TypeNode | undefined");
    expect(checker.typeToString(scannerReference!.resultType)).toBe("TypeNode | undefined");
  });

  it.each([
    "wrongResult",
    "wrongCallback",
    "wrappedResult",
    "argumentCallback",
    "optionalCallback",
    "ambiguousCallbacks",
    "wrongBody",
    "castSharedValue",
    "unusedCallback",
    "alternateReturn",
    "conditionalSharedBranch",
    "reassignedCallback",
    "reassignedResult",
    "fakeForward",
    "forwardsToFake",
    "asyncCallback",
    "generatorCallback",
    "redeclaredCallback",
    "destructuredCallbackRedeclaration",
    "loopCallbackRedeclaration",
    "callbackFunctionCollision",
    "duplicateCallbackParameter",
    "duplicateDestructuredCallbackParameter",
    "mappedArgumentsCallback",
    "nestedArgumentsCallback",
    "destructuredResultRedeclaration",
    "loopResultRedeclaration",
    "initializedResultRedeclaration",
  ])("rejects the mismatched declaration %s", (name) => {
    const { checker, sourceFile } = typedSource(source);
    const declaration = namedFunctions(sourceFile).get(name)!;
    expect(genericCallbackResultDeclaration({ checker }, declaration)).toBeNull();
  });

  it.each([
    [
      "direct eval",
      `function candidate<T>(callback: () => T, value: T): T {
        eval("callback = () => value");
        return callback();
      }`,
    ],
    [
      "nested eval",
      `function candidate<T>(callback: () => T, value: T): T {
        (() => eval("callback = () => value"))();
        return callback();
      }`,
    ],
    [
      "default-parameter eval",
      `function candidate<T>(callback: () => T, value: T, ignored = eval("callback = () => value")): T {
        return callback();
      }`,
    ],
    [
      "with scope",
      `function candidate<T>(callback: () => T, value: T): T {
        with ({ callback: () => value }) { return callback(); }
        return callback();
      }`,
    ],
  ])("rejects callback provenance through %s", (_name, candidate) => {
    const { checker, sourceFile } = typedSource(`export {}; ${candidate}`);
    const declaration = namedFunctions(sourceFile).get("candidate")!;
    expect(genericCallbackResultDeclaration({ checker }, declaration)).toBeNull();
  });

  it.each([
    ["factory target write", { factoryMutation: "(scannerImpl as any).lookAhead = lookAhead;" }],
    [
      "factory computed write",
      {
        factoryMutation: 'const selected = "lookAhead"; (scannerImpl as any)[selected] = lookAhead;',
      },
    ],
    ["receiver target write", { receiverMutation: "(scanner as any).lookAhead = scanner.lookAhead;" }],
    ["receiver prefix increment", { receiverMutation: "++(scanner as any).lookAhead;" }],
    ["receiver postfix decrement", { receiverMutation: "(scanner as any).lookAhead--;" }],
    [
      "receiver object-pattern write",
      {
        receiverMutation: "({ lookAhead: scanner.lookAhead } = { lookAhead: scanner.lookAhead });",
      },
    ],
    ["receiver array-pattern write", { receiverMutation: "[scanner.lookAhead] = [scanner.lookAhead];" }],
    [
      "receiver dynamic-key write",
      {
        receiverMutation: 'const selectedProperty = "lookAhead"; scanner[selectedProperty] = scanner.lookAhead;',
      },
    ],
    [
      "legacy receiver getter mutation",
      {
        receiverMutation:
          'scanner.__defineGetter__("lookAhead", () => function <T>(callback: () => T): T { return callback(); });',
      },
    ],
    ["receiver for-of write", { receiverMutation: "for (scanner.lookAhead of [scanner.lookAhead]) {}" }],
    [
      "receiver destructured for-of write",
      { receiverMutation: "for ([scanner.lookAhead] of [[scanner.lookAhead]]) {}" },
    ],
    ["receiver escape", { receiverEscape: "consumeScanner(scanner);" }],
    ["fake shorthand body", { lookAheadBody: "return (0 as unknown) as T;" }],
    ["replaced callback", { forwardedArgument: "() => shared" }],
    [
      "factory binding reassignment",
      {
        factoryBindingMutation: "createScanner = () => ({ lookAhead: <T>(callback: () => T): T => callback() });",
      },
    ],
    [
      "shorthand method binding reassignment",
      {
        methodBindingMutation: "lookAhead = function <T>(callback: () => T): T { return callback(); };",
      },
    ],
    [
      "this-based sibling method mutation",
      {
        extraProperty: "function mutateSelected(this: any): void { this.lookAhead = lookAhead; }",
      },
    ],
    [
      "reassigned sibling method mutation",
      {
        extraProperty: "function mutateSelected(): void {}",
        methodBindingMutation: "mutateSelected = function (this: any): void { this.lookAhead = lookAhead; };",
      },
    ],
    [
      "unknown callable property",
      {
        factoryParameter: "mutateSelected: () => void",
        factoryArgument: "function (this: any): void { this.lookAhead = () => 0; }",
        extraProperty: "// parameter-backed property",
      },
    ],
    [
      "computed callable property",
      {
        extraProperty:
          "function mutateSelected(): void {} function makePoison(): () => void { return function (this: any): void { this.lookAhead = lookAhead; }; }",
        additionalObjectProperty: "poison: makePoison()",
        receiverMutation: "(scanner as any).poison();",
      },
    ],
    [
      "computed prototype property",
      {
        extraProperty:
          "function mutateSelected(): void {} function makePrototype(): object { return { poison: function (this: any): void { this.lookAhead = lookAhead; } }; }",
        additionalObjectProperty: "__proto__: makePrototype()",
        receiverMutation: "scanner.poison();",
      },
    ],
    [
      "externally assigned this mutator",
      {
        extraProperty:
          "function mutateSelected(): void {} function poison(this: any): void { this.lookAhead = <T>(callback: () => T): T => (0 as unknown as T); }",
        receiverMutation: "(scanner as any).poison = poison; (scanner as any).poison();",
      },
    ],
    ["async factory", { factoryKind: "async function" }],
    ["generator factory", { factoryKind: "function*" }],
    ["factory fallthrough", { factoryReturn: "if (true) return scannerImpl;" }],
    [
      "duplicate shorthand method body",
      {
        methodBindingMutation: "function lookAhead<T>(callback: () => T): T { return (0 as unknown) as T; }",
      },
    ],
    [
      "duplicate factory body",
      {
        factoryBindingMutation:
          "function createScanner(): Scanner { return { lookAhead: <T>(callback: () => T): T => callback() }; }",
      },
    ],
    ["factory direct eval", { factoryMutation: 'eval("scannerImpl.lookAhead = lookAhead");' }],
    [
      "sibling method eval",
      {
        extraProperty: 'function mutateSelected(): void { eval("scannerImpl.lookAhead = lookAhead"); }',
      },
    ],
  ])("rejects scanner property provenance after a %s", (_name, options) => {
    const { checker, sourceFile } = scannerPropertyFixture(options);
    const declaration = namedFunctions(sourceFile).get("parserSpeculationHelper")!;
    expect(genericCallbackResultDeclaration({ checker }, declaration)).toBeNull();
  });

  it("does not reuse an admission across different callable source contexts", () => {
    const { checker, sourceFile } = typedSource(source);
    const declaration = namedFunctions(sourceFile).get("parserSpeculationHelper")!;
    expect(genericCallbackResultDeclaration({ checker }, declaration)).not.toBeNull();
    expect(genericCallbackResultDeclaration({ checker, callableSourceFiles: [] }, declaration)).toBeNull();
  });

  it("rejects a reassigned direct forwarding helper", () => {
    const { checker, sourceFile } = typedSource(`
export {};
function helper<T>(callback: () => T): T { return callback(); }
function replacement<T>(callback: () => T): T { return callback(); }
helper = replacement;
function wrapper<T>(callback: () => T): T { return helper(callback); }
`);
    const declaration = namedFunctions(sourceFile).get("wrapper")!;
    expect(genericCallbackResultDeclaration({ checker }, declaration)).toBeNull();
  });

  it("rejects an initialized var redeclaration of a forwarding helper", () => {
    const { checker, sourceFile } = typedSource(`
export {};
function helper<T>(callback: () => T): T { return callback(); }
function replacement<T>(callback: () => T): T { return callback(); }
var helper = replacement;
function wrapper<T>(callback: () => T): T { return helper(callback); }
`);
    const declaration = namedFunctions(sourceFile).get("wrapper")!;
    expect(genericCallbackResultDeclaration({ checker }, declaration)).toBeNull();
  });

  it("rejects duplicate body-bearing forwarding declarations", () => {
    const { checker, sourceFile } = typedSource(`
export {};
function helper<T>(callback: () => T, value: T): T { return callback(); }
function helper<T>(callback: () => T, value: T): T { return value; }
function wrapper<T>(callback: () => T, value: T): T { return helper(callback, value); }
`);
    const declaration = namedFunctions(sourceFile).get("wrapper")!;
    expect(genericCallbackResultDeclaration({ checker }, declaration)).toBeNull();
  });

  it("rejects direct declaration binding reassignment", () => {
    const { checker, sourceFile } = typedSource(`
export {};
function candidate<T>(callback: () => T): T { return callback(); }
candidate = ((callback: () => unknown): unknown => 42) as any;
`);
    const declaration = namedFunctions(sourceFile).get("candidate")!;
    expect(genericCallbackResultDeclaration({ checker }, declaration)).toBeNull();
  });

  it("rejects direct-eval replacement from a sibling scope", () => {
    const { checker, sourceFile } = typedSource(`
export {};
function candidate<T>(callback: () => T): T { return callback(); }
function replace(): void { eval("candidate = (_callback: any) => 42"); }
replace();
`);
    const declaration = namedFunctions(sourceFile).get("candidate")!;
    expect(genericCallbackResultDeclaration({ checker }, declaration)).toBeNull();
  });

  it("fails closed for global-script declarations", () => {
    const { checker, sourceFile } = typedSource(`
function helper<T>(callback: () => T): T { return callback(); }
`);
    const declaration = namedFunctions(sourceFile).get("helper")!;
    expect(genericCallbackResultDeclaration({ checker, callableSourceFiles: [sourceFile] }, declaration)).toBeNull();
  });

  it("rejects a selected-property write from another global script", () => {
    const { checker, sourceFiles } = typedSources({
      "/factory.ts": scannerPropertySource({}).replace("export {};", ""),
      "/mutation.ts": `
scanner.lookAhead = <T>(callback: () => T): T => callback();
`,
    });
    const factorySource = sourceFiles.get("/factory.ts")!;
    const declaration = namedFunctions(factorySource).get("parserSpeculationHelper")!;
    expect(
      genericCallbackResultDeclaration({ checker, callableSourceFiles: [...sourceFiles.values()] }, declaration),
    ).toBeNull();
  });

  it.each([
    ["this-bearing descriptor", "{ get() { (this as any).lookAhead = lookAhead; return 1; } }", ""],
    [
      "replaced Object.defineProperty",
      "{ value: 1 }",
      "(Object as any).defineProperty = (target: any): any => target;",
    ],
  ])("rejects an unsafe unrelated defineProperty %s", (_name, descriptor, mutation) => {
    const libName = "/lib.es5.d.ts";
    const sourceName = "/factory.ts";
    const { checker, sourceFiles } = typedSources({
      [libName]: `
interface ObjectConstructor {
  defineProperty<T>(target: T, key: string, descriptor: any): T;
}
declare var Object: ObjectConstructor;
`,
      [sourceName]: `
export {};
interface Scanner { lookAhead<T>(callback: () => T): T; }
function createScanner(): Scanner {
  function lookAhead<T>(callback: () => T): T { return callback(); }
  const scannerImpl = { lookAhead };
  ${mutation}
  Object.defineProperty(scannerImpl, "debug", ${descriptor});
  return scannerImpl;
}
const scanner = createScanner();
function wrapper<T>(callback: () => T): T { return scanner.lookAhead(callback); }
`,
    });
    const sourceFile = sourceFiles.get(sourceName)!;
    const declaration = namedFunctions(sourceFile).get("wrapper")!;
    expect(genericCallbackResultDeclaration({ checker, callableSourceFiles: [sourceFile] }, declaration)).toBeNull();
  });
});

async function compileAndInstantiate(source: string) {
  const result = await compile(source, {
    fileName: "issue-1058-generic-callback-result.ts",
    platform: "node",
    skipSemanticDiagnostics: true,
    target: "gc",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

describe("#1058 boolean-first generic parser callback result", () => {
  it("materializes a stable nested function value on every conditional read path", async () => {
    const exports = await compileAndInstantiate(`
function apply(callback: () => number): number {
  return callback();
}

export function test(mode: number): number {
  let seed = 40;
  let result = 0;
  if (mode === 1) result = apply(named);
  if (mode === 2) result = apply(named);
  return result;

  function named(): number {
    return seed + 2;
  }
}
`);

    expect(exports.test(2)).toBe(42);
  });

  it("keeps later scalar and TypeNode callback results behind the same local wrapper", async () => {
    const exports = await compileAndInstantiate(`
interface TypeNode {
  kind: number;
  detail: number;
}

let currentToken = 150;

interface Scanner {
  lookAhead<T>(callback: () => T): T;
  tryScan<T>(callback: () => T): T;
}

function createScanner(): Scanner {
  function scannerSpeculationHelper<T>(callback: () => T, isLookahead: boolean): T {
    const saveToken = currentToken;
    const result = callback();
    if (!result || isLookahead) currentToken = saveToken;
    return result;
  }

  function scannerLookAhead<T>(callback: () => T): T {
    return scannerSpeculationHelper(callback, true);
  }

  function scannerTryScan<T>(callback: () => T): T {
    return scannerSpeculationHelper(callback, false);
  }

  const scannerImpl = {
    lookAhead: scannerLookAhead,
    tryScan: scannerTryScan,
  };
  Object.defineProperty(scannerImpl, "__debugShowCurrentPositionInText", { value: 1 });
  return scannerImpl;
}

const scanner = createScanner();

function speculationHelper<T>(callback: () => T, isLookahead: boolean): T {
  const saveToken = currentToken;
  const result = isLookahead ? scanner.lookAhead(callback) : scanner.tryScan(callback);
  if (!result || isLookahead) currentToken = saveToken;
  return result;
}

function tryParse<T>(callback: () => T): T {
  return speculationHelper(callback, false);
}

function lookAhead<T>(callback: () => T): T {
  return speculationHelper(callback, true);
}

function isStartOfType(): boolean {
  return currentToken === 150;
}

function parseScalar(): number {
  return 42;
}

function parseKeywordAndNoDot(): TypeNode | undefined {
  const node: TypeNode = { kind: currentToken, detail: 42 };
  currentToken = 151;
  return currentToken === 25 ? undefined : node;
}

function fallback(): TypeNode {
  return { kind: 0, detail: 1 };
}

export function scalarCase(): number {
  const predicate = tryParse(() => lookAhead(isStartOfType));
  const scalar = tryParse(parseScalar);
  return (predicate ? 1000 : 0) + scalar;
}

export function referenceCase(): number {
  currentToken = 150;
  const predicate = tryParse(() => lookAhead(isStartOfType));
  const node = tryParse(parseKeywordAndNoDot) || fallback();
  return (predicate ? 1000 : 0) + node.kind + node.detail;
}
`);

    expect(exports.scalarCase()).toBe(1042);
    expect(exports.referenceCase()).toBe(1192);
  });

  it("keeps a lifted two-layer parser helper result after a void call and unary scanner read", async () => {
    const exports = await compileAndInstantiate(`
interface TypeNode {
  kind: number;
  detail: number;
}

interface Scanner {
  lookAhead<T>(callback: () => T): T;
  tryScan<T>(callback: () => T): T;
  hasPrecedingLineBreak(): boolean;
}

function createScanner(): Scanner {
  function scannerSpeculationHelper<T>(callback: () => T, isLookahead: boolean): T {
    const result = callback();
    return result;
  }
  function scannerLookAhead<T>(callback: () => T): T {
    return scannerSpeculationHelper(callback, true);
  }
  function scannerTryScan<T>(callback: () => T): T {
    return scannerSpeculationHelper(callback, false);
  }
  function hasPrecedingLineBreak(): boolean {
    return false;
  }
  const scanner = { lookAhead: scannerLookAhead, tryScan: scannerTryScan, hasPrecedingLineBreak };
  return scanner;
}

function runNestedParserCase(reference: boolean): number {
  let currentToken = 150;
  const scanner = createScanner();

  // These are lifted FunctionDeclarations in the real compiler, unlike the
  // module-level helper exercised above. The first textual call deliberately
  // has a void callback, matching TypeScript's incremental-parser reset path.
  function resetState(): void {
    speculationHelper((): void => {
      currentToken = 150;
    }, true);
  }

  function speculationHelper<T>(callback: () => T, isLookahead: boolean): T {
    const saveToken = currentToken;
    const result = isLookahead ? scanner.lookAhead(callback) : scanner.tryScan(callback);
    if (!result || isLookahead) currentToken = saveToken;
    return result;
  }

  function lookAhead<T>(callback: () => T): T {
    return speculationHelper(callback, true);
  }

  function tryParse<T>(callback: () => T): T {
    return speculationHelper(callback, false);
  }

  function isStartOfType(): boolean {
    return !scanner.hasPrecedingLineBreak() && currentToken === 150;
  }

  function parseKeywordAndNoDot(): TypeNode | undefined {
    const node: TypeNode = { kind: currentToken, detail: 42 };
    currentToken = 151;
    return node;
  }

  resetState();
  const predicate = tryParse(() => lookAhead(isStartOfType));
  if (!reference) {
    const scalar = tryParse(() => 42);
    return (predicate ? 1000 : 0) + scalar;
  }
  const node = tryParse(parseKeywordAndNoDot);
  return (predicate ? 1000 : 0) + node.kind + node.detail;
}

export function nestedScalarCase(): number {
  return runNestedParserCase(false);
}

export function nestedReferenceCase(): number {
  return runNestedParserCase(true);
}
`);

    expect(exports.nestedScalarCase()).toBe(1042);
    expect(exports.nestedReferenceCase()).toBe(1192);
  });

  it("keeps a runtime namespace helper result after a first void instantiation", async () => {
    const exports = await compileAndInstantiate(`
interface TypeNode {
  kind: number;
  detail: number;
}

namespace Parser {
  let currentToken = 150;

  function resetState(): void {
    speculationHelper((): void => {
      currentToken = 150;
    }, true);
  }

  function speculationHelper<T>(callback: () => T, isLookahead: boolean): T {
    const saveToken = currentToken;
    const result = callback();
    if (!result || isLookahead) currentToken = saveToken;
    return result;
  }

  function parseKeywordAndNoDot(): TypeNode {
    const node: TypeNode = { kind: currentToken, detail: 42 };
    currentToken = 151;
    return node;
  }

  export function scalarCase(): number {
    resetState();
    return speculationHelper(() => 42, false);
  }

  export function referenceCase(): number {
    resetState();
    const node = speculationHelper(parseKeywordAndNoDot, false);
    return node.kind + node.detail;
  }
}

export function namespaceScalarCase(): number {
  return Parser.scalarCase();
}

export function namespaceReferenceCase(): number {
  return Parser.referenceCase();
}
`);

    expect(exports.namespaceScalarCase()).toBe(42);
    expect(exports.namespaceReferenceCase()).toBe(192);
  });

  it("invokes a later nested optional-parameter callback without an argument", async () => {
    const exports = await compileAndInstantiate(`
interface Identifier {
  kind: number;
}

type DiagnosticMessage = object;

let optionalParameterWasUndefined = false;
let returnedKind = 0;

function invokeCallback<T>(callback: () => T): T {
  return callback();
}

export function runOptionalParameterCase(): void {
  const identifierKind = 42;
  const identifier = invokeCallback(createIdentifier);
  returnedKind = identifier.kind;

  function createIdentifier(diagnosticMessage?: DiagnosticMessage): Identifier {
    optionalParameterWasUndefined = diagnosticMessage === undefined;
    return { kind: identifierKind };
  }
}

export function observedUndefinedOptionalParameter(): boolean {
  return optionalParameterWasUndefined;
}

export function optionalParameterResultKind(): number {
  return returnedKind;
}
`);

    exports.runOptionalParameterCase();
    expect(exports.observedUndefinedOptionalParameter()).toBeTruthy();
    expect(exports.optionalParameterResultKind()).toBe(42);
  });

  it("dispatches a cached optional-parameter declaration through a zero-argument callback", async () => {
    const exports = await compileAndInstantiate(`
interface Identifier {
  kind: number;
}

type DiagnosticMessage = object;

const requiredSameAbi = (_diagnosticMessage: DiagnosticMessage): Identifier => ({ kind: 7 });

namespace Parser {
  let optionalParameterWasUndefined = false;

  function parseIdentifierName(diagnosticMessage?: DiagnosticMessage): Identifier {
    optionalParameterWasUndefined = diagnosticMessage === undefined;
    return { kind: 42 };
  }

  function parseModuleExportName(parseName: () => Identifier): Identifier {
    return parseName();
  }

  function invokeRequiredAsZero(callback: () => number): number {
    return callback();
  }

  function requiredDiagnosticMessage(_diagnosticMessage: DiagnosticMessage): number {
    return 99;
  }

  export function runModuleExportNameCase(): number {
    return parseModuleExportName(parseIdentifierName).kind;
  }

  export function observedModuleExportNameOptionalParameter(): boolean {
    return optionalParameterWasUndefined;
  }

  export function runRequiredParameterCase(): number {
    return invokeRequiredAsZero(requiredDiagnosticMessage as unknown as () => number);
  }
}

export function runModuleExportNameCase(): number {
  return Parser.runModuleExportNameCase();
}

export function observedModuleExportNameOptionalParameter(): boolean {
  return Parser.observedModuleExportNameOptionalParameter();
}

export function runRequiredParameterCase(): number {
  return Parser.runRequiredParameterCase();
}

export function callRequiredSameAbi(message: DiagnosticMessage): number {
  return requiredSameAbi(message).kind;
}
`);

    expect(exports.callRequiredSameAbi({})).toBe(7);
    expect(exports.runModuleExportNameCase()).toBe(42);
    expect(exports.observedModuleExportNameOptionalParameter()).toBeTruthy();
    expect(() => exports.runRequiredParameterCase()).toThrow();
  });

  it("retains optional arity after a later same-ABI closure replaces the live registry entry", async () => {
    const exports = await compileAndInstantiate(`
interface Identifier {
  kind: number;
}

type DiagnosticMessage = object;

let optionalParameterWasUndefined = false;

function parseIdentifierName(diagnosticMessage?: DiagnosticMessage): Identifier {
  optionalParameterWasUndefined = diagnosticMessage === undefined;
  return { kind: 42 };
}

// Compiled first: its callback call pre-registers parseIdentifierName and
// observes that the single externref parameter is optional.
function warmOptionalRegistration(callback: () => Identifier): Identifier {
  return callback();
}

// Compiled next: this required-parameter arrow has the exact same lowered
// funcref ABI and replaces the base wrapper's live ClosureInfo record.
function overwriteLiveRegistryEntry(message: DiagnosticMessage): number {
  const requiredSameAbi = (requiredMessage: DiagnosticMessage): Identifier => ({
    kind: requiredMessage === undefined ? -1 : 7,
  });
  return requiredSameAbi(message).kind;
}

// Compiled after the overwrite. Its zero-argument callback dispatcher must
// still retain the optional one-parameter parseIdentifierName candidate.
function parseModuleExportName(parseName: () => Identifier): Identifier {
  return parseName();
}

function invokeRequiredAsZero(callback: () => number): number {
  return callback();
}

function requiredDiagnosticMessage(_diagnosticMessage: DiagnosticMessage): number {
  return 99;
}

export function runOptionalCase(): number {
  if (overwriteLiveRegistryEntry({}) !== 7) return -1;
  // Keep the early dispatcher live as well as compile-order-relevant.
  if (warmOptionalRegistration(() => ({ kind: 1 })).kind !== 1) return -2;
  return parseModuleExportName(parseIdentifierName).kind;
}

export function observedUndefinedOptionalParameter(): boolean {
  return optionalParameterWasUndefined;
}

export function runRequiredParameterCase(): number {
  return invokeRequiredAsZero(requiredDiagnosticMessage as unknown as () => number);
}
`);

    expect(exports.runOptionalCase()).toBe(42);
    expect(exports.observedUndefinedOptionalParameter()).toBeTruthy();
    expect(() => exports.runRequiredParameterCase()).toThrow();
  });

  it("upgrades an early source latch to a later nested declaration's exact callback ABI", async () => {
    const exports = await compileAndInstantiate(`
let optionalParameterWasUndefined = false;

// This top-level body compiles before runParserCase. Its dynamic callback call
// performs the source-wide conservative scan while the nested Identifier class
// below has no physical struct ABI yet.
export function latchParserSource(callback: () => number): number {
  return callback();
}

function invokeRequiredAsZero(callback: () => number): number {
  return callback();
}

function requiredParameter(_value: object): number {
  return 99;
}

export function runParserCase(): number {
  class Identifier {
    kind: number;

    constructor(kind: number) {
      this.kind = kind;
    }
  }

  function parseIdentifierName(diagnosticMessage?: object): Identifier {
    optionalParameterWasUndefined = diagnosticMessage === undefined;
    return new Identifier(42);
  }

  function parseModuleExportName(parseName: () => Identifier): Identifier {
    return parseName();
  }

  return parseModuleExportName(parseIdentifierName).kind;
}

export function observedUndefinedOptionalParameter(): boolean {
  return optionalParameterWasUndefined;
}

export function runRequiredParameterCase(): number {
  return invokeRequiredAsZero(requiredParameter as unknown as () => number);
}
`);

    expect(exports.runParserCase()).toBe(42);
    expect(exports.observedUndefinedOptionalParameter()).toBeTruthy();
    expect(() => exports.runRequiredParameterCase()).toThrow();
  });

  it("keeps sibling node layouts across a constraint-backed current-node fallback", async () => {
    const exports = await compileAndInstantiate(`
interface Node {
  kind: number;
}

interface Statement extends Node {
  statementValue: number;
}

interface Declaration extends Node {
  declarationValue: number;
}

function parseListElement<T extends Node | undefined>(current: Node | undefined, callback: () => T): T {
  if (current) return current as T;
  return callback();
}

function parseStatement(): Statement {
  return { kind: 1, statementValue: 19 };
}

function parseDeclaration(): Declaration {
  return { kind: 2, declarationValue: 23 };
}

export function runConstraintBackedCallbackCase(): number {
  const statement = parseListElement(undefined, parseStatement);
  const declaration = parseListElement(undefined, parseDeclaration);
  return statement.statementValue + declaration.declarationValue;
}
`);

    expect(exports.runConstraintBackedCallbackCase()).toBe(42);
  });

  it("keeps a later AST node after the parser context helper first returns an array", async () => {
    const exports = await compileAndInstantiate(`
interface Node {
  kind: number;
}

interface Expression extends Node {
  value: number;
}

namespace Parser {
  function doOutsideOfContext<T>(context: number, callback: () => T): T {
    if (context) {
      const result = callback();
      return result;
    }
    return callback();
  }

  function doOutsideOfAwaitContext<T>(callback: () => T): T {
    return doOutsideOfContext(1, callback);
  }

  function parseModifiers(): Node[] {
    return [{ kind: 7 }];
  }

  function parseExpression(): Expression {
    return { kind: 11, value: 23 };
  }

  export function runArrayThenExpressionCase(): number {
    const modifiers = doOutsideOfAwaitContext(parseModifiers);
    const expression = doOutsideOfAwaitContext(parseExpression);
    return modifiers[0]!.kind + expression.kind + expression.value;
  }
}

export function runArrayThenExpressionCase(): number {
  return Parser.runArrayThenExpressionCase();
}
`);

    expect(exports.runArrayThenExpressionCase()).toBe(41);
  });
});
