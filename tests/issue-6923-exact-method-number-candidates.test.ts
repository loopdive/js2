// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Additive desired behavior; original adapter/P2/R/boundary fixtures are untouched.
import { compile } from "../src/index.js";
import { describe, expect, it, vi } from "vitest";
import { analyzeSource, analyzeMultiSource } from "../src/checker/index.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import * as carrier from "../src/codegen/analysis/local-number-carrier-proof.js";
import * as receiver from "../src/codegen/analysis/local-number-receiver-domain.js";
import { analyzeNumericPropertyNames } from "../src/codegen/numeric-property-analysis.js";
import { forEachChild, ts } from "../src/ts-api.js";

const NUMBER = `
function P(v) { this.v = v; }
P.prototype.inc = function () { this.v = this.v + 1; return this.v; };
function drive() { var p = new P(0); var result: any = p.inc(); return result; }
export function main() { return drive(); }
`;
const INPUT = NUMBER.replace("function () { this.v = this.v + 1;", "function (step) { this.v = this.v + step;").replace(
  "p.inc()",
  "p.inc(1)",
);
const TWO = INPUT.replace("var result: any = p.inc(1);", "p.inc(1); var result: any = p.inc(2);");
const BOUND = INPUT.replace("var result: any = p.inc(1);", "const amount = 2; var result: any = p.inc(amount);");

type Args = Parameters<typeof carrier.analyzeLocalNumberCarriers>;
type Slot = NonNullable<ReturnType<Args[2]["resolve"]>>;
type Domain = ReturnType<typeof receiver.makeLocalNumberReceiverDomain>;
type InputRecord = ReturnType<Domain["methodInputCandidates"]>[number];
type Query = Parameters<Parameters<Domain["withQuery"]>[1]>[0];

function nodesOf(sources: readonly ts.SourceFile[]): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    forEachChild(node, visit);
  };
  sources.forEach(visit);
  return nodes;
}

