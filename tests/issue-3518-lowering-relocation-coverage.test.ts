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
import { baseBlob, parseFrontmatterList, resolveChangeBase } from "../scripts/lib/change-scope.mjs";

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

const { base } = resolveChangeBase(repository);
const beforeGeneric = base && baseBlob(repository, base, generic);
const beforeLegacy = base && baseBlob(repository, base, legacy);
describe("#3518 initial relocation budget provenance", () => {
  it.skipIf(base !== undefined && beforeGeneric !== undefined)(
    "moves exact bodies with no duplicate allowance or growth credit",
    () => {
      expect(base, "A known change base is required for initial relocation provenance").toBeDefined();
      expect(beforeLegacy).toBeDefined();
      const after = readFileSync(resolve(repository, generic), "utf8");
      for (const [name, hash, span] of [
        ["emitInstrTree", "75c0cceb6224dda24e892bcc5433532f10985c863b09fd4ae4245037811a2424", 2297],
        ["lowerIrFunctionBody", "ed92c0a576009ab30571152c9b01dfc6caf19a2e2ca3dfb436edef32b4436739", 3380],
      ] as const) {
        expect(bodyReceipt(beforeLegacy!, name)).toEqual({ hash, span });
        expect(bodyReceipt(after, name)).toEqual({ hash, span });
        expect(readFileSync(resolve(repository, legacy), "utf8")).not.toContain(`function ${name}`);
      }
      const beforeIssue = baseBlob(repository, base!, issue)!;
      const afterIssue = readFileSync(resolve(repository, issue), "utf8");
      for (const key of ["loc-budget-allow", "func-budget-allow"]) {
        const before = parseFrontmatterList(beforeIssue, key);
        const afterKeys = parseFrontmatterList(afterIssue, key);
        expect(afterKeys).toEqual(before.map((entry: string) => entry.replace(/^src\/ir\/lower\.ts(?=::|$)/, generic)));
        expect(new Set(afterKeys).size).toBe(afterKeys.length);
      }
      for (const path of ["scripts/loc-budget-baseline.json", "scripts/func-budget-baseline.json"]) {
        expect(readFileSync(resolve(repository, path), "utf8")).toBe(baseBlob(repository, base!, path));
      }
      const oldRaw = JSON.parse(baseBlob(repository, base!, baselinePath)!);
      const newRaw = JSON.parse(readFileSync(resolve(repository, baselinePath), "utf8"));
      for (const key of ["total", "tagged", "untagged"]) expect(newRaw[key]).toBe(oldRaw[key]);
    },
  );
});
