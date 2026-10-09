// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { analyzeSource } from "../src/checker/index.js";
import { TsCheckerOracle } from "../src/checker/oracle.js";
import { ts } from "../src/ts-api.js";
import { literalObjectWriteDeclaration } from "../src/codegen/declarations/object-property-write-target.js";

const controls = [
  [
    "any receiver preserves a Boolean primitive write",
    `var obj: any = { p: 17 }; var holder: any = { result: 0 };
     holder.result = delete obj.p;
     if (holder.result !== true || typeof holder.result !== "boolean") return 11;
     if (+holder.result !== 1 || holder.result * 4 !== 4) return 12;`,
  ],
  [
    "unannotated receiver preserves a Boolean primitive write",
    `var holder = { result: 0 };
     holder.result = true;
     if (holder.result !== true || typeof holder.result !== "boolean") return 21;
     if (+holder.result !== 1 || holder.result * 4 !== 4) return 22;`,
  ],
  [
    "same-spelled property on a separate literal stays numeric",
    `var holder: any = { result: 0 }; var numeric = { result: 17 };
     holder.result = true; numeric.result = 23;
     if (holder.result !== true || typeof holder.result !== "boolean") return 31;
     if (numeric.result !== 23 || typeof numeric.result !== "number") return 32;`,
  ],
  [
    "number-only writes retain Number identity",
    `var holder = { result: 0 };
     holder.result = 17; holder.result = holder.result + 6;
     if (holder.result !== 23 || typeof holder.result !== "number") return 41;`,
  ],
  [
    "literal computed key preserves a Boolean primitive write",
    `var holder: any = { result: 0 };
     holder["result"] = true;
     if (holder.result !== true || typeof holder.result !== "boolean") return 51;`,
  ],
  [
    "wrapped receiver and literal property name preserve Boolean identity",
    `var holder: any = ({ ["result"]: 0 });
     (holder as any).result = true;
     if (holder.result !== true || typeof holder.result !== "boolean") return 61;`,
  ],
] as const;

describe.each(["host", "standalone"] as const)("#6878 primitive property carrier (%s)", (target) => {
  it.each(controls)("%s", async (_name, body) => {
    const result = await compile(
      `function test(): number { ${body} return 1; }
       var actual = test();
       if (actual !== 1) throw new Error("Property carrier: " + actual);`,
      {
        fileName: "issue-6878-property-write-carrier.ts",
        skipSemanticDiagnostics: true,
        inferModuleStrictArguments: false,
        deferTopLevelInit: true,
        ...(target === "standalone" ? { target: "standalone" as const } : {}),
      },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
    const binary = new Uint8Array(result.binary);
    expect(WebAssembly.validate(binary)).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(binary, imports);
    const bind = (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance;
    if (target === "host") expect(typeof bind).toBe("function");
    bind?.(instance);
    expect(typeof instance.exports.__module_init).toBe("function");
    (instance.exports.__module_init as () => void)();
  });
});

function targets(source: string) {
  const { sourceFile, checker } = analyzeSource(source, "issue-6878-property-target.ts");
  const oracle = new TsCheckerOracle(checker);
  const found: (ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined)[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      found.push(literalObjectWriteDeclaration(oracle, node.left.expression, node.left.name.text));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

describe("#6878 exact primitive property write target", () => {
  it("keeps same-spelled bindings in separate scopes distinct", () => {
    const found = targets(`
      var holder: any = { result: 0 }; holder.result = true;
      function numeric() { var holder = { result: 17 }; holder.result = 23; }
    `);
    expect(found).toHaveLength(2);
    expect(found[0]?.getText()).toBe("result: 0");
    expect(found[1]?.getText()).toBe("result: 17");
    expect(found[0]).not.toBe(found[1]);
  });

  it("resolves literal computed names through receiver and initializer wrappers", () => {
    const found = targets(`
      var holder: any = ({ ["result"]: 0 } as any);
      (holder as any).result = true;
    `);
    expect(found).toHaveLength(1);
    expect(found[0]?.getText()).toBe('["result"]: 0');
  });

  it.each([
    ["alias", "var seed = { result: 0 }; var holder = seed; holder.result = true;"],
    ["parameter", "function write(holder: any) { holder.result = true; }"],
    ["unknown computed key", "var key: any; var holder = { [key]: 0 }; holder.result = true;"],
    ["spread", "var seed: any; var holder = { result: 0, ...seed }; holder.result = true;"],
    ["accessor", "var holder = { get result() { return 0; } }; holder.result = true;"],
    ["duplicate key", "var holder = { result: 0, result: 1 }; holder.result = true;"],
    ["ambiguous declaration", "var holder = { result: 0 }; var holder; holder.result = true;"],
  ])("declines %s receivers", (_name, source) => {
    expect(targets(source)).toEqual([undefined]);
  });
});
