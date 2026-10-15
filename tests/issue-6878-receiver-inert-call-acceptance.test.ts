// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Desired-result acceptance, separate from retained predecessor diagnostics.
import { describe, expect, it, vi } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import * as carrierProof from "../src/codegen/analysis/local-number-carrier-proof.js";
import * as receiverProof from "../src/codegen/analysis/local-number-receiver-domain.js";
import { analyzeNumericPropertyNames } from "../src/codegen/numeric-property-analysis.js";
import { compile } from "../src/index.js";
import { forEachChild, ts } from "../src/ts-api.js";

const FILE_NAME = "issue-6878-receiver-adapter.ts";
const STRING = `
function Tok(input) { this.input = input; this.pos = 0; }
Tok.prototype.nextCode = function () { var c = this.input.charCodeAt(this.pos); this.pos = this.pos + 1; return c; };
function drive(s) { var t = new Tok(s); return t.nextCode(); }
export function main() { return drive("A"); }
`;
const LITERAL_MODULE = "export {}; const c = 'A'.charCodeAt(0); ";
type Domain = ReturnType<typeof receiverProof.makeLocalNumberReceiverDomain>;
type Query = Parameters<Parameters<Domain["withQuery"]>[1]>[0];
type Proofs = Parameters<Domain["withQuery"]>[0];
type Row = readonly [label: string, tail: string];

function unwrap(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

function original(source: string) {
  const { sourceFile, checker } = analyzeSource(source, FILE_NAME);
  const oracle = new TsCheckerOracle(checker);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    forEachChild(node, visit);
  };
  visit(sourceFile);
  const declaration = (name: string): ts.VariableDeclaration => {
    const matches = nodes.filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
    );
    if (matches.length !== 1) throw new Error(`UNKNOWN original declaration ${name}/${matches.length}`);
    return matches[0]!;
  };
  return { sourceFile, oracle, nodes, declaration };
}

function inspect(base: string, tail: string) {
  const fixture = original(base + tail);
  const { sourceFile, oracle, nodes, declaration } = fixture;
  const parents = nodes.map((node) => node.parent);
  const declarations = nodes.map((node) => oracle.valueDeclarationOf(node));
  const calls: { text: string; allowed: boolean; original: boolean; library: boolean }[] = [];
  const completed: { provisional: boolean; final: boolean }[] = [];
  const factory = receiverProof.makeLocalNumberReceiverDomain;
  const receiverSpy = vi.spyOn(receiverProof, "makeLocalNumberReceiverDomain").mockImplementation((files, policy) => {
    const domain = factory(files, policy);
    return {
      ...domain,
      withQuery(proofs, run) {
        const capability = proofs.isInertIntrinsicCall;
        let provisional = false;
        const result = domain.withQuery(
          {
            ...proofs,
            // Identical original production predicate, once per invocation; no new truth.
            ...(capability
              ? {
                  isInertIntrinsicCall: (call: ts.CallExpression, query: Query) => {
                    const allowed = capability(call, query);
                    const callee = unwrap(call.expression);
                    const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
                    const resolved = oracle.valueDeclarationOf(target);
                    calls.push({
                      text: call.getText(sourceFile),
                      allowed,
                      original: nodes.includes(call) && call.getSourceFile() === sourceFile,
                      library: resolved?.getSourceFile().isDeclarationFile === true,
                    });
                    return allowed;
                  },
                }
              : {}),
          },
          (query) => {
            provisional = run(query);
            return provisional;
          },
        );
        completed.push({ provisional, final: result });
        return result;
      },
    };
  });
  const carrierSpy = vi.spyOn(carrierProof, "analyzeLocalNumberCarriers");
  try {
    const verdicts = analyzeNumericPropertyNames({ oracle }, [sourceFile]);
    const numeric = (name: string) => verdicts.isNumericLocal(declaration(name).name, name);
    const numericC = numeric("c");
    const numericProbe = numeric("probe");
    if (carrierSpy.mock.calls.length !== 1) throw new Error("UNKNOWN actual carrier boundary population");
    const [host, sources, scopes, candidates] = carrierSpy.mock.calls[0]!;
    const slot = scopes.resolve(declaration("c").name, "c");
    expect(host.oracle === oracle).toBe(true);
    expect(sources.length === 1 && sources[0] === sourceFile).toBe(true);
    expect(slot !== undefined && candidates.has(slot)).toBe(true);
    expect(sourceFile.text).toBe(base + tail);
    nodes.forEach((node, index) => {
      expect(node.parent === parents[index]).toBe(true);
      expect(oracle.valueDeclarationOf(node) === declarations[index]).toBe(true);
    });
    expect(calls.every((call) => call.original)).toBe(true);
    console.info(
      "[6878-inert-call-acceptance]",
      JSON.stringify({
        base,
        tail,
        numericC,
        numericProbe,
        calls,
        completed,
        privateStrictVote: "UNKNOWN",
        privateP2Vote: "UNKNOWN",
        unobservedCapability: "UNKNOWN, never inferred from absence",
      }),
    );
    return { numericC, numericProbe, calls, completed };
  } finally {
    carrierSpy.mockRestore();
    receiverSpy.mockRestore();
  }
}

