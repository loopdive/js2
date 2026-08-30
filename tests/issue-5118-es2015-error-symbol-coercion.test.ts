// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));
const EXACT_ROWS = [
  "built-ins/Error/error-message-tostring-symbol.js",
  "built-ins/Error/prototype/toString/tostring-message-throws-symbol.js",
  "built-ins/NativeErrors/nativeerror-tostring-message-throws-symbol.js",
] as const;
const CORPUS_AVAILABLE = EXACT_ROWS.every((row) => existsSync(join(TEST262_ROOT, "test", row)));

const CONTROL_SOURCE = `
let trace = 0;

function makeDynamicError(message: any): any {
  return Error(message);
}

export function staticConstructorSymbol(): number {
  trace = 0;
  try {
    new Error((trace += 1, Symbol()));
  } catch (error) {
    return error instanceof TypeError && trace === 1 ? 1 : 0;
  }
  return 0;
}

export function dynamicConstructorSymbol(): number {
  trace = 0;
  const message: any = Symbol();
  try {
    new Error(message);
  } catch (error) {
    return error instanceof TypeError && trace === 0 ? 1 : 0;
  }
  return 0;
}

export function dynamicCalleeBeforeCaller(): number {
  try {
    makeDynamicError(Symbol());
  } catch (error) {
    return error instanceof TypeError ? 1 : 0;
  }
  return 0;
}

export function laterArgumentWins(): number {
  trace = 0;
  function symbolMessage(): symbol {
    trace = trace * 10 + 1;
    return Symbol();
  }
  function abruptLater(): any {
    trace = trace * 10 + 2;
    throw new Error("later");
  }
  try {
    new Error(symbolMessage(), abruptLater());
  } catch (error) {
    return error instanceof Error && !(error instanceof TypeError) && trace === 12 ? 1 : 0;
  }
  return 0;
}

export function dynamicConstructorLaterArgumentWins(): number {
  trace = 0;
  const dynamicMessage: any = Symbol();
  function readMessage(): any {
    trace = trace * 10 + 1;
    return dynamicMessage;
  }
  function abruptLater(): any {
    trace = trace * 10 + 2;
    throw new Error("later");
  }
  try {
    new Error(readMessage(), abruptLater());
  } catch (error) {
    return error instanceof Error && !(error instanceof TypeError) && trace === 12 ? 1 : 0;
  }
  return 0;
}

export function dynamicCallLaterArgumentWins(): number {
  trace = 0;
  const dynamicMessage: any = Symbol();
  function readMessage(): any {
    trace = trace * 10 + 1;
    return dynamicMessage;
  }
  function abruptLater(): any {
    trace = trace * 10 + 2;
    throw new Error("later");
  }
  try {
    Error(readMessage(), abruptLater());
  } catch (error) {
    return error instanceof Error && !(error instanceof TypeError) && trace === 12 ? 1 : 0;
  }
  return 0;
}

export function positiveMessages(): number {
  const withString: any = new Error("ok");
  const withUndefined: any = new Error(undefined);
  return withString.message === "ok" && String(withUndefined) === "Error" ? 1 : 0;
}

export function prototypeSymbol(): number {
  try {
    Error.prototype.toString.call({ message: Symbol() });
  } catch (error) {
    return error instanceof TypeError ? 1 : 0;
  }
  return 0;
}

export function prototypeDynamicSymbol(): number {
  const message: any = Symbol();
  const value: any = { message };
  try {
    Error.prototype.toString.call(value);
  } catch (error) {
    return error instanceof TypeError ? 1 : 0;
  }
  return 0;
}

export function prototypePrimitiveReceiver(): number {
  try {
    Error.prototype.toString.call(null);
  } catch (error) {
    return error instanceof TypeError ? 1 : 0;
  }
  return 0;
}

export function prototypePrimitiveReceivers(): number {
  const numberReceiver: any = 1;
  const stringReceiver: any = "x";
  const booleanReceiver: any = true;
  const symbolReceiver: any = Symbol();
  try {
    Error.prototype.toString.call(numberReceiver);
    return 0;
  } catch (error) {
    if (!(error instanceof TypeError)) return 0;
  }
  try {
    Error.prototype.toString.call(stringReceiver);
    return 0;
  } catch (error) {
    if (!(error instanceof TypeError)) return 0;
  }
  try {
    Error.prototype.toString.call(booleanReceiver);
    return 0;
  } catch (error) {
    if (!(error instanceof TypeError)) return 0;
  }
  try {
    Error.prototype.toString.call(symbolReceiver);
    return 0;
  } catch (error) {
    return error instanceof TypeError ? 1 : 0;
  }
}

export function prototypeOrder(): number {
  trace = 0;
  const value: any = {
    get name() {
      trace = trace * 10 + 1;
      return "N";
    },
    get message() {
      trace = trace * 10 + 2;
      return Symbol();
    },
  };
  try {
    Error.prototype.toString.call(value);
  } catch (error) {
    return error instanceof TypeError && trace === 12 ? 1 : 0;
  }
  return 0;
}

export function prototypeNameSymbolOrder(): number {
  trace = 0;
  const value: any = {
    get name() {
      trace = 1;
      return Symbol();
    },
    get message() {
      trace = 2;
      return "M";
    },
  };
  try {
    Error.prototype.toString.call(value);
  } catch (error) {
    return error instanceof TypeError && trace === 1 ? 1 : 0;
  }
  return 0;
}

export function prototypeValues(): number {
  const ordinary: any = { name: "N", message: "M" };
  const emptyName: any = { name: "", message: "M" };
  const emptyMessage: any = { name: "N", message: "" };
  const bothEmpty: any = { name: "", message: "" };
  const ordinaryObjects: any = { name: {}, message: {} };
  const callable: any = () => {};
  const array: any = [];
  const inherited: any = Object.create({ message: "M" });
  inherited.name = "N";
  const nativeError: any = new TypeError("M");
  return (
    Error.prototype.toString.call(ordinary) === "N: M" &&
    Error.prototype.toString.call(emptyName) === "M" &&
    Error.prototype.toString.call(emptyMessage) === "N" &&
    Error.prototype.toString.call(bothEmpty) === "" &&
    Error.prototype.toString.call(inherited) === "N: M" &&
    Error.prototype.toString.call(ordinaryObjects) === "[object Object]: [object Object]" &&
    Error.prototype.toString.call(callable) === "callable" &&
    Error.prototype.toString.call(array) === "Error" &&
    TypeError.prototype.toString.call(nativeError) === "TypeError: M"
  )
    ? 1
    : 0;
}
`;