function inspect(source: string, openWorld = false) {
  const { sourceFile, checker } = analyzeSource(source, "issue-6878-receiver-adapter.ts");
  const oracle = new TsCheckerOracle(checker);
  const sources = [sourceFile];
  const nodes = nodesOf(sources);
  const declarations = nodes.filter(
    (node): node is ts.VariableDeclaration | ts.ParameterDeclaration =>
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name),
  );
  const parents = nodes.map((node) => node.parent);
  const resolutions = nodes.map((node) => oracle.valueDeclarationOf(node));
  const originalDomain = receiver.makeLocalNumberReceiverDomain;
  const originalCarrier = carrier.analyzeLocalNumberCarriers;
  let created: Domain | undefined;
  let received: Domain | undefined;
  let inventory: readonly InputRecord[] = [];
  let domainCalls = 0;
  let broadFactories = 0;
  let live: ReadonlySet<Slot> | undefined;
  let returned: ReadonlySet<Slot> | undefined;
  let candidateNames: string[] = [];
  const definitions: { slot: Slot; defs: Slot["defs"]; values: readonly Slot["defs"][number][] }[] = [];
  const broadVotes: { expression: ts.Expression; value: boolean; original: boolean | undefined }[] = [];
  const queryVotes: { composite?: boolean; final: boolean }[] = [];
  const expiredQueries: Query[] = [];
  const domainSpy = vi.spyOn(receiver, "makeLocalNumberReceiverDomain").mockImplementation((files, policy) => {
    expect(files === sources).toBe(true);
    domainCalls++;
    const domain = originalDomain(files, policy);
    inventory = domain.methodInputCandidates();
    created = {
      ...domain,
      withQuery(proofs, run) {
        const vote: { composite?: boolean; final: boolean } = { final: false };
        vote.final = domain.withQuery(proofs, (query) => {
          expiredQueries.push(query);
          vote.composite = run(query);
          return vote.composite;
        });
        queryVotes.push(vote);
        return vote.final;
      },
    };
    return created;
  });
  const wrapper: typeof carrier.analyzeLocalNumberCarriers = <S extends Slot>(
    host: Args[0],
    files: readonly ts.SourceFile[],
    scopes: {
      frameOf(node: ts.Node): ts.Node;
      resolve(node: ts.Node, name: string): S | undefined;
    },
    candidates: ReadonlySet<S>,
    makeBroad: (grounded: ReadonlySet<S>) => ReturnType<Args[4]>,
    policy: Args[5],
    domain?: Args[6],
  ): Set<S> => {
    expect(files === sources && host.oracle === oracle).toBe(true);
    received = domain;
    candidateNames = declarations.flatMap((declaration) => {
      const slot = scopes.resolve(declaration, declaration.name.getText());
      return slot && candidates.has(slot) ? [declaration.name.getText()] : [];
    });
    for (const declaration of declarations) {
      const slot = scopes.resolve(declaration, declaration.name.getText());
      if (slot) definitions.push({ slot, defs: slot.defs, values: [...slot.defs] });
    }
    const result = originalCarrier(
      host,
      files,
      scopes,
      candidates,
      (grounded) => {
        broadFactories++;
        live = grounded;
        const proof = makeBroad(grounded);
        return {
          ...proof,
          isNumeric(expression) {
            const value = proof.isNumeric(expression);
            broadVotes.push({ expression, value, original: proof.isOriginalNumeric?.(expression) });
            return value;
          },
        };
      },
      policy,
      domain,
    );
    returned = result;
    return result;
  };
  const carrierSpy = vi.spyOn(carrier, "analyzeLocalNumberCarriers").mockImplementation(wrapper);
  let verdicts: ReturnType<typeof analyzeNumericPropertyNames>;
  try {
    verdicts = analyzeNumericPropertyNames({ oracle, openWorldPropertyReads: openWorld }, sources);
  } finally {
    carrierSpy.mockRestore();
    domainSpy.mockRestore();
  }
  expect(domainCalls).toBe(1);
  expect(received === created && created !== undefined).toBe(true);
  expect(broadFactories).toBe(1);
  expect(live === returned && live !== undefined).toBe(true);
  expect(definitions.length).toBeGreaterThan(0);
  expect(
    definitions.every(
      ({ slot, defs, values }) =>
        slot.defs === defs && defs.length === values.length && defs.every((def, index) => def === values[index]),
    ),
  ).toBe(true);
  expect(
    nodes.every(
      (node, index) => node.parent === parents[index] && oracle.valueDeclarationOf(node) === resolutions[index],
    ),
  ).toBe(true);
  const numeric = (name: string): boolean => {
    const matches = declarations.filter((declaration) => declaration.name.getText() === name);
    if (matches.length !== 1) throw new Error(`UNKNOWN declaration ${name}/${matches.length}`);
    return verdicts.isNumericLocal(matches[0]!.name, name);
  };
  return {
    numeric,
    inventory,
    definitions,
    candidateNames,
    broadVotes,
    queryVotes,
    expiredQueries,
    verdicts,
    sourceFile,
    oracle,
    nodes,
  };
}