const POSITIVES: readonly Row[] = [
  ["Number conversion", "const probe = Number('1');"],
  ["String conversion", "const probe = String(1);"],
  ["Boolean conversion remains nonnumeric", "const probe = Boolean(0);"],
  ["parseInt", "const probe = parseInt('12', 10);"],
  ["parseFloat", "const probe = parseFloat('1.5');"],
  ["Math abs", "const probe = Math.abs(-1);"],
  ["Math max", "const probe = Math.max(1, 2);"],
  ["Math random is not folded", "const probe = Math.random();"],
  ["Date now is not folded", "const probe = Date.now();"],
  ["nested conversions", "const probe = Number(String(1));"],
  ["closed local", "const operand = '1'; const probe = Number(operand);"],
  ["closed helper", "function primitive() { return '1'; } const probe = Number(primitive());"],
  [
    "closed field",
    "function Cell(value) { this.value = value; } const operand = new Cell('1'); const probe = Number(operand.value);",
  ],
  ["false operand", "const probe = Number(false);"],
  ["true operand", "const probe = Number(true);"],
  ["null operand", "const probe = Number(null);"],
  ["zero argument Number", "const probe = Number();"],
  ["zero argument String", "const probe = String();"],
  ["zero argument Boolean", "const probe = Boolean();"],
  ["ignored primitive Number argument", "const probe = Number('1', 2);"],
  ["ignored primitive String argument", "const probe = String(1, 'ignored');"],
  ["ignored primitive Boolean argument", "const probe = Boolean(0, 'ignored');"],
  ["ignored primitive Date argument", "const probe = Date.now(1);"],
  ["noncoercing Boolean object", "const operand = { value: 1 }; const probe = Boolean(operand);"],
];
const CALLEES = [
  ["direct", "String"],
  ["parenthesized", "(String)"],
  ["double parenthesized", "((String))"],
  ["as wrapper", "(String as any)"],
  ["type assertion wrapper", "(<any>String)"],
  ["satisfies wrapper", "(String satisfies any)"],
  ["non-null wrapper", "String!"],
] as const;
const NEGATIVES: readonly (readonly [string, string, string])[] = [
  ["unbound", "const probe = __6878_unknown('1');", "const probe = Number('1');"],
  [
    "ambient Number",
    "declare function Number(value: any): number; const probe = Number('1');",
    "const probe = Number('1');",
  ],
  [
    "nonstandard ambient",
    "declare function Convert(value: any): number; const probe = Convert('1');",
    "const probe = Number('1');",
  ],
  [
    "source String shadow",
    "function String(value) { return 'shadow'; } const probe = String(1);",
    "const probe = String(1);",
  ],
  [
    "merged signature",
    "declare global { interface NumberConstructor { (value: number): boolean; } } const probe = Number(0);",
    "const probe = Number(0);",
  ],
  [
    "Number reassignment",
    "Number = function () { return false; }; const probe = Number('1');",
    "const probe = Number('1');",
  ],
  [
    "Boolean reassignment",
    "Boolean = function () { return 1; }; const probe = Boolean(0);",
    "const probe = Boolean(0);",
  ],
  [
    "Boolean static reflection",
    "globalThis['Boolean'] = function () { return 1; }; const probe = Boolean(0);",
    "const probe = Boolean(0);",
  ],
  [
    "Boolean dynamic reflection",
    "declare const key: string; globalThis[key] = function () { return 1; }; const probe = Boolean(0);",
    "const probe = Boolean(0);",
  ],
  ["Boolean namespace escape", "const root = globalThis; const probe = Boolean(0);", "const probe = Boolean(0);"],
  ["reflective callee", "const probe = globalThis.Number('1');", "const probe = Number('1');"],
  [
    "Math matching write",
    "Math.abs = function () { return false; }; const probe = Math.abs(-1);",
    "const probe = Math.abs(-1);",
  ],
  [
    "Math wildcard write",
    "declare const key: string; Math[key] = function () { return false; }; const probe = Math.abs(-1);",
    "const probe = Math.abs(-1);",
  ],
  ["namespace alias", "const namespace = Math; const probe = namespace.abs(-1);", "const probe = Math.abs(-1);"],
  ["Date write", "Date.now = function () { return false; }; const probe = Date.now();", "const probe = Date.now();"],
  [
    "defineProperty Boolean",
    "Object.defineProperty(globalThis, 'Boolean', { value: function () { return 1; } }); const probe = Boolean(0);",
    "const probe = Boolean(0);",
  ],
  [
    "Reflect Boolean",
    "Reflect.set(globalThis, 'Boolean', function () { return 1; }); const probe = Boolean(0);",
    "const probe = Boolean(0);",
  ],
  [
    "getter evaluation",
    "const operand = { get value() { return '1'; } }; const probe = Number(operand.value);",
    "const operand = '1'; const probe = Number(operand);",
  ],
  [
    "Proxy evaluation",
    "const operand = new Proxy({}, { get() { return '1'; } }); const probe = Number(operand.value);",
    "const operand = '1'; const probe = Number(operand);",
  ],
  [
    "unknown typed primitive",
    "declare const operand: string; const probe = Number(operand);",
    "const operand = '1'; const probe = Number(operand);",
  ],
  [
    "valueOf coercion",
    "const operand = { valueOf() { return 1; } }; const probe = Number(operand);",
    "const probe = Number(1);",
  ],
  [
    "toString coercion",
    "const operand = { toString() { return '1'; } }; const probe = String(operand);",
    "const probe = String(1);",
  ],
  [
    "Symbol coercion",
    "const operand = { [Symbol.toPrimitive]() { return 1; } }; const probe = Number(operand);",
    "const probe = Number(1);",
  ],
  [
    "ignored effectful Number argument",
    "declare function effect(): number; const probe = Number('1', effect());",
    "const probe = Number('1', 2);",
  ],
  [
    "ignored effectful Boolean argument",
    "declare function effect(): number; const probe = Boolean(0, effect());",
    "const probe = Boolean(0, 1);",
  ],
  ["optional", "const probe = Number?.('1');", "const probe = Number('1');"],
  ["spread", "const args = [1, 2]; const probe = Math.max(...args);", "const probe = Math.max(1, 2);"],
  ["computed", "const probe = Math['abs'](-1);", "const probe = Math.abs(-1);"],
  ["alias", "const Convert = Number; const probe = Convert('1');", "const probe = Number('1');"],
  ["unlisted member", "const probe = Math.toString();", "const probe = Math.abs(1);"],
  [
    "unused unknown body",
    "declare function effect(): void; function unused() { effect(); } const probe = Number('1');",
    "const probe = Number('1');",
  ],
  [
    "cyclic helper",
    "function primitive() { return primitive(); } const probe = Number(primitive());",
    "function primitive() { return '1'; } const probe = Number(primitive());",
  ],
  [
    "helper escape",
    "function primitive() { return '1'; } export { primitive }; const probe = Number(primitive());",
    "function primitive() { return '1'; } const probe = Number(primitive());",
  ],
  [
    "incomplete inputs",
    "declare const opaque: any; function primitive(value) { return value; } primitive(opaque); const probe = Number(primitive('1'));",
    "function primitive(value) { return value; } const probe = Number(primitive('1'));",
  ],
  ["String bare handle", "const probe = String;", "const probe = String(1);"],
  ["String wrapped alias", "const probe = (String);", "const probe = (String)(1);"],
  [
    "String argument escape",
    "declare function consume(value: any): void; consume((String)); const probe = 1;",
    "const probe = (String)(1);",
  ],
  [
    "String return escape",
    "function handle() { return (String); } const probe = handle();",
    "const probe = (String)(1);",
  ],
  [
    "String export escape",
    "const handle = (String); export { handle }; const probe = 1;",
    "const probe = (String)(1);",
  ],
  ["String comma callee", "const probe = (0, String)(1);", "const probe = (String)(1);"],
  ["String conditional callee", "const probe = (true ? String : String)(1);", "const probe = (String)(1);"],
  ["String logical callee", "const probe = (String || String)(1);", "const probe = (String)(1);"],
  ["String assignment callee", "let handle; const probe = (handle = String)(1);", "const probe = (String)(1);"],
  ["String optional wrapped", "const probe = (String)?.(1);", "const probe = (String)(1);"],
  ["String spread wrapped", "const args = [1]; const probe = (String)(...args);", "const probe = (String)(1);"],
  ["String call handle", "const probe = (String).call(null, 1);", "const probe = (String)(1);"],
  ["String apply handle", "const probe = (String).apply(null, [1]);", "const probe = (String)(1);"],
  ["String computed handle", "const probe = (String)['call'](null, 1);", "const probe = (String)(1);"],
  [
    "String wrapped reassignment",
    "String = function () { return 'x'; }; const probe = (String)(1);",
    "const probe = (String)(1);",
  ],
  [
    "String reflection",
    "globalThis['String'] = function () { return 'x'; }; const probe = (String)(1);",
    "const probe = (String)(1);",
  ],
  [
    "String matching prototype write",
    "String.prototype.charCodeAt = function () { return false; }; const probe = (String)(1);",
    "const probe = (String)(1);",
  ],
  [
    "String wildcard prototype write",
    "declare const key: string; String.prototype[key] = function () { return false; }; const probe = (String)(1);",
    "const probe = (String)(1);",
  ],
  [
    "String nested getter",
    "const operand = { get value() { return 1; } }; const probe = (String)(operand.value);",
    "const probe = (String)(1);",
  ],
  [
    "String extra effect",
    "declare function effect(): number; const probe = (String)(1, effect());",
    "const probe = (String)(1, 2);",
  ],
  [
    "String unused unknown body",
    "declare function effect(): void; function unused() { effect(); } const probe = (String)(1);",
    "const probe = (String)(1);",
  ],
  [
    "wrapper depth exhausted",
    `const probe = ${"(".repeat(49)}String${")".repeat(49)}(1);`,
    "const probe = (String)(1);",
  ],
];

