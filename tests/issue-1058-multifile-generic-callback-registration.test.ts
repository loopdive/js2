// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti, wrapExports } from "../src/index.js";

describe("#1058 multi-file generic callback registration", () => {
  it("keeps an inline arrow on the Wasm closure path for a compiled interface method", async () => {
    const result = await compileMulti(
      {
        "./scanner.ts": `
export interface Scanner {
  tryScan<T>(callback: () => T): T;
}

export function createScanner(): Scanner {
  function speculationHelper<T>(callback: () => T): T {
    return callback();
  }
  function tryScan<T>(callback: () => T): T {
    return speculationHelper(callback);
  }
  return { tryScan };
}
`,
        "./parser.ts": `
import { createScanner } from "./scanner.js";

const scanner = createScanner();

function reScanInvalidIdentifier(): number {
  return 80;
}

export function test(): number {
  return scanner.tryScan(() => reScanInvalidIdentifier() === 80) ? 42 : 0;
}
`,
        "./main.ts": `
import { test as parserTest } from "./parser.js";
export function test(): number { return parserTest(); }
`,
      },
      "./main.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as { test(): number };
    expect(exports.test()).toBe(42);
  });

  it("keeps a local interface describing an ambient receiver on the host callback path", async () => {
    const result = await compileMulti(
      {
        "./main.ts": `
interface HostInterface {
  invoke(callback: () => number): number;
}
export function test(host: any): number {
  return (host as HostInterface).invoke(() => 42);
}
`,
      },
      "./main.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((entry) => entry.name)).toContain(
      "__make_callback",
    );
  });

  it("registers later-source named callbacks for an earlier generic dispatcher", async () => {
    const result = await compileMulti(
      {
        "./scanner.ts": `
export interface Scanner {
  scan(): number;
  lookAhead<T>(callback: () => T): T;
  tryScan<T>(callback: () => T): T;
}

export function createScanner(): Scanner {
  let pos = 0;
  function scan(): number {
    pos++;
    return 19;
  }
  function speculationHelper<T>(callback: () => T, isLookahead: boolean): T {
    const savePos = pos;
    const result = callback();
    if (!result || isLookahead) pos = savePos;
    return result;
  }
  function lookAhead<T>(callback: () => T): T {
    return speculationHelper(callback, true);
  }
  function tryScan<T>(callback: () => T): T {
    return speculationHelper(callback, false);
  }
  return { scan, lookAhead, tryScan };
}
`,
        "./parser.ts": `
import { createScanner } from "./scanner.js";

interface NodeLike { kind: number; }
enum Kind { OpenBraceToken = 19, Node = 42, Next = 43, ExportKeyword = 95, ImportKeyword = 102 }

export function createParser() {
  // TypeScript's Parser singleton intentionally uses var here to avoid a TDZ
  // check. Keep that declaration shape in the regression witness.
  var scanner = createScanner();
  let currentToken = Kind.ImportKeyword;

  function parserSpeculationHelper<T>(callback: () => T): T {
    const saveToken = currentToken;
    const result = scanner.lookAhead(callback);
    currentToken = saveToken;
    return result;
  }
  function lookAhead<T>(callback: () => T): T {
    return parserSpeculationHelper(callback);
  }
  function token(): Kind {
    return currentToken;
  }
  function nextToken(): Kind {
    return currentToken = scanner.scan() as Kind;
  }
  function isDeclaration(): boolean {
    switch (token()) {
      case Kind.ImportKeyword:
        nextToken();
        return token() === Kind.OpenBraceToken;
      case Kind.ExportKeyword: {
        // Upstream has this same-name block shadow. The callback still needs
        // the namespace currentToken transitively through token/nextToken.
        let currentToken = nextToken();
        return currentToken === Kind.OpenBraceToken;
      }
      default:
        return false;
    }
  }
  function parseNode(): NodeLike {
    return { kind: Kind.Node };
  }
  function nextValue(): Kind {
    return Kind.Next;
  }

  return function run(): number {
    // Mirrors Parser.lookAhead(isDeclaration), including the second generic
    // callback dispatcher between parser.ts and scanner.ts.
    const predicate = lookAhead(isDeclaration);
    const node = scanner.tryScan(parseNode);
    const value = scanner.tryScan(nextValue);
    return (predicate ? 10000 : 0) + node.kind * 100 + value;
  };
}
`,
        "./main.ts": `
import { createParser } from "./parser.js";
const run = createParser();
export function test(): number { return run(); }
`,
      },
      "./main.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as { test(): number };
    expect(exports.test()).toBe(14243);
  });

  it("materializes an immutable sibling captured from the non-dominating ternary arm", async () => {
    const result = await compileMulti(
      {
        "./visitor.ts": `
function invoke(callback: () => number): number {
  return callback();
}

export function run(useFirst: boolean): number {
  return invoke(useFirst ? first : second);

  function first(): number {
    return 1;
  }

  function second(): number {
    return first ? 42 : 0;
  }
}
`,
        "./main.ts": `
import { run } from "./visitor.js";
export function test(): number { return run(false); }
`,
      },
      "./main.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as { test(): number };
    expect(exports.test()).toBe(42);
  });

  it("preserves both callbacks through a generic object-table handler", async () => {
    const result = await compileMulti(
      {
        "./visitor.ts": `
interface NodeLike {
  kind: number;
  value: number;
  children?: NodeLike[];
  tail?: NodeLike;
}

type ChildCallback<T> = (node: NodeLike) => T | undefined;
type ChildrenCallback<T> = (nodes: NodeLike[]) => T | undefined;
type Handler = <T>(
  node: NodeLike,
  cbNode: ChildCallback<T>,
  cbNodes?: ChildrenCallback<T>,
) => T | undefined;

function visitNode<T>(cbNode: ChildCallback<T>, node: NodeLike | undefined): T | undefined {
  return node && cbNode(node);
}

function visitNodes<T>(
  cbNode: ChildCallback<T>,
  cbNodes: ChildrenCallback<T> | undefined,
  nodes: NodeLike[] | undefined,
): T | undefined {
  if (nodes) {
    if (cbNodes) return cbNodes(nodes);
    for (const node of nodes) {
      const result = cbNode(node);
      if (result) return result;
    }
  }
}

const table: Record<number, Handler> = {
  1: function visitRoot<T>(
    node: NodeLike,
    cbNode: ChildCallback<T>,
    cbNodes?: ChildrenCallback<T>,
  ): T | undefined {
    return visitNodes(cbNode, cbNodes, node.children) || visitNode(cbNode, node.tail);
  },
};

function forEachChild<T>(
  node: NodeLike,
  cbNode: ChildCallback<T>,
  cbNodes?: ChildrenCallback<T>,
): T | undefined {
  const handler = table[node.kind];
  return handler === undefined ? undefined : handler(node, cbNode, cbNodes);
}

export function test(): number {
  const gathered: NodeLike[] = [];
  let arrayCalls = 0;
  let scalarCalls = 0;
  const root: NodeLike = {
    kind: 1,
    value: 0,
    children: [],
    tail: { kind: 0, value: 7 },
  };
  function addWorkItem(node: NodeLike | NodeLike[]): void {
    if (Array.isArray(node)) {
      arrayCalls++;
      for (const child of node) gathered.push(child);
    } else {
      scalarCalls++;
      gathered.push(node);
    }
  }
  forEachChild(root, addWorkItem, addWorkItem);
  return arrayCalls * 1000 + scalarCalls * 100 + gathered[0].value;
}
`,
        "./main.ts": `
import { test as visitTest } from "./visitor.js";
export function test(): number { return visitTest(); }
`,
      },
      "./main.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as { test(): number };
    expect(exports.test()).toBe(1107);
  });

  it("registers a later source file's concrete callback return ABI", async () => {
    const result = await compileMulti(
      {
        "./warm.ts": `
export function invokeWarm<T>(callback: (value: number) => T): T {
  return callback(1);
}

export function warm(): number {
  return invokeWarm(value => value + 1);
}
`,
        "./callback.ts": `
export interface Box {
  value: number;
}

export function invokeLater<T>(callback: (value: number) => T): T {
  return callback(7);
}

function makeBoxes(value: number): Box[] {
  return [{ value }];
}

export function callbackResult(): number {
  return invokeLater(makeBoxes)[0].value;
}

export function visitBoxes<T>(callback: (values: Box[]) => T | undefined, values: Box[]): T | undefined {
  return callback(values);
}

export function capturedResult(): number {
  let count = 0;
  function addWorkItem(_value: Box | Box[]): void {
    count += 3;
  }
  visitBoxes(addWorkItem, [{ value: 1 }]);
  return count;
}

export function reduceTwice<T, U>(
  callback: (pos: number, end: number, kind: number, trailing: boolean, state: T, accumulator: U) => U,
  state: T,
  initial: U,
): U {
  let accumulator = callback(0, 1, 2, false, state, initial);
  accumulator = callback(1, 2, 3, true, state, accumulator);
  return accumulator;
}

function appendRange(
  _pos: number,
  end: number,
  _kind: number,
  _trailing: boolean,
  _state: unknown,
  ranges: Box[] = [],
): Box[] {
  ranges.push({ value: end });
  return ranges;
}

export function reducerResult(): number {
  return (reduceTwice(appendRange, undefined, undefined) as Box[]).length;
}
`,
        "./main.ts": `
import "./warm.js";
import { callbackResult, capturedResult, reducerResult } from "./callback.js";

export function callbackOnly(): number { return callbackResult(); }
export function capturedOnly(): number { return capturedResult(); }
export function reducerOnly(): number { return reducerResult(); }

export function test(): number {
  return callbackResult() * 10000 + capturedResult() * 100 + reducerResult();
}
`,
      },
      "./main.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as {
      callbackOnly(): number;
      capturedOnly(): number;
      reducerOnly(): number;
      test(): number;
    };
    let callbackValue: number;
    let capturedValue: number;
    let reducerValue: number;
    try {
      callbackValue = exports.callbackOnly();
    } catch (error) {
      throw new Error(`callbackOnly trapped: ${String(error)}`);
    }
    try {
      capturedValue = exports.capturedOnly();
    } catch (error) {
      throw new Error(`capturedOnly trapped: ${String(error)}`);
    }
    try {
      reducerValue = exports.reducerOnly();
    } catch (error) {
      throw new Error(`reducerOnly trapped: ${String(error)}`);
    }
    expect(callbackValue).toBe(7);
    expect(capturedValue).toBe(3);
    expect(reducerValue).toBe(2);
    expect(exports.test()).toBe(70302);
  });

  it("registers a later captured callback with an optional externref parameter", async () => {
    const result = await compileMulti(
      {
        "./dispatcher.ts": `
export function invoke<T>(callback: () => T): T {
  return callback();
}
`,
        "./parser.ts": `
import { invoke } from "./dispatcher.js";

type DiagnosticMessage = object;

interface NodeLike {
  kind: number;
}

function warmSharedWrapper(message: DiagnosticMessage): number {
  // A required-parameter sibling shares parseNode's lowered wrapper ABI. Its
  // capture-free registration must not erase the optional-arity fact that was
  // discovered for the later captured/constructible subtype.
  const strictNode = (message: DiagnosticMessage): NodeLike => {
    return { kind: message === undefined ? -1 : 7 };
  };
  return strictNode(message).kind;
}

function invokeAfterWarm<T>(callback: () => T): T {
  return callback();
}

export function parse(): number {
  let optionalWasUndefined = false;

  function parseNode(message?: DiagnosticMessage): NodeLike {
    optionalWasUndefined = message === undefined;
    return { kind: 42 };
  }

  if (warmSharedWrapper({}) !== 7) return -1;
  // Keep the cross-file registration witness and add the production ordering:
  // parseModuleExportName's dynamic call compiles after many sibling closures.
  if (invoke(() => 1) !== 1) return -2;
  const node = invokeAfterWarm(parseNode);
  return (optionalWasUndefined ? 100 : 0) + node.kind;
}
`,
        "./main.ts": `
import { parse } from "./parser.js";

export function test(): number {
  return parse();
}
`,
      },
      "./main.ts",
      { target: "gc", platform: "node", skipSemanticDiagnostics: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as unknown as { test(): number };
    expect(exports.test()).toBe(142);
  });
});