describe("#6923 exact method Number candidate projection", () => {
  it.each([
    ["original zero argument", NUMBER],
    ["exact original step(1)", INPUT],
    ["two exact Number calls", TWO],
    ["Number through closed binding", BOUND],
    ["all known local parameter writes", INPUT.replace("this.v = this.v + step;", "step = 2; this.v = this.v + step;")],
    [
      "two parameters",
      INPUT.replace("function (step)", "function (step, extra)")
        .replace("this.v + step", "this.v + step + extra")
        .replace("p.inc(1)", "p.inc(1, 2)"),
    ],
    [
      "unrelated same-spelled parameter",
      INPUT + "function unrelated(step) { return step; } const otherResult = unrelated(false);",
    ],
  ])("admits the result with complete input: %s", (_label, source) => {
    const fixture = inspect(source);
    expect(fixture.numeric("result")).toBe(true);
    if (source !== NUMBER && _label !== "unrelated same-spelled parameter") expect(fixture.numeric("step")).toBe(false);
  });

  it("retains original parameter/argument/installation identities and frozen copies", () => {
    const fixture = inspect(TWO);
    expect(fixture.inventory).toHaveLength(1);
    const input = fixture.inventory[0]!;
    expect(input.parameter.name.getText()).toBe("step");
    expect(fixture.oracle.valueDeclarationOf(input.parameter.name) === input.parameter).toBe(true);
    expect(input.method === input.parameter.parent).toBe(true);
    expect(ts.isFunctionDeclaration(input.constructor)).toBe(true);
    expect(input.installation.right === input.method).toBe(true);
    expect(input.arguments.map((argument) => argument.getText())).toEqual(["1", "2"]);
    expect(input.calls.every((call, index) => call.arguments[0] === input.arguments[index])).toBe(true);
    expect(
      Object.isFrozen(fixture.inventory) &&
        Object.isFrozen(input) &&
        Object.isFrozen(input.calls) &&
        Object.isFrozen(input.arguments),
    ).toBe(true);
    const step = fixture.definitions.find(
      ({ slot }) => slot.isParam && slot.defs.length === 1 && slot.defs[0]?.expr === undefined,
    );
    expect(step).toBeDefined();
    expect(fixture.candidateNames).toContain("result");
    expect(
      fixture.broadVotes.some(
        (vote) => vote.expression.getText() === "p.inc(2)" && vote.value && vote.original === false,
      ),
    ).toBe(true);
    expect(fixture.queryVotes.some((vote) => vote.composite === true && vote.final)).toBe(true);
    expect([...fixture.verdicts.numeric]).toEqual([]);
    expect([...fixture.verdicts.numericFunctions]).toEqual([]);
  });

  it.each([
    ["Boolean input", INPUT.replace("p.inc(1)", "p.inc(true)")],
    ["BigInt input", INPUT.replace("p.inc(1)", "p.inc(1n)")],
    ["String input", INPUT.replace("p.inc(1)", 'p.inc("1")')],
    ["object input", INPUT.replace("p.inc(1)", "p.inc({})")],
    ["unknown input", INPUT.replace("p.inc(1)", "p.inc(unknownValue)")],
    [
      "unknown unused-body input",
      INPUT.replace(
        "export function main",
        "function unused() { var q = new P(0); q.inc(unknownValue); } export function main",
      ),
    ],
    ["extra Boolean call", INPUT.replace("var result: any", "p.inc(false); var result: any")],
    [
      "unknown parameter write",
      INPUT.replace("this.v = this.v + step;", "step = unknownValue; this.v = this.v + step;"),
    ],
    ["Boolean parameter write", INPUT.replace("this.v = this.v + step;", "step = true; this.v = this.v + step;")],
    ["forced parameter update", INPUT.replace("this.v = this.v + step;", "step++; this.v = this.v + step;")],
    ["default parameter", INPUT.replace("function (step)", "function (step = 1)")],
    ["optional parameter", INPUT.replace("function (step)", "function (step?: any)")],
    ["rest parameter", INPUT.replace("function (step)", "function (...step)")],
    ["destructured parameter", INPUT.replace("function (step)", "function ({ step })")],
    ["missing argument", INPUT.replace("p.inc(1)", "p.inc()")],
    ["extra argument", INPUT.replace("p.inc(1)", "p.inc(1, 2)")],
    ["spread argument", INPUT.replace("p.inc(1)", "p.inc(...[1])")],
    ["optional call", INPUT.replace("p.inc(1)", "p.inc?.(1)")],
    ["optional receiver", INPUT.replace("p.inc(1)", "p?.inc(1)")],
    ["escaped method", INPUT.replace("var result: any", "var escape = p.inc; var result: any")],
    ["escaped instance", INPUT.replace("var result: any", "unknownCall(p); var result: any")],
    [
      "getter method",
      INPUT.replace(
        "P.prototype.inc = function (step)",
        'Object.defineProperty(P.prototype, "inc", { get: function (step)',
      ).replace("return this.v; };", "return this.v; } });"),
    ],
    ["Proxy receiver", INPUT.replace("var p = new P(0)", "var p = new Proxy(new P(0), {})")],
    [
      "reflective installation",
      INPUT.replace(
        "P.prototype.inc = function (step)",
        'Object.defineProperty(P.prototype, "inc", { value: function (step)',
      ).replace("return this.v; };", "return this.v; } });"),
    ],
    ["exported constructor", INPUT.replace("function P", "export function P")],
    [
      "exported method binding",
      INPUT.replace("function drive()", "export const escaped = P.prototype.inc; function drive()"),
    ],
    [
      "method reassignment",
      INPUT.replace("function drive()", "P.prototype.inc = function (step) { return step; }; function drive()"),
    ],
    ["uninitialized field", INPUT.replace("this.v = v;", "")],
    ["allocation before installation", INPUT.replace("P.prototype.inc =", "var early = new P(0); P.prototype.inc =")],
    ["direct method recursion", INPUT.replace("return this.v;", "return this.inc(step);")],
    [
      "mutual method recursion",
      INPUT.replace("return this.v;", "return this.other(step);").replace(
        "function drive()",
        "P.prototype.other = function (step) { return this.inc(step); }; function drive()",
      ),
    ],
    ["wrong same-spelled receiver", INPUT.replace("p.inc(1)", "({ inc: function (step) { return step; } }).inc(1)")],
  ])("declines incomplete or conflicting input: %s", (_label, source) => {
    expect(inspect(source).numeric("result")).toBe(false);
  });

  it("retains open-world read denial", () => {
    expect(inspect(INPUT, true).numeric("result")).toBe(false);
  });
  it("retains ambient-read veto for the supplemental result", () => {
    const fixture = inspect(INPUT.replace("var result: any", "external; var result: any"));
    expect(fixture.candidateNames).toContain("result");
    expect(fixture.numeric("result")).toBe(false);
  });
  it("retains independent final-R rejection of an unused opaque body", () => {
    const fixture = inspect(INPUT + "function unused() { unknown(); }");
    expect(fixture.candidateNames).toContain("result");
    expect(fixture.numeric("result")).toBe(false);
    expect(fixture.queryVotes.some((vote) => vote.composite === true && !vote.final)).toBe(true);
  });
  it("retains strict Number denial for Boolean method return", () => {
    const fixture = inspect(INPUT.replace("return this.v;", "return true;"));
    expect(fixture.numeric("result")).toBe(false);
  });

  it("retains query expiry after a successful supplemental proof", () => {
    const fixture = inspect(INPUT);
    expect(fixture.numeric("result")).toBe(true);
    expect(fixture.expiredQueries.length).toBeGreaterThan(0);
    const parameter = fixture.inventory[0]!.parameter;
    expect(ts.isIdentifier(parameter.name)).toBe(true);
    if (!ts.isIdentifier(parameter.name)) throw new Error("UNKNOWN parameter identity");
    const identifier = parameter.name;
    expect(fixture.expiredQueries.every((query) => !query.proveParameter(identifier, "number"))).toBe(true);
  });

  it("projects no method input without an original call population", () => {
    const fixture = inspect(INPUT.replace("p.inc(1)", "0"));
    expect(fixture.inventory).toHaveLength(0);
    expect(fixture.numeric("result")).toBe(true);
  });

  it("declines supplemental inputs when binding resolution is unavailable", () => {
    const { sourceFile, checker } = analyzeSource(INPUT, "issue-6878-receiver-adapter.ts");
    const oracle = new TsCheckerOracle(checker);
    const verdicts = analyzeNumericPropertyNames({ oracle: { typeFactOf: (node) => oracle.typeFactOf(node) } }, [
      sourceFile,
    ]);
    const results = nodesOf([sourceFile]).filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "result",
    );
    expect(results).toHaveLength(1);
    expect(verdicts.isNumericLocal(results[0]!.name, "result")).toBe(false);
  });

  it("retains poisoned computed-write public and local denial", () => {
    const { sourceFile, checker } = analyzeSource(
      INPUT.replace("this.v = v;", "this.v = v; this[unknownKey] = 1;"),
      "issue-6878-receiver-adapter.ts",
    );
    const oracle = new TsCheckerOracle(checker);
    const verdicts = analyzeNumericPropertyNames({ oracle }, [sourceFile]);
    const results = nodesOf([sourceFile]).filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "result",
    );
    expect(results).toHaveLength(1);
    expect(verdicts.isNumericLocal(results[0]!.name, "result")).toBe(false);
    expect([...verdicts.numeric]).toEqual([]);
    expect([...verdicts.numericFunctions]).toEqual([]);
  });
  it("retains pure-cycle denial and initialized local induction", () => {
    const cycle = inspect(
      "function drive() { var a: any = b; var b: any = a; var result: any = a; return result; } export function main() { return drive(); }",
    );
    expect(cycle.numeric("result")).toBe(false);
    const induction = inspect(
      INPUT.replace("var result: any = p.inc(1);", "var result: any = 0; result = result + p.inc(1);"),
    );
    expect(induction.numeric("result")).toBe(true);
  });

  it.each([
    ["zeroarg", NUMBER],
    ["one input", INPUT],
    ["two inputs", TWO],
    ["binding", BOUND],
    ["conflicting input", INPUT.replace("p.inc(1)", "p.inc(true)")],
  ])("preserves exact public sets when candidate projection is withheld: %s", (_label, source) => {
    const { sourceFile, checker } = analyzeSource(source, "issue-6878-receiver-adapter.ts");
    const oracle = new TsCheckerOracle(checker);
    const sources = [sourceFile];
    const names = nodesOf(sources).filter(
      (node): node is ts.VariableDeclaration | ts.ParameterDeclaration =>
        (ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name),
    );
    const project = (facts: ReturnType<typeof analyzeNumericPropertyNames>) => [
      [...facts.numeric].sort(),
      [...facts.string].sort(),
      [...facts.numericFunctions].sort(),
      names.map((node) => facts.isStringLocal(node.name, node.name.getText())),
    ];
    const actual = analyzeNumericPropertyNames({ oracle }, sources);
    const original = carrier.makeLocalNumberCarrierDomain;
    const spy = vi.spyOn(carrier, "makeLocalNumberCarrierDomain").mockImplementation((...args) => ({
      ...original(...args),
      methodInputCandidates: () => Object.freeze([]),
    }));
    try {
      const withheld = analyzeNumericPropertyNames({ oracle }, sources);
      expect(project(actual)).toEqual(project(withheld));
    } finally {
      spy.mockRestore();
    }
  });

  it.each([false, true])("isolates same-spelled declarations in multiple sources, reverse=%s", (reverse) => {
    const peer = INPUT.replaceAll("P", "Q")
      .replaceAll("drive", "peerDrive")
      .replace("export function main", "export function peerMain");
    const typed = analyzeMultiSource({ "a.ts": INPUT, "b.ts": peer }, "a.ts");
    const sources = typed.sourceFiles.filter((file) => !file.isDeclarationFile);
    expect(sources).toHaveLength(2);
    const oracle = new TsCheckerOracle(typed.checker);
    const ordered = reverse ? [...sources].reverse() : sources;
    const verdicts = analyzeNumericPropertyNames({ oracle }, ordered);
    const results = nodesOf(sources).filter(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "result",
    );
    expect(results).toHaveLength(2);
    expect(results.every((node) => verdicts.isNumericLocal(node.name, "result"))).toBe(true);
    expect([...verdicts.numeric]).toEqual([]);
    expect([...verdicts.numericFunctions]).toEqual([]);
  });
});