for (const [path, base] of [
  ["original constructor", STRING],
  ["matched module literal", LITERAL_MODULE],
] as const) {
  describe(`#6878 inert-call acceptance — ${path}`, () => {
    it.each(POSITIVES)("completes supported effect: %s", (label, tail) => {
      const result = inspect(base, tail);
      expect(result.numericC).toBe(true);
      if (label.includes("Boolean")) expect(result.numericProbe).toBe(false);
      if (path === "original constructor") {
        expect(result.calls.some((call) => call.allowed && call.library)).toBe(true);
        expect(result.completed.some((query) => query.provisional && query.final)).toBe(true);
      }
    });
    it.each(CALLEES)("completes primitive transparent String callee: %s", (_label, callee) => {
      expect(inspect(base, `const probe = ${callee}(1);`).numericC).toBe(true);
    });
    it.each(CALLEES)("completes closed-field transparent String callee: %s", (_label, callee) => {
      const tail = `function Cell(value) { this.value = value; } const operand = new Cell(1); const probe = ${callee}(operand.value);`;
      const result = inspect(base, tail);
      expect(result.numericC).toBe(true);
      expect(result.calls.some((call) => call.allowed && call.text.endsWith("(operand.value)"))).toBe(true);
    });
    it.each(NEGATIVES)("preserves complete negative perimeter with clean twin: %s", (_label, tail, clean) => {
      expect(inspect(base, clean).numericC).toBe(true);
      expect(inspect(base, tail).numericC).toBe(false);
    });
  });
}