const HOST_CONTROL_SOURCE = `
let trace = 0;

export function newLaterArgumentWins(): number {
  trace = 0;
  const message: any = Symbol();
  function readMessage(): any {
    trace = trace * 10 + 1;
    return message;
  }
  function abruptLater(): any {
    trace = trace * 10 + 2;
    throw new Error("later");
  }
  try {
    new Error(readMessage(), abruptLater());
  } catch (error) {
    return error instanceof Error && !(error instanceof TypeError) && trace === 12 ? 1 : 0;
  }
  return 0;
}

export function callLaterArgumentWins(): number {
  trace = 0;
  const message: any = Symbol();
  function readMessage(): any {
    trace = trace * 10 + 1;
    return message;
  }
  function abruptLater(): any {
    trace = trace * 10 + 2;
    throw new Error("later");
  }
  try {
    Error(readMessage(), abruptLater());
  } catch (error) {
    return error instanceof Error && !(error instanceof TypeError) && trace === 12 ? 1 : 0;
  }
  return 0;
}

export function positiveMessage(): number {
  const error: any = new Error("ok");
  return error.message === "ok" ? 1 : 0;
}
`;

type Controls = {
  exports: Record<string, () => unknown>;
  imports: WebAssembly.ModuleImportDescriptor[];
};

let standaloneControlsPromise: Promise<Controls> | undefined;
let hostControlsPromise: Promise<Controls> | undefined;