describe("#6923 actual result carrier and native values", () => {
  it.each([
    ["one Number input", INPUT, 1],
    ["two Number inputs", TWO, 3],
    ["closed Number binding", BOUND, 2],
  ])("computes every original switch profile: %s", async (label, source, expected) => {
    const profiles: Record<string, string>[] = [
      {},
      { JS2WASM_NUMERIC_LOCALS: "0" },
      { JS2WASM_MIXED_CARRIER_NUMERIC: "0" },
      { JS2WASM_NUMERIC_RETURNS: "0" },
      { JS2WASM_NUMERIC_ADMISSION: "0" },
    ];
    for (const [index, profile] of profiles.entries()) {
      const saved = Object.keys(profile).map((key) => [key, process.env[key]] as const);
      Object.assign(process.env, profile);
      try {
        const built = await compile(source as string, {
          fileName: "t.ts",
          target: "standalone",
          emitWat: true,
          skipSemanticDiagnostics: true,
        });
        expect(built.success, built.errors.map((error) => error.message).join("\n")).toBe(true);
        const functions = [...built.wat!.matchAll(/^ {2}\(func \$(\S+)/gm)];
        const position = functions.findIndex((match) => match[1] === "drive");
        expect(position).toBeGreaterThanOrEqual(0);
        const body = built.wat!.slice(functions[position]!.index, functions[position + 1]?.index ?? built.wat!.length);
        expect(body).toMatch(/\(local \$result (?:f64|externref)\)/);
        if (index === 0) expect(body).toContain("(local $result f64)");
        const instance = await WebAssembly.instantiate(await WebAssembly.compile(new Uint8Array(built.binary!)), {});
        const actual = (instance.exports.main as () => number)();
        console.info(
          "6923-native-visit",
          JSON.stringify({
            label,
            profile,
            actual,
            expected,
            resultCarrier: body.match(/\(local \$result ([^)]+)\)/)?.[1],
            functionNames: functions.map((match) => match[1]),
          }),
        );
        expect(actual).toBe(expected);
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) Reflect.deleteProperty(process.env, key);
          else process.env[key] = value;
        }
      }
    }
  });
});