describe("#6878 inert-call forms without new constructor authority", () => {
  it.each(["new Number('1')", "new String(1)", "new (String)(1)", "Date()"])(
    "does not admit constructor-path tail %s",
    (call) => {
      expect(inspect(STRING, `const probe = ${call};`).numericC).toBe(false);
      // No expectation changes for existing literal/legacy constructor routes.
    },
  );
  it("keeps the independent closed source Number route, without intrinsic evidence", () => {
    const result = inspect(STRING, "function Number(value) { return 1; } const probe = Number('1');");
    expect(result.numericC).toBe(true);
    expect(result.calls.filter((call) => call.text === "Number('1')").length).toBeGreaterThan(0);
    expect(
      result.calls.filter((call) => call.text === "Number('1')").every((call) => !call.allowed && !call.library),
    ).toBe(true);
  });
});

// Specimen callbacks below test the optional R contract, not production identity.
function lifecycle(source = "export {}; const value = 1; const probe = Number(value);") {
  const fixture = original(source);
  const { sourceFile, nodes, oracle } = fixture;
  const domain = receiverProof.makeLocalNumberReceiverDomain([sourceFile], {
    unwrap,
    valueDeclarationOf: (node) => oracle.valueDeclarationOf(node),
    assignmentPropertyName: (expr) => {
      const value = unwrap(expr);
      return ts.isPropertyAccessExpression(value) ? value.name.text : undefined;
    },
    ownReturnExpressions: (fn) => {
      if (!ts.isBlock(fn.body)) return [fn.body];
      const returns: ts.Expression[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
        forEachChild(node, visit);
      };
      forEachChild(fn.body, visit);
      return returns.length ? returns : undefined;
    },
  });
  const grounded = new Set<ts.Node>();
  const proofs: Proofs = {
    isNumber: (expr) => grounded.has(unwrap(expr)),
    isString: (expr) => ts.isStringLiteral(unwrap(expr)),
    isStableStringMethod: () => false,
  };
  const number = nodes.find(ts.isNumericLiteral)!;
  const value = nodes.find(
    (node): node is ts.Identifier => ts.isIdentifier(node) && node.text === "value" && ts.isCallExpression(node.parent),
  )!;
  const call = nodes.find(ts.isCallExpression)!;
  return { ...fixture, domain, proofs, grounded, number, value, call };
}