async function compileControls(source: string, target: "standalone" | undefined, fileName: string): Promise<Controls> {
  const result = await compile(source, {
    fileName,
    ...(target === undefined ? {} : { target }),
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  expect(result.binary?.length).toBeGreaterThan(0);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  result.importObject?.__setExports?.(instance.exports);
  return { exports: wrapExports(instance.exports, { signatures: result.exportSignatures }), imports };
}

async function compileHostControls(): Promise<Controls> {
  return compileControls(HOST_CONTROL_SOURCE, undefined, "issue-5118-host-controls.ts");
}

function runStandaloneControls(): Promise<Controls> {
  standaloneControlsPromise ??= compileControls(CONTROL_SOURCE, "standalone", "issue-5118-controls.ts");
  return standaloneControlsPromise;
}

function runHostControls(): Promise<Controls> {
  hostControlsPromise ??= compileHostControls();
  return hostControlsPromise;
}

describe("#5118 — standalone Error ToString(Symbol) coercion", () => {
  it("keeps the standalone compiler host-free", async () => {
    const { imports } = await runStandaloneControls();
    expect(imports).toEqual([]);
  }, 180_000);

  it("throws the real TypeError after evaluating a static Symbol message", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.staticConstructorSymbol()).toBe(1);
  }, 180_000);

  it("throws the real TypeError for a dynamic Symbol carrier", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.dynamicConstructorSymbol()).toBe(1);
  }, 180_000);

  it("keeps the dynamic Symbol guard when the Error callee compiles first", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.dynamicCalleeBeforeCaller()).toBe(1);
  }, 180_000);

  it("evaluates later constructor arguments before the Symbol ToString throw", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.laterArgumentWins()).toBe(1);
  }, 180_000);

  it("evaluates later arguments after a dynamic first message for new Error", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.dynamicConstructorLaterArgumentWins()).toBe(1);
  }, 180_000);

  it("evaluates later arguments after a dynamic first message for Error calls", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.dynamicCallLaterArgumentWins()).toBe(1);
  }, 180_000);

  it("preserves ordinary string and undefined Error messages", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.positiveMessages()).toBe(1);
  }, 180_000);

  it("throws TypeError for a Symbol message through Error.prototype.toString", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.prototypeSymbol()).toBe(1);
  }, 180_000);

  it("rejects a dynamic Symbol carrier after the object receiver check", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.prototypeDynamicSymbol()).toBe(1);
  }, 180_000);

  it("applies the full object receiver check to Error.prototype.toString", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.prototypePrimitiveReceiver()).toBe(1);
  }, 180_000);

  it("rejects every primitive Error.prototype.toString receiver", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.prototypePrimitiveReceivers()).toBe(1);
  }, 180_000);

  it("keeps name Get/ToString before message Get/ToString", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.prototypeOrder()).toBe(1);
  }, 180_000);

  it("throws from name ToString before reading message", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.prototypeNameSymbolOrder()).toBe(1);
  }, 180_000);

  it("preserves positive, empty, inherited, and NativeError prototype behavior", async () => {
    const { exports } = await runStandaloneControls();
    expect(exports.prototypeValues()).toBe(1);
  }, 180_000);
});

describe("#5118 — host Error constructor argument evaluation", () => {
  it("evaluates later arguments before host Error constructor coercion", async () => {
    const { exports } = await runHostControls();
    expect(exports.newLaterArgumentWins()).toBe(1);
    expect(exports.callLaterArgumentWins()).toBe(1);
  }, 180_000);

  it("preserves ordinary host Error messages", async () => {
    const { exports } = await runHostControls();
    expect(exports.positiveMessage()).toBe(1);
  }, 180_000);
});

describe.skipIf(!CORPUS_AVAILABLE)("#5118 — exact Test262 corpus rows", () => {
  it.each(EXACT_ROWS)(
    "passes %s in the host lane",
    async (row) => {
      const result = await runTest262File(join(TEST262_ROOT, "test", row), "issue-5118-host", 180_000);
      expect(result.status).toBe("pass");
    },
    200_000,
  );

  it.each(EXACT_ROWS)(
    "passes %s in standalone",
    async (row) => {
      const result = await runTest262File(
        join(TEST262_ROOT, "test", row),
        "issue-5118-standalone",
        180_000,
        "standalone",
      );
      expect(result.status).toBe("pass");
    },
    200_000,
  );
});
