// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type IrObservedOutcome, type IrUnsupportedCode } from "../src/index.js";
import type { IrClassShape } from "../src/ir/nodes.js";
import { classifyIrFailure, evaluateIrOutcomePolicy } from "../src/ir/outcomes.js";
import { planIrCompilation } from "../src/ir/select.js";
import { ts } from "../src/ts-api.js";
import { createTestIrClassId } from "./helpers/ir-identities.js";

type DirectSelectionOptions = NonNullable<Parameters<typeof planIrCompilation>[1]>;

function outcomes(result: Awaited<ReturnType<typeof compile>>): readonly IrObservedOutcome[] {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irOutcomes).toBeDefined();
  return result.irOutcomes ?? [];
}

function expectSelectUnsupported(
  observed: readonly IrObservedOutcome[],
  displayName: string,
  code: IrUnsupportedCode,
): void {
  const outcome = observed.find((entry) => entry.displayName === displayName);
  expect(outcome).toMatchObject({
    kind: "unsupported",
    stage: "select",
    code,
    legacyBodyEmitted: true,
    irBodyEmitted: false,
  });
  expect(outcome && evaluateIrOutcomePolicy([outcome], "hybrid").ready).toBe(true);
  expect(outcome && evaluateIrOutcomePolicy([outcome], "ir-only").ready).toBe(false);
}

function directSelection(source: string, options: DirectSelectionOptions = {}) {
  const sourceFile = ts.createSourceFile("selector-direct.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return planIrCompilation(sourceFile, {
    experimentalIR: true,
    trackFallbacks: true,
    ...options,
  });
}

function directFallbackReason(source: string, name: string = "test", options: DirectSelectionOptions = {}) {
  return directSelection(source, options).fallbacks?.find((fallback) => fallback.name === name)?.reason;
}

const PRECLAIM_CASES: ReadonlyArray<{
  readonly name: string;
  readonly code: IrUnsupportedCode;
  readonly source: string;
}> = [
  {
    name: "ambient String method",
    code: "string-method-unsupported",
    source: `export function test(): string { return "x".repeat(2); }`,
  },
  {
    name: "ambient Array method",
    code: "array-method-unsupported",
    source: `export function test(): number { const values = [1, 2]; return values.indexOf(2); }`,
  },
  {
    name: "numeric primitive method",
    code: "primitive-method-unsupported",
    source: `export function test(): number { return (1).valueOf(); }`,
  },
  {
    name: "Function.call",
    code: "function-invocation-method-unsupported",
    source: `export function test(): number {
      const inc = (value: number): number => value + 1;
      return inc.call(undefined, 1);
    }`,
  },
  {
    name: "logical value result",
    code: "logical-value-unsupported",
    source: `export function test(): number { return 0 || 42; }`,
  },
  {
    name: "template coercion",
    code: "template-substitution-unsupported",
    // #4467 adopted NUMERIC substitutions and #4503 adopted BOOLEAN ones, so
    // this case now uses an ARRAY substitution — deliberately still rejecting
    // (`${xs}` needs Array.prototype.join/toString semantics, which the IR
    // does not lower; the vec param itself claims fine).
    source: "export function test(xs: number[]): string { return `xs=${xs}`; }",
  },
  {
    name: "ambient Error constructor",
    code: "error-constructor-unsupported",
    source: `export function test(): number { const error = new TypeError("bad"); return error.message.length; }`,
  },
  {
    name: "ambient TypedArray constructor",
    code: "typed-array-constructor-unsupported",
    source: `export function test(): number { const values = new Uint8Array(1); return values.length; }`,
  },
  {
    name: "direct call arity",
    code: "call-arity-unsupported",
    source: `function add(a: number, b: number): number { return a + b; }
      export function test(): number { return add(1); }`,
  },
  {
    name: "constructor arity",
    code: "constructor-arity-unsupported",
    source: `class Pair {
      a: number;
      b: number;
      constructor(a: number, b: number) { this.a = a; this.b = b; }
    }
    export function test(): number { const pair = new Pair(1); return pair.a; }`,
  },
  {
    name: "computed class member",
    code: "class-member-unsupported",
    source: `class Greeter { ["value"](): number { return 42; } }
      export function test(): number { const greeter = new Greeter(); return greeter.value(); }`,
  },
  {
    name: "nested forward call",
    code: "call-resolution-unsupported",
    source: `export function test(): number {
      function first(value: number): number { return second(value); }
      function second(value: number): number { return value + 1; }
      return first(1);
    }`,
  },
];

