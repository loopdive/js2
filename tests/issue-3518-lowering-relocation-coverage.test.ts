// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { LOWERING_TARGETS } from "../scripts/check-pushraw.mjs";
import { baseBlob, parseFrontmatterList } from "../scripts/lib/change-scope.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = resolve(repository, "scripts/check-pushraw.mjs");
const legacy = "src/ir/lower.ts";
const generic = "src/ir/lower-generic.ts";
const issue = "plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md";
const baselinePath = "scripts/pushraw-baseline.json";
const expectedTargets = [
  legacy,
  generic,
  "src/ir/backend/lower-contracts.ts",
  "src/ir/backend/wasm-constants.ts",
  "src/ir/backend/wasm-lowering.ts",
];
const roots: string[] = [];
const oldSource = `export function lower(emitter, out) {
  emitter.pushRaw(out, legacy);
  // pushraw-ok(#2953): retained reviewed escape
  emitter.pushRaw(out, reviewed);
}
`;

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || key === "LOC_GATE_BASE") Reflect.deleteProperty(env, key);
  }
  return env;
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "js2-lowering-ratchet-"));
  roots.push(root);
  const put = (path: string, source: string) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), source);
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: cleanEnvironment() });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.name", "Thomas Tränkler");
  git("config", "user.email", "git@thomas.traenkler.com");
  put(legacy, oldSource);
  git("add", "--", legacy);
  git("commit", "-qm", "test(ir): seed isolated relocation fixture\n\nCo-authored-by: Codex <codex@openai.com>");
  const base = git("rev-parse", "HEAD");
  for (const path of expectedTargets) put(path, "export {};\n");
  put(legacy, 'export { lower } from "./lower-generic.js";\n');
  put(generic, `// Relocated implementation; no inherited site may disappear.\n${oldSource}`);
  put(baselinePath, readFileSync(resolve(repository, baselinePath), "utf8"));
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [checker, "--root", root, ...args], {
      encoding: "utf8",
      env: { ...cleanEnvironment(), LOC_GATE_BASE: base },
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { exit: result.status, output: result.stdout + result.stderr };
  };
  return { root, put, run, git };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("#3518 lowering relocation keeps the real pushRaw gate connected", () => {
  it("requires all five fixed paths independently of the baseline", () => {
    expect(LOWERING_TARGETS).toEqual(expectedTargets);
    const baseline = JSON.parse(readFileSync(resolve(repository, baselinePath), "utf8"));
    expect(baseline).toMatchObject({
      path: generic,
      paths: expectedTargets,
      relocatedFrom: legacy,
    });
    expect(baseline.untagged).toBeGreaterThanOrEqual(0);
    expect(baseline.untagged).toBeLessThanOrEqual(82);
    expect(baseline.total).toBe(baseline.tagged + baseline.untagged);
  });

  it("accepts the actual old-to-new source diff with both original sites and tags", () => {
    const f = fixture();
    const report = f.run("--json");
    expect(report.exit).toBe(0);
    expect(JSON.parse(report.output)).toMatchObject({ total: 2, tagged: 1, untagged: 1, paths: expectedTargets });
    expect(f.run()).toMatchObject({ exit: 0 });
    expect(f.run().output).toContain("0 added");
  });

  it.each(expectedTargets)("rejects a new untagged escape in %s, including untracked files", (path) => {
    const f = fixture();
    f.put(path, readFileSync(resolve(f.root, path), "utf8") + "emitter.pushRaw(out, injected);\n");
    const result = f.run();
    expect(result.exit).toBe(1);
    expect(result.output).toContain(path);
    expect(result.output).toContain("injected");
  });

  it("rejects replacing a moved legacy site without changing the denominator", () => {
    const f = fixture();
    f.put(generic, oldSource.replace("out, legacy", "out, replacement"));
    expect(f.run()).toMatchObject({ exit: 1 });
  });

  it("does not grant duplicate legacy site credit to the facade", () => {
    const f = fixture();
    f.put(legacy, oldSource);
    expect(f.run()).toMatchObject({ exit: 1 });
  });

  it("still admits newly reviewed tagged sites", () => {
    const f = fixture();
    f.put(
      generic,
      oldSource + "// pushraw-ok(#3518): fixture-only reviewed addition\nemitter.pushRaw(out, reviewedNew);\n",
    );
    expect(f.run()).toMatchObject({ exit: 0 });
  });

  it("compares the canonical path with itself after the relocation has landed", () => {
    const f = fixture();
    f.git("add", "--", "src", baselinePath);
    f.git("commit", "-qm", "test(ir): record fixture relocation\n\nCo-authored-by: Codex <codex@openai.com>");
    const result = spawnSync(process.execPath, [checker, "--root", f.root], {
      encoding: "utf8",
      env: { ...cleanEnvironment(), LOC_GATE_BASE: f.git("rev-parse", "HEAD") },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("0 added");
  });

  for (const mode of [[], ["--all"], ["--json"]]) {
    it.each(expectedTargets)(`fails closed for a missing %s (${mode.join(" ") || "change-scoped"})`, (path) => {
      const f = fixture();
      rmSync(resolve(f.root, path));
      expect(f.run(...mode).exit).not.toBe(0);
    });
  }

  it("rejects a baseline that drops a tracked lowering path", () => {
    const f = fixture();
    const baseline = JSON.parse(readFileSync(resolve(f.root, baselinePath), "utf8"));
    baseline.paths.pop();
    f.put(baselinePath, JSON.stringify(baseline));
    expect(f.run("--all")).toMatchObject({ exit: 1 });
  });
});

function bodyReceipt(source: string, name: string) {
  const ast = ts.createSourceFile("lower.ts", source, ts.ScriptTarget.Latest, true);
  const found: (ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression)[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      found.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(found).toHaveLength(1);
  const declaration = found[0]!;
  expect(declaration.body).toBeDefined();
  return {
    hash: createHash("sha256").update(declaration.body!.getText(ast)).digest("hex"),
    span:
      ast.getLineAndCharacterOfPosition(declaration.end).line -
      ast.getLineAndCharacterOfPosition(declaration.getStart(ast)).line +
      1,
  };
}

function replaceExact(source: string, before: string, after: string): string {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0)
    throw new Error("missing or duplicate reviewed composition span");
  return source.slice(0, at) + after + source.slice(at + before.length);
}

function requireComposedLowerer(source: string): void {
  const main = baseBlob(repository, "8c9b65b389194c8c8fc3e857e4b7316b0ae524e1", generic);
  expect(main).toBeDefined();
  // Exact reviewed M -> C hunks. No diff generated from the candidate is used
  // as its own allowance, and every original byte outside these spans remains.
  const changes: readonly (readonly [string, string])[] = [
    [
      'import type { BackendEmitter, BackendI32BitwiseOp } from "./backend/emitter.js";',
      'import type { BackendEmitter, BackendI32BitwiseOp } from "./backend/emitter.js";\nimport { objectConstructionValues } from "./object-construction-order.js";',
    ],
    [
      "        // Push values in canonical (sorted) field order — same order as\n        // shape.fields, which is also the WasmGC struct's declared field\n        // order. The builder enforces value-count parity with shape arity,\n        // so this loop always produces the right stack shape.",
      "        // Load the canonical SSA operands in the resolver's physical field order.\n        // Effectful definitions retain their scheduled evaluation order.",
    ],
    [
      "        for (const v of instr.values) emitValue(v, out);",
      "        for (const v of objectConstructionValues(instr.shape, instr.values, obj)) emitValue(v, out);",
    ],
    [
      "        const inner = asVal(valueIrType);\n        if (!inner) {\n          throw new Error(`ir/lower: refcell.new value must be a val-kind IrType (${func.name})`);\n        }",
      "        const inner = lowerIrTypeToValType(valueIrType, resolver, func.name);",
    ],
    [
      "        const getInner = memberValType(cellT.inner, func.name);",
      "        const getInner = lowerIrTypeToValType(cellT.inner, resolver, func.name);",
    ],
    [
      "        const setInner = memberValType(cellT.inner, func.name);",
      "        const setInner = lowerIrTypeToValType(cellT.inner, resolver, func.name);",
    ],
    [
      "  const innerVal = memberValType(t.inner, funcName);",
      "  const innerVal = lowerIrTypeToValType(t.inner, resolver, funcName);",
    ],
  ];
  let expected = main!;
  for (const [before, after] of changes) expected = replaceExact(expected, before, after);
  expect(source).toBe(expected);
  let inverse = source;
  for (const [before, after] of [...changes].reverse()) inverse = replaceExact(inverse, after, before);
  expect(inverse).toBe(main);
  for (const [name, hash, span] of [
    ["emitInstrTree", "75c0cceb6224dda24e892bcc5433532f10985c863b09fd4ae4245037811a2424", 2297],
    ["lowerIrFunctionBody", "ed92c0a576009ab30571152c9b01dfc6caf19a2e2ca3dfb436edef32b4436739", 3380],
  ] as const)
    expect(bodyReceipt(inverse, name)).toEqual({ hash, span });
}

describe("#5753 bounded lowering composition preserves the original donor receipts", () => {
  it("permits only the reviewed object-order and logical refcell changes", () => {
    requireComposedLowerer(readFileSync(resolve(repository, generic), "utf8"));
  });
  it.each(["inside approved hunk", "outside approved hunk"] as const)("rejects a mutation %s", (kind) => {
    const source = readFileSync(resolve(repository, generic), "utf8");
    requireComposedLowerer(source);
    const changed =
      kind === "inside approved hunk"
        ? replaceExact(source, "objectConstructionValues(instr.shape, instr.values, obj)", "instr.values")
        : replaceExact(source, "export function lowerIrFunctionBody", "export function changedLowerIrFunctionBody");
    expect(() => requireComposedLowerer(changed)).toThrow();
  });
});

// Historical provenance remains live even when the current change base already
// contains the relocation. Never skip it merely because main has advanced.
const base = "120cd638cf2a971934eaaccf47aaf65f06491f3d";
const relocation = "c257b46620fb4996bf5233763b80298c1fd03dc6";
const beforeLegacy = baseBlob(repository, base, legacy);
describe("#3518 initial relocation budget provenance", () => {
  it("moves exact bodies with no duplicate allowance or growth credit", () => {
    expect(base, "A known change base is required for initial relocation provenance").toBeDefined();
    expect(beforeLegacy).toBeDefined();
    const after = baseBlob(repository, relocation, generic)!;
    expect(after).toBeDefined();
    for (const [name, hash, span] of [
      ["emitInstrTree", "75c0cceb6224dda24e892bcc5433532f10985c863b09fd4ae4245037811a2424", 2297],
      ["lowerIrFunctionBody", "ed92c0a576009ab30571152c9b01dfc6caf19a2e2ca3dfb436edef32b4436739", 3380],
    ] as const) {
      expect(bodyReceipt(beforeLegacy!, name)).toEqual({ hash, span });
      expect(bodyReceipt(after, name)).toEqual({ hash, span });
      expect(readFileSync(resolve(repository, legacy), "utf8")).not.toContain(`function ${name}`);
    }
    const beforeIssue = baseBlob(repository, base!, issue)!;
    const afterIssue = baseBlob(repository, relocation, issue)!;
    for (const key of ["loc-budget-allow", "func-budget-allow"]) {
      const before = parseFrontmatterList(beforeIssue, key);
      const afterKeys = parseFrontmatterList(afterIssue, key);
      expect(afterKeys).toEqual(before.map((entry: string) => entry.replace(/^src\/ir\/lower\.ts(?=::|$)/, generic)));
      expect(new Set(afterKeys).size).toBe(afterKeys.length);
    }
    for (const path of ["scripts/loc-budget-baseline.json", "scripts/func-budget-baseline.json"]) {
      expect(baseBlob(repository, relocation, path)).toBe(baseBlob(repository, base!, path));
    }
    const oldRaw = JSON.parse(baseBlob(repository, base!, baselinePath)!);
    const newRaw = JSON.parse(baseBlob(repository, relocation, baselinePath)!);
    for (const key of ["total", "tagged", "untagged"]) expect(newRaw[key]).toBe(oldRaw[key]);
  });
});