describe("#6878 optional R capability lifecycle — independent specimens", () => {
  it("omission and explicit false retain the original complete veto", () => {
    const fixture = lifecycle();
    expect(fixture.domain.withQuery(fixture.proofs, () => true)).toBe(false);
    expect(fixture.domain.withQuery({ ...fixture.proofs, isInertIntrinsicCall: () => false }, () => true)).toBe(false);
  });
  it("reads the live original evidence false then true then false without memo truth", () => {
    const fixture = lifecycle();
    const proofs = {
      ...fixture.proofs,
      isInertIntrinsicCall: (_call: ts.CallExpression, query: Query) => query.proveBinding(fixture.value, "number"),
    };
    expect(fixture.domain.withQuery(proofs, () => true)).toBe(false);
    fixture.grounded.add(fixture.number);
    expect(fixture.domain.withQuery(proofs, () => true)).toBe(true);
    fixture.grounded.delete(fixture.number);
    expect(fixture.domain.withQuery(proofs, () => true)).toBe(false);
  });
  it("expires retained query methods and completion after success", () => {
    const fixture = lifecycle();
    fixture.grounded.add(fixture.number);
    let retained: Query | undefined;
    expect(
      fixture.domain.withQuery({ ...fixture.proofs, isInertIntrinsicCall: () => true }, (query) => {
        retained = query;
        return true;
      }),
    ).toBe(true);
    expect(retained).toBeDefined();
    expect(retained!.proveBinding(fixture.value, "number")).toBe(false);
    expect(retained!.complete(() => true)).toBe(false);
    expect(retained!.permitsReceiverCall(fixture.call)).toBe(false);
  });
  it("cleans a thrown callback and allows a fresh repeated query", () => {
    const fixture = lifecycle();
    let retained: Query | undefined;
    const thrown = new Error("original capability throw");
    expect(() =>
      fixture.domain.withQuery(
        {
          ...fixture.proofs,
          isInertIntrinsicCall: (_call, query) => {
            retained = query;
            throw thrown;
          },
        },
        () => true,
      ),
    ).toThrow(thrown);
    expect(retained!.complete(() => true)).toBe(false);
    expect(fixture.domain.withQuery({ ...fixture.proofs, isInertIntrinsicCall: () => true }, () => true)).toBe(true);
    expect(fixture.domain.withQuery({ ...fixture.proofs, isInertIntrinsicCall: () => false }, () => true)).toBe(false);
  });
  it("does not hide an unknown unused body behind an admitted call", () => {
    const fixture = lifecycle(
      "export {}; declare function opaque(): void; function unused() { opaque(); } const value = 1; const probe = Number(value);",
    );
    expect(
      fixture.domain.withQuery(
        { ...fixture.proofs, isInertIntrinsicCall: (call) => call.getText(fixture.sourceFile) === "Number(value)" },
        () => true,
      ),
    ).toBe(false);
  });
  it("does not hide an original getter evaluation behind an admitted call", () => {
    const fixture = lifecycle(
      "export {}; const value = { get field() { return 1; } }; const probe = Number(value.field);",
    );
    expect(fixture.domain.withQuery({ ...fixture.proofs, isInertIntrinsicCall: () => true }, () => true)).toBe(false);
  });
});