// (#4448) The self-recursive `Builder` shape below used to sit in
// PRECLAIM_CASES as a `class-projection-unsupported` rejection. `6203320a`
// (feat(ir): prepare recursive class layouts) preallocates the shape cell for a
// class whose own method constructs it, so the shape is now claimed and
// emitted. The expectation moved here rather than being relabelled: the case is
// pinned by EXECUTING the module, so "supported" is backed by the answer and
// not only by an outcome tag.
const RECURSIVE_CLASS_SOURCE = `class Builder {
      value: number;
      constructor(value: number) { this.value = value; }
      add(value: number): Builder { return new Builder(this.value + value); }
    }
    export function test(): number { return new Builder(1).add(2).value; }`;

describe("#3529 selector preclaim capability parity", () => {
  it("keeps checker-proven computed numbers on the supported toString path", async () => {
    const result = await compile(`export function test(): string { return Math.pow(2, 10).toString(); }`, {
      fileName: "computed-number-tostring.ts",
      trackIrOutcomes: true,
    });
    expect(outcomes(result).find((outcome) => outcome.displayName === "test")).toMatchObject({
      kind: "emitted",
      stage: "patch",
      irBodyEmitted: true,
    });
  });

  it.each(PRECLAIM_CASES)("types $name before AST-to-IR build", async ({ code, source }) => {
    const result = await compile(source, { fileName: `${code}.ts`, trackIrOutcomes: true });
    expectSelectUnsupported(outcomes(result), "test", code);
  });

  it("emits a self-recursive class shape and computes its answer (#4448)", async () => {
    const result = await compile(RECURSIVE_CLASS_SOURCE, {
      fileName: "recursive-class-shape.ts",
      trackIrOutcomes: true,
    });
    expect(outcomes(result).find((entry) => entry.displayName === "test")).toMatchObject({
      kind: "emitted",
      stage: "patch",
      irBodyEmitted: true,
      legacyBodyEmitted: false,
    });
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    expect((instance.exports.test as () => number)()).toBe(3);
  });

  it("uses the Date backend-capability seam on host-free targets", async () => {
    const sourceFile = ts.createSourceFile(
      "date-capability-direct.ts",
      `export function test(): number { const date = new Date(); return date.getFullYear(); }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const selection = planIrCompilation(sourceFile, {
      experimentalIR: true,
      trackFallbacks: true,
      isAmbientBinding: (node) => node.text === "Date",
      hostDateSnapshots: (expression) => ({ expression, getterCalls: new Set() }),
      supportsBackendCapability: () => false,
    });
    expect(selection.fallbacks?.find((fallback) => fallback.name === "test")?.reason).toBe(
      "date-constructor-unsupported",
    );

    const result = await compile(`export function test(): number { const date = new Date(); return date.getTime(); }`, {
      fileName: "date-capability.ts",
      target: "standalone",
      trackIrOutcomes: true,
    });
    expectSelectUnsupported(outcomes(result), "test", "date-constructor-unsupported");
  });

  it("keeps same-named user classes and methods IR-claimable", async () => {
    const result = await compile(
      `class Custom {
        trim(): number { return 1; }
        map(): number { return 2; }
        call(): number { return 3; }
        apply(): number { return 4; }
      }
      export function canary(): number {
        const custom = new Custom();
        return custom.trim() + custom.map() + custom.call() + custom.apply();
      }`,
      { fileName: "shadow-canary.ts", trackIrOutcomes: true },
    );
    expect(outcomes(result).find((entry) => entry.displayName === "canary")).toMatchObject({
      kind: "emitted",
      stage: "patch",
      irBodyEmitted: true,
    });
  });

  it.each([
    {
      name: "local class",
      source: `class Box {}
        export function test(): number {
          const box = new Box();
          return (box && true) ? 1 : 0;
        }`,
    },
    {
      name: "object",
      source: `export function test(): number {
        const value = { answer: 1 };
        return (value || false) ? 1 : 0;
      }`,
    },
    {
      name: "array",
      source: `export function test(): number {
        const values = [1];
        return (values && true) ? 1 : 0;
      }`,
    },
  ])("requires boolean evidence for a $name logical operand", async ({ name, source }) => {
    if (name === "local class") expect(directFallbackReason(source)).toBe("logical-value-unsupported");
    const result = await compile(source, {
      fileName: `logical-${name.replaceAll(" ", "-")}.ts`,
      trackIrOutcomes: true,
    });
    expectSelectUnsupported(outcomes(result), "test", "logical-value-unsupported");
  });

  it("preserves an exact boolean logical expression", async () => {
    const result = await compile(
      `export function test(flag: boolean): number {
      return (flag && true) ? 1 : 0;
    }`,
      { fileName: "logical-boolean.ts", trackIrOutcomes: true },
    );
    expect(outcomes(result).find((entry) => entry.displayName === "test")).toMatchObject({
      kind: "emitted",
      stage: "patch",
      irBodyEmitted: true,
    });
  });

  it.each([
    {
      name: "local class",
      source: "class Box {} export function test(): string { const box = new Box(); return `box=${box}`; }",
    },
    {
      name: "object",
      source: "export function test(): string { const value = { answer: 1 }; return `value=${value}`; }",
    },
    {
      name: "array",
      source: "export function test(): string { const values = [1]; return `values=${values}`; }",
    },
  ])("requires string evidence for a $name template substitution", async ({ name, source }) => {
    if (name === "local class") expect(directFallbackReason(source)).toBe("template-substitution-unsupported");
    const result = await compile(source, {
      fileName: `template-${name.replaceAll(" ", "-")}.ts`,
      trackIrOutcomes: true,
    });
    expectSelectUnsupported(outcomes(result), "test", "template-substitution-unsupported");
  });

  it("preserves an exact string template substitution", async () => {
    const result = await compile("export function test(value: string): string { return `value=${value}`; }", {
      fileName: "template-string.ts",
      trackIrOutcomes: true,
    });
    expect(outcomes(result).find((entry) => entry.displayName === "test")).toMatchObject({
      kind: "emitted",
      stage: "patch",
      irBodyEmitted: true,
    });
  });

  it.each([
    {
      name: "sibling branch",
      source: `export function test(flag: boolean): number {
        if (flag) {
          const leaked = (value: number): number => value;
          leaked(1);
        } else {
          const leaked = 1;
          leaked();
        }
        return 0;
      }`,
    },
    {
      name: "nested block",
      source: `export function test(outer: boolean, inner: boolean): number {
        if (outer) {
          if (inner) {
            const leaked = (value: number): number => value;
            leaked(1);
          }
          if (inner) {
            const leaked = 1;
            leaked();
          }
        }
        return 0;
      }`,
    },
  ])("does not leak callable evidence across a $name boundary", ({ source }) => {
    expect(directFallbackReason(source)).toBe("call-resolution-unsupported");
  });

  it.each([
    {
      name: "branch",
      mutation: `if (flag) { x = new B(); }`,
    },
    {
      name: "nested block",
      mutation: `if (flag) { { x = new B(); } }`,
    },
    {
      name: "loop",
      mutation: `while (flag) { x = new B(); break; }`,
    },
  ])("rejects a projected class binding mutation across a $name join", async ({ name, mutation }) => {
    const source = `class A { a(): number { return 1; } }
      class B { a(): number { return 2; } }
      export function test(flag: boolean): number {
        let x = new A();
        ${mutation}
        return x.a();
      }`;
    expect(directFallbackReason(source)).toBe("body-shape-rejected");
    const result = await compile(source, {
      fileName: `projection-${name.replaceAll(" ", "-")}-join.ts`,
      trackIrOutcomes: true,
    });
    expectSelectUnsupported(outcomes(result), "test", "body-shape-rejected");
  });

  it("restores projection evidence after a checker-certified callback body", () => {
    const source = `export function test(target: {}): number {
      target.addEventListener("tick", () => {
        const leaked = (value: number): number => value;
        leaked(1);
      });
      const leaked = 1;
      return leaked();
    }`;
    const selection = directSelection(source, {
      hostVoidCallbacks: (call) => {
        const argument = call.arguments[1];
        if (!argument || !ts.isArrowFunction(argument) || !ts.isBlock(argument.body)) return undefined;
        return {
          call,
          callback: argument as ts.ArrowFunction & { readonly body: ts.Block },
          captureNames: new Set(),
        };
      },
    });
    expect(selection.fallbacks?.find((fallback) => fallback.name === "test")?.reason).toBe(
      "call-resolution-unsupported",
    );
  });

  it.each([
    {
      name: "parameter",
      source: `function target(left: number, right: number): number { return left + right; }
        export function test(target: number): number { return target(1); }`,
    },
    {
      name: "local variable",
      source: `function target(left: number, right: number): number { return left + right; }
        export function test(): number { const target = 1; return target(1); }`,
    },
    {
      name: "call-return class",
      source: `class Box { value: number; constructor(value: number) { this.value = value; } }
        function make(): Box { return new Box(1); }
        export function test(make: number): number { return make().value; }`,
    },
  ])("does not fall through a $name shadow to top-level callable text", ({ source }) => {
    expect(directFallbackReason(source)).toBe("call-resolution-unsupported");
  });

  it.each([
    {
      name: "parameter",
      source: `class Box { value: number; constructor(value: number) { this.value = value; } }
        export function test(Box: number): number { const value = new Box(1); return 1; }`,
    },
    {
      name: "local variable",
      source: `class Box { value: number; constructor(value: number) { this.value = value; } }
        export function test(): number { const Box = 1; const value = new Box(1); return 1; }`,
    },
    {
      name: "hoisted nested function",
      source: `class Box { value: number; constructor(value: number) { this.value = value; } }
        export function test(): number {
          const value = new Box(1);
          function Box(input: number): number { return input; }
          return 1;
        }`,
    },
  ])("does not inherit local-class identity through a $name shadow", ({ source }) => {
    expect(directFallbackReason(source)).toBe("constructor-resolution-unsupported");
  });

  it.each([
    {
      name: "class value declaration",
      reason: "constructor-resolution-unsupported",
      source: `class Box { value: number; constructor(value: number) { this.value = value; } }
        export function test(): number {
          const value = new Box(1);
          const Box = 1;
          return value.value;
        }`,
    },
    {
      name: "callable value declaration",
      reason: "call-resolution-unsupported",
      source: `function target(left: number, right: number): number { return left + right; }
        export function test(): number {
          const value = target(1, 2);
          const target = (input: number): number => input;
          return value;
        }`,
    },
    {
      name: "binding-pattern declaration",
      reason: "constructor-resolution-unsupported",
      source: `class Box { value: number; constructor(value: number) { this.value = value; } }
        export function test(input: { Box: number }): number {
          const value = new Box(1);
          const { Box } = input;
          return value.value + Box;
        }`,
    },
  ] as const)("respects the TDZ of a later $name", ({ source, reason }) => {
    expect(directFallbackReason(source)).toBe(reason);
  });

  it("uses an exact missing class projection as an authoritative rejection", () => {
    const source = `class Exact { value: number; constructor(value: number) { this.value = value; } }
      export function test(): number { return new Exact(1).value; }`;
    expect(directFallbackReason(source, "test", { projectedClassShapes: new Map() })).toBe(
      "class-projection-unsupported",
    );
  });

  it("resolves inherited static methods through the class parent chain", () => {
    const selection = directSelection(`class Base { static value(input: number): number { return input; } }
      class Derived extends Base {}
      export function test(): number { return Derived.value(42); }`);
    expect(selection.funcs.has("test")).toBe(true);
  });

  it.each([
    {
      name: "instance then static",
      members: `value(): number { return 1; }
        static value(): number { return 2; }`,
    },
    {
      name: "static then instance",
      members: `static value(): number { return 2; }
        value(): number { return 1; }`,
    },
  ])("suppresses both sides of a $name method-name collision", async ({ name, members }) => {
    const source = `class Clash { ${members} }
      export function test(): number { return 0; }`;
    const selection = directSelection(source);
    expect(selection.classMembers?.has("Clash_value") ?? false).toBe(false);
    expect(selection.fallbacks?.find((fallback) => fallback.name === "Clash_value")?.reason).toBe(
      "class-member-unsupported",
    );

    const result = await compile(source, {
      fileName: `collision-${name.replaceAll(" ", "-")}.ts`,
      trackIrOutcomes: true,
    });
    expectSelectUnsupported(outcomes(result), "Clash_value", "class-member-unsupported");
  });

  it("requires an exact own class-member descriptor and kind", () => {
    const source = `class C { "m"(value: number): number { return value; } }`;
    const shape: IrClassShape = {
      classId: createTestIrClassId("issue-3529-selector-preclaim/own-member"),
      className: "C",
      fields: [],
      methods: [],
      constructorParams: [],
    };
    const selection = directSelection(source, { projectedClassShapes: new Map([["C", shape]]) });
    expect(selection.classMembers?.has("C_m") ?? false).toBe(false);
    expect(selection.fallbacks?.find((fallback) => fallback.name === "C_m")?.reason).toBe("class-member-unsupported");

    const wrongKindShape: IrClassShape = {
      ...shape,
      methods: [{ name: "m", params: [], returnType: null, memberKind: "static" }],
    };
    const wrongKindSelection = directSelection(`class C { m(): void {} }`, {
      projectedClassShapes: new Map([["C", wrongKindShape]]),
    });
    expect(wrongKindSelection.classMembers?.has("C_m") ?? false).toBe(false);
    expect(wrongKindSelection.fallbacks?.find((fallback) => fallback.name === "C_m")?.reason).toBe(
      "class-member-unsupported",
    );
  });

  it("propagates a static method's projected class return before a property read", async () => {
    const source = `class Box { get ["value"](): number { return 1; } }
      class Factory { static make(): Box { return new Box(); } }
      export function test(): number { return Factory.make().value; }`;
    expect(directFallbackReason(source)).toBe("class-member-unsupported");

    const boxShape: IrClassShape = {
      classId: createTestIrClassId("issue-3529-selector-preclaim/static-return-box"),
      className: "Box",
      fields: [],
      methods: [],
      constructorParams: [],
    };
    const factoryShape: IrClassShape = {
      classId: createTestIrClassId("issue-3529-selector-preclaim/static-return-factory"),
      className: "Factory",
      fields: [],
      methods: [
        {
          name: "make",
          params: [],
          returnType: { kind: "class", shape: boxShape },
          memberKind: "static",
        },
      ],
      constructorParams: [],
    };
    expect(
      directFallbackReason(source, "test", {
        projectedClassShapes: new Map([
          ["Box", boxShape],
          ["Factory", factoryShape],
        ]),
      }),
    ).toBe("class-member-unsupported");

    const result = await compile(source, { fileName: "static-class-return.ts", trackIrOutcomes: true });
    expectSelectUnsupported(outcomes(result), "test", "class-member-unsupported");
  });

  it("propagates projected field/getter class returns before a chained property read", () => {
    const source = `class Box { get ["value"](): number { return 1; } }
      class Holder { get child(): Box { return new Box(); } }
      export function test(): number { return new Holder().child.value; }`;
    expect(directFallbackReason(source)).toBe("class-member-unsupported");

    const boxShape: IrClassShape = {
      classId: createTestIrClassId("issue-3529-selector-preclaim/getter-return-box"),
      className: "Box",
      fields: [],
      methods: [],
      constructorParams: [],
    };
    const holderShape: IrClassShape = {
      classId: createTestIrClassId("issue-3529-selector-preclaim/getter-return-holder"),
      className: "Holder",
      fields: [],
      methods: [
        {
          name: "child",
          params: [],
          returnType: { kind: "class", shape: boxShape },
          memberKind: "getter",
        },
      ],
      constructorParams: [],
    };
    expect(
      directFallbackReason(source, "test", {
        projectedClassShapes: new Map([
          ["Box", boxShape],
          ["Holder", holderShape],
        ]),
      }),
    ).toBe("class-member-unsupported");
  });

  it("uses checker class-expression identity and keeps a conservative conditional fallback", () => {
    // (#4448) The seam is reached through an element access whose receiver the
    // body walk already accepts. This assertion was born red in #4430 against a
    // `const boxes = [new Box()]` local: an array-literal initializer is
    // rejected by the vardecl arm before any member arm runs, so the seam was
    // never consulted there (pinned separately below). A `Box[]` parameter
    // reaches it — the seam names the class, and its computed getter is then
    // the authoritative rejection.
    const seamSource = `class Box { get ["value"](): number { return 1; } }
      export function test(boxes: Box[]): number { return boxes[0].value; }`;
    expect(
      directFallbackReason(seamSource, "test", {
        resolveLocalClassExpression: (expression) => (ts.isElementAccessExpression(expression) ? "Box" : undefined),
      }),
    ).toBe("class-member-unsupported");
    // Without the seam there is no class identity for `boxes[0]`, so the
    // rejection above is attributable to the seam and not to the shape.
    expect(directFallbackReason(seamSource)).toBeUndefined();

    const conservativeSource = `class Box { get ["value"](): number { return 1; } }
      export function test(flag: boolean): number {
        const box = flag ? new Box() : new Box();
        return box.value;
      }`;
    expect(directFallbackReason(conservativeSource)).toBe("class-member-unsupported");
  });

  it("rejects an array-literal class binding at the vardecl arm, ahead of the identity seam (#4448)", () => {
    const source = `class Box { get ["value"](): number { return 1; } }
      export function test(): number {
        const boxes = [new Box()];
        return boxes[0].value;
      }`;
    const withSeam = directFallbackReason(source, "test", {
      resolveLocalClassExpression: (expression) => (ts.isElementAccessExpression(expression) ? "Box" : undefined),
    });
    // Identical with and without the seam: the array-literal initializer decides,
    // so the member (computed getter or plain field) is not what rejects here.
    expect(withSeam).toBe("body-shape-rejected");
    expect(directFallbackReason(source)).toBe("body-shape-rejected");
    const plainMemberSource = `class Box { value: number; constructor() { this.value = 1; } }
      export function test(): number {
        const boxes = [new Box()];
        return boxes[0].value;
      }`;
    expect(directFallbackReason(plainMemberSource)).toBe("body-shape-rejected");
  });

  it.each([
    {
      name: "absent property",
      source: `class Value {}
        export function test(): number { const value = new Value(); return value.missing; }`,
    },
    {
      name: "method as value",
      source: `class Value { amount(): number { return 1; } }
        export function test(): number { const value = new Value(); return value.amount; }`,
    },
    {
      name: "setter-only read",
      source: `class Value { set amount(value: number) {} }
        export function test(): number { const value = new Value(); return value.amount; }`,
    },
    {
      name: "computed accessor",
      source: `class Value {
          get ["amount"](): number { return 1; }
          set ["amount"](value: number) {}
        }
        export function test(): number { const value = new Value(); value.amount = 2; return value.amount; }`,
    },
  ])("rejects an unprojected $name before class lowering", ({ source }) => {
    expect(directFallbackReason(source)).toBe("class-member-unsupported");
  });

  it.each([
    {
      name: "field",
      source: `class Value { data: number | string; constructor() { this.data = 1; } }
        export function test(): number { const value = new Value(); return 1; }`,
    },
    {
      name: "constructor parameter",
      source: `class Value { data: number; constructor(input: number | string) { this.data = 1; } }
        export function test(): number { const value = new Value(1); return value.data; }`,
    },
    {
      name: "method parameter",
      source: `class Value { read(input: number | string): number { return 1; } }
        export function test(): number { const value = new Value(); return value.read(1); }`,
    },
    {
      name: "method return",
      source: `class Value { read(): number | string { return 1; } }
        export function test(): number { const value = new Value(); return 1; }`,
    },
  ])("rejects an unrepresentable class $name", ({ source }) => {
    expect(directFallbackReason(source)).toBe("class-projection-unsupported");
  });

  it("keeps a primitive static member claim independent of an instance-shape gap", () => {
    const selection = directSelection(`class Value {
      data: number | string;
      static answer(): number { return 42; }
    }`);
    expect(selection.classMembers?.has("Value_answer")).toBe(true);
  });

  it("preflights valid and invalid super constructor/method calls", () => {
    const valid = directSelection(`class Base {
      value: number;
      constructor(value: number) { this.value = value; }
      add(value: number): number { return this.value + value; }
    }
    class Child extends Base {
      constructor(value: number) { super(value); }
      twice(value: number): number { return super.add(value); }
    }`);
    expect(valid.classMembers?.has("Child_new")).toBe(true);
    expect(valid.classMembers?.has("Child_twice")).toBe(true);

    expect(
      directFallbackReason(
        `class Base { constructor(value: number) {} }
        class Child extends Base { constructor() { super(); } }`,
        "Child_new",
      ),
    ).toBe("constructor-arity-unsupported");
    expect(
      directFallbackReason(
        `class Base { add(value: number): number { return value; } }
        class Child extends Base { read(): number { return super.add(); } }`,
        "Child_read",
      ),
    ).toBe("call-arity-unsupported");
    expect(
      directFallbackReason(
        `class Base {}
        class Child extends Base { read(): number { return super.missing(); } }`,
        "Child_read",
      ),
    ).toBe("class-member-unsupported");
  });

  it("requires the local instanceof target to have a projected shape", async () => {
    const source = `class Good {}
      class Bad { data: number | string; constructor() { this.data = 1; } }
      export function test(): number {
        const value = new Good();
        return value instanceof Bad ? 1 : 0;
      }`;
    expect(directFallbackReason(source)).toBe("class-projection-unsupported");

    const goodShape: IrClassShape = {
      classId: createTestIrClassId("issue-3529-selector-preclaim/instanceof-good"),
      className: "Good",
      fields: [],
      methods: [],
      constructorParams: [],
    };
    expect(
      directFallbackReason(source, "test", {
        projectedClassShapes: new Map([["Good", goodShape]]),
      }),
    ).toBe("class-projection-unsupported");

    const result = await compile(source, { fileName: "instanceof-class-gap.ts", trackIrOutcomes: true });
    expectSelectUnsupported(outcomes(result), "test", "class-projection-unsupported");
  });

  it.each([
    {
      name: "function Error",
      source: `function Error(value: string): number { return value.length; }
        export function test(): number { const error = new Error("bad"); return 1; }`,
    },
    {
      name: "module Uint8Array variable",
      source: `const Uint8Array = 1;
        export function test(): number { const bytes = new Uint8Array(1); return 1; }`,
    },
    {
      name: "function Date",
      source: `function Date(): number { return 1; }
        export function test(): number { const date = new Date(); return 1; }`,
    },
  ])("requires positive ambient identity for a $name shadow", ({ source }) => {
    expect(directFallbackReason(source, "test", { isAmbientBinding: () => false })).toBe(
      "constructor-resolution-unsupported",
    );
  });

  it("accepts certified Date snapshots when capability is absent or true", () => {
    const source = `export function test(): number { const date = new Date(); return date.getFullYear(); }`;
    for (const supportsBackendCapability of [undefined, () => true] as const) {
      const selection = directSelection(source, {
        isAmbientBinding: (node) => node.text === "Date",
        hostDateSnapshots: (expression) => ({ expression, getterCalls: new Set() }),
        ...(supportsBackendCapability ? { supportsBackendCapability } : {}),
      });
      expect(selection.funcs.has("test")).toBe(true);
    }
  });

  it("rejects a shadowed Date before consulting its snapshot certificate", () => {
    const source = `export function test(Date: number): number { const date = new Date(); return 1; }`;
    expect(
      directFallbackReason(source, "test", {
        isAmbientBinding: () => false,
        hostDateSnapshots: (expression) => ({ expression, getterCalls: new Set() }),
        supportsBackendCapability: () => true,
      }),
    ).toBe("constructor-resolution-unsupported");
  });

  it("types an unknown constructor as a direct resolution failure", () => {
    expect(directFallbackReason(`export function test(): number { const value = new Missing(); return 1; }`)).toBe(
      "constructor-resolution-unsupported",
    );
  });

  it("uses declaration identity rather than builtin constructor names", () => {
    const sourceFile = ts.createSourceFile(
      "constructor-shadows.ts",
      `class Error { value: number; constructor(value: number) { this.value = value; } }
      class Uint8Array { value: number; constructor(value: number) { this.value = value; } }
      class Date { value: number; constructor() { this.value = 5; } }
      export function canary(): number {
        const error = new Error(6);
        const bytes = new Uint8Array(7);
        const date = new Date();
        return error.value + bytes.value + date.value;
      }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const selection = planIrCompilation(sourceFile, {
      experimentalIR: true,
      trackFallbacks: true,
      isAmbientBinding: () => false,
    });
    expect(selection.funcs.has("canary")).toBe(true);
    expect(selection.fallbacks?.find((fallback) => fallback.name === "canary")).toBeUndefined();
  });

  it("keeps unknown internal throws classified as invariants", () => {
    expect(classifyIrFailure(new TypeError("malformed producer state"), "build")).toMatchObject({
      kind: "invariant",
      stage: "build",
      code: "unexpected-internal-throw",
    });
  });
});
