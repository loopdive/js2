// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

const SOURCE = `
var result: number = 0;
var trace: number = 0;
function subject(): number { return 0; }
function argument(): number { trace = trace * 10 + 2; return 41; }
function member(this: any, value: number): void {
  trace = trace * 10 + 3;
  result = this === subject ? value + 1 : -100;
}
subject.method = member;
subject.argument = argument;
subject.notCallable = 17;
Object.defineProperty(subject, "ordered", { get: function() {
  trace = trace * 10 + 1; return member;
}});
Object.defineProperty(subject, "throwing", { get: function() {
  trace = trace * 10 + 1; throw 7;
}});
// These units own every Get, argument expression and call/throw step. The
// direct wrappers only reset/read shared storage or verify a caught error.
export function invokeMember(): void { subject.method(41); }
export function orderedMember(): void { subject.ordered(subject.argument()); }
export function getterThrowMember(): void { subject.throwing(subject.argument()); }
export function nonCallableMember(): void { subject.notCallable(subject.argument()); }
export function invoke(): void { result = 0; trace = 0; invokeMember(); }
export function ordered(): void { result = 0; trace = 0; orderedMember(); }
export function getterThrows(): void {
  trace = 0; result = 0;
  try { getterThrowMember(); } catch { result = trace; }
}
export function nonCallable(): void {
  trace = 0; result = 0;
  try { nonCallableMember(); } catch (error) {
    result = error instanceof TypeError ? trace : -1;
  }
}
export function install(): void { subject.value = 41; }
// General function-as-value remains outside this slice. This body therefore
// stays direct and observes the very same cached object written by IR.
export function legacyRead(): number { return subject.value; }
export function readResult(): number { return result; }
export function readTrace(): number { return trace; }
export function shadowed(): number {
  const subject = { method(value: number): number { return value + 3; } };
  return subject.method(39);
}
`;

let compiled: CompileResult;
let exports: Record<string, (...args: number[]) => number>;

function requireEmitted(name: string): void {
  const outcome = compiled.irOutcomes?.find((entry) => entry.displayName === name);
  expect(outcome, JSON.stringify(compiled.irOutcomes)).toMatchObject({
    kind: "emitted",
    irBodyEmitted: true,
    legacyBodyEmitted: false,
    directBodyEmissions: 0,
    preparedComponentId: expect.any(String),
  });
  expect(outcome).not.toHaveProperty("r2Withdrawal");
}

describe("#7106 stage 2 canonical function-object receivers", () => {
  beforeAll(async () => {
    compiled = await compile(SOURCE, {
      target: "standalone",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
    });
    expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(compiled.binary))).toEqual([]);
    const { instance } = await WebAssembly.instantiate(compiled.binary, {});
    expect(typeof instance.exports.__module_init).toBe("function");
    (instance.exports.__module_init as () => void)();
    exports = instance.exports as typeof exports;
  }, 35_000);

  it("uses the legacy-installed property and the original receiver", () => {
    requireEmitted("invokeMember");
    exports.invoke!();
    expect(exports.readResult!()).toBe(42);
    expect(exports.readTrace!()).toBe(3);
  });

  it("gets a callable once before evaluating arguments", () => {
    requireEmitted("orderedMember");
    exports.ordered!();
    expect(exports.readTrace!()).toBe(123);
    expect(exports.readResult!()).toBe(42);
  });

  it("propagates a getter throw before argument side effects", () => {
    requireEmitted("getterThrowMember");
    exports.getterThrows!();
    expect(exports.readTrace!()).toBe(1);
    expect(exports.readResult!()).toBe(1);
  });

  it("throws a real TypeError for a noncallable after argument evaluation", () => {
    requireEmitted("nonCallableMember");
    exports.nonCallable!();
    expect(exports.readTrace!()).toBe(2);
    expect(exports.readResult!()).toBe(2);
  });

  it("shares property identity between an IR writer and a direct reader", () => {
    requireEmitted("install");
    exports.install!();
    expect(exports.legacyRead!()).toBe(41);
  });

  it("does not capture a same-named local as the top-level function", () => {
    requireEmitted("shadowed");
    expect(exports.shadowed!()).toBe(42);
  });
});

describe("#7106 stage 2 mutable binding refusal", () => {
  it("does not substitute the original singleton after binding reassignment", async () => {
    const result = await compile(
      `
      function changed(): number { return 1; }
      changed = function(): number { return 2; };
      changed.method = function(): number { return 42; };
      export function run(): number { return changed.method(); }
    `,
      { target: "standalone", skipSemanticDiagnostics: true, trackIrOutcomes: true, deferTopLevelInit: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "run")?.irBodyEmitted).not.toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect(typeof instance.exports.__module_init).toBe("function");
    (instance.exports.__module_init as () => void)();
    expect((instance.exports.run as () => number)()).toBe(42);
  }, 35_000);
});