const ENVIRONMENTS: readonly (readonly [string, Record<string, string>])[] = [
  ["default", {}],
  ["numeric locals off", { JS2WASM_NUMERIC_LOCALS: "0" }],
  ["mixed carrier off", { JS2WASM_MIXED_CARRIER_NUMERIC: "0" }],
  ["numeric returns off", { JS2WASM_NUMERIC_RETURNS: "0" }],
  ["numeric admission off", { JS2WASM_NUMERIC_ADMISSION: "0" }],
];
async function native(source: string, environment: Record<string, string>) {
  const saved = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const result = await compile(source, {
      fileName: "t.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
      emitWat: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const instance = await WebAssembly.instantiate(await WebAssembly.compile(new Uint8Array(result.binary!)), {});
    return (instance.exports.main as () => number)();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}
const NATIVE = [
  [
    "supported conversions preserve constructor value",
    STRING.replace('drive("A")', "drive(String(65).charAt(0))").replace(
      "export function main()",
      "const probe = Number('1'); export function main()",
    ),
    54,
  ],
  [
    "receiver and supplied arguments run once in order",
    `let log = 0; function receiver() { log = log * 10 + 1; return 'A'; } function index() { log = log * 10 + 2; return 0; } function extra() { log = log * 10 + 3; return 9; } export function main() { const c = receiver().charCodeAt(index(), extra()); return log * 100 + c; }`,
    12365,
  ],
  [
    "ignored conversion argument still runs once",
    `let log = 0; function first() { log = log * 10 + 1; return '7'; } function extra() { log = log * 10 + 2; return 0; } export function main() { const c = Number(first(), extra()); return log * 100 + c; }`,
    1207,
  ],
  [
    "Boolean object does not invoke coercion",
    `let log = 0; export function main() { const object = { valueOf() { log = log + 1; return 0; }, toString() { log = log + 10; return ''; } }; const c = Boolean(object); return c === true && log === 0 ? 1 : 0; }`,
    1,
  ],
  [
    "getter throw interrupts ignored argument and preserves order",
    `let log = 0; function receiver() { log = log * 10 + 1; return { get value() { log = log * 10 + 2; throw 7; } }; } function extra() { log = log * 10 + 3; return 0; } export function main() { try { Number(receiver().value, extra()); } catch (error) { return log * 10 + (error === 7 ? 1 : 0); } return 0; }`,
    121,
  ],
  [
    "Number Symbol abrupt completion stays observable",
    `export function main() { try { Number(Symbol('x')); } catch (error) { return 1; } return 0; }`,
    1,
  ],
] as const;
describe("#6878 inert-call independent native behavior, not physical K evidence", () => {
  it.each(NATIVE)("preserves value/order/throw under all profiles: %s", async (label, source, expected) => {
    for (const [profile, environment] of ENVIRONMENTS) {
      const actual = await native(source, environment);
      console.info(
        "[6878-inert-call-native]",
        JSON.stringify({ label, profile, actual, expected, lifecycle: "instantiate {} then main only" }),
      );
      expect(actual).toBe(expected);
    }
  });
});
