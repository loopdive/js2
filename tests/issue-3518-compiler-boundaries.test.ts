// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = resolve(repository, "scripts/check-compiler-boundaries.mjs");
const roots: string[] = [];
type Policy = Record<string, any>;

function fixture(sources: Record<string, string> = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "js2-boundaries-"));
  roots.push(root);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), text);
  };
  const files = {
    "src/foundation/value.ts": "export type Value = number; export const value = 1;",
    "src/frontend/parser.ts": 'import type { Value } from "../foundation/value.js"; export type Parsed = Value;',
    ...sources,
  };
  for (const [path, text] of Object.entries(files)) put(path, text);
  put(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "@front/*": ["src/frontend/*"] },
      },
      include: ["src/**/*"],
    }),
  );
  const policy: Policy = {
    schema: "compiler-boundaries-v1",
    sourceRoot: "src",
    tsconfig: "tsconfig.json",
    moduleExtensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    layers: [
      {
        id: "foundation",
        status: "active",
        roots: ["src/foundation"],
        required: true,
        entries: ["src/foundation/value.ts"],
        minModules: 1,
      },
      {
        id: "frontend-ts",
        status: "active",
        roots: ["src/frontend"],
        required: true,
        entries: ["src/frontend/parser.ts"],
        minModules: 1,
      },
    ],
    allowedEdges: { foundation: ["foundation"], "frontend-ts": ["frontend-ts", "foundation"] },
    files: Object.keys(files).map((path) => ({
      path,
      state: "clean",
      layer: path.startsWith("src/foundation/") ? "foundation" : "frontend-ts",
    })),
    nonModules: [],
    externalPackages: [],
    activationHistory: [],
    moves: [],
    evidence: [],
  };
  const run = (mode = "complete", save = true, base?: string, inheritedGit: Record<string, string> = {}) => {
    if (save) put("policy.json", JSON.stringify(policy));
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=2048",
        checker,
        "--root",
        root,
        "--config",
        "policy.json",
        "--mode",
        mode,
        "--json",
        ...(base ? ["--base", base] : []),
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...inheritedGit } },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { exit: result.status, report: JSON.parse(result.stdout) };
  };
  return { root, policy, put, run };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const codes = (result: ReturnType<ReturnType<typeof fixture>["run"]>) =>
  result.report.errors.map((error: { code: string }) => error.code);

// Synthetic history exists only in temporary fixture repositories. Writing Git
// objects avoids requiring signing credentials or executing project commit hooks
// to model the historical policies that the detector must read.
function history(f: ReturnType<typeof fixture>) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (args: string[], input?: string) =>
    execFileSync("git", ["-C", f.root, ...args], { env, encoding: "utf8", input }).trim();
  git(["init", "-q"]);
  let parent: string | undefined;
  return (policyText: string | null = JSON.stringify(f.policy)) => {
    if (policyText !== null) {
      f.put("policy.json", policyText);
      git(["add", "policy.json"]);
    }
    const tree = git(["write-tree"]);
    const commit = git(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author Thomas Tränkler <git@thomas.traenkler.com> 1788800000 +0000\ncommitter Thomas Tränkler <git@thomas.traenkler.com> 1788800000 +0000\n\nBoundary history test fixture\n\nCo-authored-by: Codex <codex@openai.com>\nModel: Codex GPT-6 Astra Low\n`,
    );
    git(["update-ref", "HEAD", commit]);
    parent = commit;
    return commit;
  };
}

describe("#3518 real compiler boundary detector", () => {
  it("visits a nonempty clean graph, real roots and .js-to-.ts type edges", () => {
    const { run } = fixture();
    const result = run();
    expect(result.exit).toBe(0);
    expect(result.report.architectureComplete).toBe(true);
    expect(result.report.counts.total).toBe(2);
    expect(result.report.resolvedEdgeCount).toBe(1);
    expect(result.report.edges[0]).toMatchObject({ to: "src/foundation/value.ts", typeOnly: true });
    expect(result.report.activatedRoots.every((root: any) => root.visitedEntries.length > 0 && root.modules > 0)).toBe(
      true,
    );
    expect(result.report.policyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.report.dirtyContentFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['import { parser } from "../frontend/parser.js";', "import", false],
    ['import type { Parsed } from "../frontend/parser.js";', "import", true],
    ['type T = import("../frontend/parser.js").Parsed;', "import-type", true],
    ['export type { Parsed } from "../frontend/parser.js";', "export-from", true],
    ['import "../frontend/parser.js";', "side-effect-import", false],
    ['import type { Parsed } from "@front/parser";', "import", true],
    ['const x = import("../frontend/parser.js");', "dynamic-import", false],
    ['const x = require("../frontend/parser.js");', "require", false],
    ['import x = require("../frontend/parser.js");', "import-equals", false],
  ])("rejects real forbidden syntax: %s", (source, syntax, typeOnly) => {
    const result = fixture({ "src/foundation/value.ts": source }).run();
    expect(result.exit).not.toBe(0);
    expect(result.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ from: "src/foundation/value.ts", to: "src/frontend/parser.ts", syntax, typeOnly }),
    );
  });

  it("follows a type-only frontend edge through an export-star barrel", () => {
    const result = fixture({
      "src/foundation/value.ts": 'export * from "./barrel.js";',
      "src/foundation/barrel.ts": 'export type { Parsed } from "../frontend/parser.js";',
    }).run();
    expect(result.exit).not.toBe(0);
    expect(result.report.transitiveViolations).toContainEqual(
      expect.objectContaining({
        path: ["src/foundation/value.ts", "src/foundation/barrel.ts", "src/frontend/parser.ts"],
      }),
    );
    expect(
      result.report.forbiddenEdges.some((edge: any) => edge.from === "src/foundation/barrel.ts" && edge.typeOnly),
    ).toBe(true);
  });

  it.each(["import(name)", "require(name)"])(
    "reports nonliteral %s as unknown, with unmigrated debt distinct from clean failure",
    (expression) => {
      const f = fixture({ "src/foundation/value.ts": `const name = 'x'; ${expression};` });
      const clean = f.run("inventory");
      expect(clean.exit).not.toBe(0);
      expect(codes(clean)).toContain("unknown-clean-edge");
      f.policy.layers.forEach((layer: any) => {
        layer.status = "planned";
      });
      f.policy.files.forEach((entry: any) => {
        entry.state = "unmigrated";
      });
      const debt = f.run("inventory");
      expect(debt.exit).toBe(0);
      expect(debt.report.graphComplete).toBe(false);
      expect(debt.report.unknownEdges).toHaveLength(1);
      expect(debt.report.architectureComplete).toBe(false);
      expect(f.run().exit).not.toBe(0);
    },
  );

  it("handles extensionless directory imports and declarations", () => {
    const result = fixture({
      "src/frontend/parser.ts": 'import type { Value } from "../foundation/directory"; export type Parsed = Value;',
      "src/foundation/directory/index.d.ts": "export type Value = number;",
    }).run();
    expect(result.exit).toBe(0);
    expect(result.report.edges[0].to).toBe("src/foundation/directory/index.d.ts");
    expect(result.report.counts.total).toBe(3);
  });

  it("uses package exports and enforces external type packages by layer", () => {
    const f = fixture({ "src/foundation/value.ts": 'import type { X } from "fixture-parser/api";' });
    f.put(
      "node_modules/fixture-parser/package.json",
      JSON.stringify({ name: "fixture-parser", version: "1.0.0", exports: { "./api": { types: "./api.d.ts" } } }),
    );
    f.put("node_modules/fixture-parser/api.d.ts", "export type X = number;");
    f.policy.externalPackages = [{ name: "fixture-parser", layers: ["frontend-ts"] }];
    const result = f.run();
    expect(result.report.unresolvedEdges).toHaveLength(0);
    expect(result.report.edges).toContainEqual(expect.objectContaining({ external: "fixture-parser", typeOnly: true }));
    expect(codes(result)).toContain("forbidden-clean-edge");
    f.policy.externalPackages[0].layers.push("foundation");
    expect(f.run().exit).toBe(0);
  });

  it("does not permit parser packages in foundations even through an external allow rule", () => {
    const f = fixture({ "src/foundation/value.ts": 'import type { X } from "typescript";' });
    f.put(
      "node_modules/typescript/package.json",
      JSON.stringify({ name: "typescript", version: "1.0.0", types: "index.d.ts" }),
    );
    f.put("node_modules/typescript/index.d.ts", "export type X = number;");
    f.policy.externalPackages = [{ name: "typescript", layers: ["foundation"] }];
    expect(f.run().report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ reason: "parser/checker packages are frontend-only, including types" }),
    );
  });

  it("requires explicit built-in policy and exposes missing external resolution", () => {
    const f = fixture({ "src/frontend/parser.ts": 'import "node:fs";' });
    expect(codes(f.run())).toContain("unclassified-external");
    f.policy.externalPackages = [{ name: "node:*", layers: ["frontend-ts"] }];
    expect(f.run().exit).toBe(0);
    f.put("src/frontend/parser.ts", 'import "package-that-does-not-exist";');
    expect(codes(f.run())).toContain("unresolved-module");
  });

  it("resolves import and require against their distinct package export conditions", () => {
    const f = fixture({
      "src/frontend/parser.ts": 'import type { X } from "conditional"; const x = require("conditional");',
    });
    f.put(
      "node_modules/conditional/package.json",
      JSON.stringify({
        name: "conditional",
        version: "1.0.0",
        exports: { ".": { import: "./import.d.ts", require: "./require.d.ts" } },
      }),
    );
    f.put("node_modules/conditional/import.d.ts", "export type X = number;");
    f.put("node_modules/conditional/require.d.ts", "export type X = string;");
    f.policy.externalPackages = [{ name: "conditional", layers: ["frontend-ts"] }];
    const result = f.run();
    expect(result.exit).toBe(0);
    expect(result.report.edges.map((edge: any) => edge.resolvedPath)).toEqual([
      "node_modules/conditional/import.d.ts",
      "node_modules/conditional/require.d.ts",
    ]);
  });

  it("reports a concrete external parser path through a type barrel", () => {
    const f = fixture({
      "src/foundation/value.ts": 'export * from "./barrel.js";',
      "src/foundation/barrel.ts": 'export type { X } from "typescript";',
    });
    f.put(
      "node_modules/typescript/package.json",
      JSON.stringify({ name: "typescript", version: "1.0.0", types: "index.d.ts" }),
    );
    f.put("node_modules/typescript/index.d.ts", "export type X = number;");
    f.policy.externalPackages = [{ name: "typescript", layers: ["frontend-ts"] }];
    const result = f.run();
    expect(result.report.transitiveViolations).toContainEqual(
      expect.objectContaining({
        path: ["src/foundation/value.ts", "src/foundation/barrel.ts", "typescript"],
        typeOnly: true,
      }),
    );
  });

  it("keeps the ts-api wrapper frontend-only even when its current concern label is ambiguous", () => {
    const f = fixture({
      "src/foundation/value.ts": 'import type { X } from "./ts-api.js";',
      "src/foundation/ts-api.ts": "export type X = number;",
    });
    f.policy.frontendWrapper = "src/foundation/ts-api.ts";
    const result = f.run();
    expect(result.exit).not.toBe(0);
    expect(result.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ reason: "frontend wrapper is frontend-only, including types", typeOnly: true }),
    );
  });

  it("visits every supported JS/TS variant including declaration modules", () => {
    const sources = Object.fromEntries(
      ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "d.ts", "d.mts", "d.cts"].map((extension) => [
        `src/foundation/variant.${extension}`,
        "export {}; ",
      ]),
    );
    const result = fixture(sources).run();
    expect(result.exit).toBe(0);
    expect(result.report.counts.total).toBe(13);
  });

  it("does not treat a relative escape into node_modules as an allowed package import", () => {
    const f = fixture({ "src/foundation/value.ts": 'import "../../node_modules/example/index.js";' });
    f.put("node_modules/example/index.ts", "export {}; ");
    f.policy.externalPackages = [{ name: "example", layers: ["foundation"] }];
    expect(codes(f.run())).toContain("source-path-escape");
  });

  it("allows exact JSON metadata policy without allowing implementation escapes", () => {
    const f = fixture({ "src/frontend/parser.ts": 'const metadata = require("../../package.json");' });
    f.put("package.json", '{"name":"fixture"}');
    f.policy.externalAssets = [{ path: "package.json", layers: ["frontend-ts"], reason: "Version metadata." }];
    const before = f.run();
    expect(before.exit).toBe(0);
    expect(before.report.edges[0].asset).toBe("package.json");
    f.put("package.json", '{"name":"changed"}');
    expect(f.run().report.dirtyContentFingerprint).not.toBe(before.report.dirtyContentFingerprint);
    f.policy.externalAssets[0].path = "outside.ts";
    expect(codes(f.run())).toContain("external-asset-policy");
  });

  it("rejects relative source escapes", () => {
    const f = fixture({ "src/foundation/value.ts": 'import "../../outside.js";' });
    f.put("outside.ts", "export const outside = 1;");
    expect(codes(f.run())).toContain("source-path-escape");
  });

  it.each(["missing-module", "missing-config", "missing-src", "extra", "duplicate", "stale"])(
    "fails closed for %s",
    (kind) => {
      const f = fixture();
      let save = true;
      const expected: Record<string, string> = {
        "missing-module": "unresolved-module",
        "missing-config": "missing-or-invalid-policy",
        "missing-src": "unreadable-source",
        extra: "unclassified-module",
        duplicate: "duplicate-classification",
        stale: "stale-classification",
      };
      if (kind === "missing-module") f.put("src/foundation/value.ts", 'import "./missing.js";');
      if (kind === "missing-config") save = false;
      if (kind === "missing-src") rmSync(resolve(f.root, "src"), { recursive: true });
      if (kind === "extra") f.put("src/foundation/unclassified.ts", "export {};");
      if (kind === "duplicate") f.policy.files.push({ ...f.policy.files[0] });
      if (kind === "stale")
        f.policy.files.push({ path: "src/foundation/stale.ts", layer: "foundation", state: "clean" });
      const result = f.run("inventory", save);
      expect(result.exit).not.toBe(0);
      expect(codes(result)).toContain(expected[kind]);
    },
  );

  it("reports a controlled unreadable file even under privileged runners", () => {
    const f = fixture();
    const path = resolve(f.root, "src/foundation/value.ts");
    chmodSync(path, 0);
    try {
      const result = f.run();
      expect(codes(result)).toContain("unreadable-input");
      expect(result.report.errors.some((error: any) => error.detail.includes("no read permission bits"))).toBe(true);
      expect(result.exit).not.toBe(0);
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("resolves symlinks to their forbidden source layer", () => {
    const f = fixture({ "src/foundation/link.ts": "", "src/foundation/value.ts": 'import "./link.js";' });
    rmSync(resolve(f.root, "src/foundation/link.ts"));
    symlinkSync("../frontend/parser.ts", resolve(f.root, "src/foundation/link.ts"));
    const result = f.run();
    expect(result.exit).not.toBe(0);
    expect(result.report.forbiddenEdges).toContainEqual(expect.objectContaining({ to: "src/frontend/parser.ts" }));
    expect(result.report.counts.total).toBe(3);
  });

  it("reports planned empty layers as pending and fails the default check", () => {
    const f = fixture();
    f.policy.layers.push({
      id: "backend",
      status: "planned",
      roots: ["src/backend"],
      entries: ["src/backend/program.ts"],
      minModules: 1,
      required: true,
    });
    f.policy.allowedEdges.backend = [];
    const result = f.run("inventory");
    expect(result.exit).toBe(0);
    expect(result.report.status).toBe("inventory-valid-architecture-incomplete");
    expect(result.report.plannedEmptyLayers).toContainEqual(expect.objectContaining({ layer: "backend", empty: true }));
    expect(f.run().exit).not.toBe(0);
  });

  function dataKeyFixture() {
    // Exercise the real key and production activation policy with stub model
    // inputs. This is not a proof of the complete canonical model closure.
    const policy = JSON.parse(readFileSync(resolve(repository, "scripts/compiler-boundaries.json"), "utf8"));
    const paths = [
      "src/wasm/model/instructions.ts",
      "src/wasm/physical/function-handles.ts",
      "src/wasm/physical/data-fields-key.ts",
    ];
    const f = fixture({
      [paths[0]!]: "export type ValType = { kind: string; typeIdx?: number; boolean?: boolean; symbol?: boolean };",
      [paths[1]!]: "export const STABLE_FUNC_BASE = 1;",
      [paths[2]!]: readFileSync(resolve(repository, paths[2]!), "utf8"),
    });
    f.policy.files = f.policy.files.filter((entry: any) => !paths.includes(entry.path));
    for (const id of ["wasm-model", "wasm-physical", "mixed-needs-split"]) {
      f.policy.layers.push(policy.layers.find((layer: any) => layer.id === id));
      f.policy.allowedEdges[id] = policy.allowedEdges[id] ?? [];
    }
    for (const path of paths) f.policy.files.push(policy.files.find((entry: any) => entry.path === path));
    f.policy.activationHistory = policy.activationHistory.filter((entry: any) => entry.layer === "wasm-physical");
    return f;
  }

  it("cannot erase the data key by also lowering the current physical requirement", () => {
    const f = dataKeyFixture();
    expect(f.run("inventory").exit).toBe(0);
    rmSync(resolve(f.root, "src/wasm/physical/data-fields-key.ts"));
    f.policy.files = f.policy.files.filter((entry: any) => entry.path !== "src/wasm/physical/data-fields-key.ts");
    const physical = f.policy.layers.find((layer: any) => layer.id === "wasm-physical");
    physical.entries = ["src/wasm/physical/function-handles.ts"];
    physical.minModules = 1;
    expect(codes(f.run("inventory"))).toContain("activation-demoted");
  });

  it("requires the actual physical data key as an activated entry", () => {
    const f = dataKeyFixture();
    const result = f.run("inventory");
    expect(result.exit).toBe(0);
    expect(result.report.activatedRoots).toContainEqual(
      expect.objectContaining({
        layer: "wasm-physical",
        modules: 2,
        visitedEntries: expect.arrayContaining(["src/wasm/physical/data-fields-key.ts"]),
      }),
    );
    rmSync(resolve(f.root, "src/wasm/physical/data-fields-key.ts"));
    f.policy.files = f.policy.files.filter((entry: any) => entry.path !== "src/wasm/physical/data-fields-key.ts");
    expect(codes(f.run("inventory"))).toContain("missing-activated-root");
  });

  it.each(["src/ir/types.ts", "src/codegen/context/types.ts"])(
    "rejects a physical data key dependency on %s",
    (path) => {
      const f = dataKeyFixture();
      expect(f.run("inventory").exit).toBe(0);
      f.put(path, "export type Forbidden = number;");
      f.policy.files.push({
        path,
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-model",
        owner: "test",
        nextBoundary: "Forbidden upper-layer fixture.",
      });
      const key = "src/wasm/physical/data-fields-key.ts";
      f.put(
        key,
        readFileSync(resolve(repository, key), "utf8") +
          `\nimport type { Forbidden } from "../../${path.slice(4).replace(/\.ts$/, ".js")}";\n`,
      );
      const result = f.run("inventory");
      expect(result.exit).not.toBe(0);
      expect(result.report.forbiddenEdges).toContainEqual(
        expect.objectContaining({ from: key, to: path, typeOnly: true }),
      );
    },
  );

  it("cannot shrink an activated root by deleting its source and classification", () => {
    const f = fixture();
    rmSync(resolve(f.root, "src/foundation/value.ts"));
    f.policy.files.shift();
    expect(codes(f.run("inventory"))).toContain("missing-activated-root");
  });

  it("cannot demote activation recorded in policy history", () => {
    const f = fixture();
    f.policy.activationHistory = [{ layer: "foundation", entries: ["src/foundation/value.ts"], minModules: 1 }];
    f.policy.layers[0].status = "planned";
    f.policy.files[0].state = "unmigrated";
    expect(codes(f.run())).toContain("activation-demoted");
  });

  it("rejects committed demotion and erased history against an independently pinned base", () => {
    const f = fixture();
    f.policy.activationHistory = [{ layer: "foundation", entries: ["src/foundation/value.ts"], minModules: 1 }];
    const commit = history(f);
    const base = commit();
    f.policy.activationHistory = [];
    f.policy.layers.forEach((layer: any) => {
      layer.status = "planned";
    });
    f.policy.files.forEach((entry: any) => {
      entry.state = "unmigrated";
    });
    const head = commit();
    expect(f.run("inventory").exit).toBe(0); // HEAD alone cannot attest to the prior activation.
    const result = f.run("inventory", true, "HEAD^1");
    expect(result.exit).not.toBe(0);
    expect(codes(result)).toContain("activation-demoted");
    expect(result.report.sourceRevision).toBe(head);
    expect(result.report.comparisonBase).toMatchObject({ requested: "HEAD^1", revision: base, policyPresent: true });
  });

  it("rejects committed removal of held evidence against the earlier policy", () => {
    const f = fixture();
    f.policy.evidence = JSON.parse(
      readFileSync(resolve(repository, "scripts/compiler-boundaries.json"), "utf8"),
    ).evidence;
    const commit = history(f);
    const base = commit();
    f.policy.evidence = [];
    commit();
    const result = f.run("inventory", true, base);
    expect(result.exit).not.toBe(0);
    expect(codes(result)).toContain("evidence-denominator-changed");
    expect(result.report.comparisonBase.policyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("distinguishes a verified initial introduction from an unreadable or missing base", () => {
    const f = fixture();
    const commit = history(f);
    const emptyBase = commit(null);
    const introduction = f.run("inventory", true, emptyBase);
    expect(introduction.exit).toBe(0);
    expect(introduction.report.comparisonBase).toMatchObject({ revision: emptyBase, policyPresent: false });
    const missing = f.run("inventory", true, "nonexistent-boundary-base");
    expect(missing.exit).not.toBe(0);
    expect(codes(missing)).toContain("comparison-base");
    const corruptBase = commit("{invalid historical policy");
    const corrupt = f.run("inventory", true, corruptBase);
    expect(corrupt.exit).not.toBe(0);
    expect(codes(corrupt)).toContain("previous-policy");
    expect(corrupt.report.comparisonBase.policyPresent).toBe(true);
  });

  it("ignores inherited GIT_DIR, worktree and index when reading fixture provenance", () => {
    const target = fixture();
    const targetHead = history(target)();
    const decoy = fixture();
    decoy.policy.description = "A different temporary repository, never the real project.";
    const decoyHead = history(decoy)();
    expect(decoyHead).not.toBe(targetHead);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    execFileSync("git", ["-C", decoy.root, "add", "src"], { env });
    const decoyIndex = resolve(decoy.root, ".git/index");
    const before = readFileSync(decoyIndex);
    const result = target.run("inventory", true, "HEAD", {
      GIT_DIR: resolve(decoy.root, ".git"),
      GIT_WORK_TREE: decoy.root,
      GIT_INDEX_FILE: decoyIndex,
    });
    expect(result.exit).toBe(0);
    expect(result.report.sourceRevision).toBe(targetHead);
    expect(result.report.comparisonBase.revision).toBe(targetHead);
    expect(result.report.counts).toMatchObject({ tracked: 0, untracked: 2 });
    expect(readFileSync(decoyIndex).equals(before)).toBe(true);
  });

  it("tracks current source including untracked modules and fingerprints dirty content", () => {
    const f = fixture();
    // Hook subprocesses can inherit GIT_DIR/GIT_INDEX_FILE from the real repo.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    execFileSync("git", ["init", "-q", f.root], { env });
    execFileSync("git", ["-C", f.root, "add", "src/foundation/value.ts"], { env });
    const before = f.run();
    expect(before.report.counts).toMatchObject({ tracked: 1, untracked: 1 });
    f.put("src/foundation/value.ts", "export type Value = string;");
    expect(f.run().report.dirtyContentFingerprint).not.toBe(before.report.dirtyContentFingerprint);
  });

  it("requires explicit nonmodule rationale and never excludes declarations", () => {
    const f = fixture();
    f.put("src/README.md", "documentation");
    expect(codes(f.run())).toContain("unclassified-nonmodule");
    f.policy.nonModules.push({ path: "src/README.md", reason: "Documentation only." });
    expect(f.run().report.counts.excludedNonModules).toBe(1);
    f.policy.nonModules.push({ path: "src/foundation/value.ts", reason: "Attempted exclusion" });
    expect(codes(f.run())).toContain("module-exclusion");
  });

  it("preserves all ten held B findings across moves, dummy callers and removed exports", () => {
    const manifest = JSON.parse(readFileSync(resolve(repository, "scripts/compiler-boundaries.json"), "utf8"));
    expect(manifest.evidence[0].expectedCount).toBe(10);
    expect(manifest.evidence[0].symbols).toHaveLength(10);
    expect(manifest.evidence[0].symbols.filter((symbol: any) => symbol.symbol === "sameType")).toHaveLength(2);
    const f = fixture();
    f.policy.evidence = structuredClone(manifest.evidence);
    f.policy.moves = structuredClone(manifest.moves);
    const absent = f.run("inventory");
    expect(absent.exit).toBe(0);
    expect(absent.report.evidence[0]).toMatchObject({ accounted: 10, resolved: 0 });
    expect(absent.report.evidence[0].symbols.every((symbol: any) => symbol.status === "external-unbound")).toBe(true);
    for (const move of manifest.moves.slice(0, 2)) {
      const symbols = manifest.evidence[0].symbols.filter((item: any) => item.originalPath === move.from);
      f.put(
        move.to,
        symbols.map((item: any) => `function ${item.symbol}() { return 1; }`).join("\n") + "\nsameType();",
      );
      f.policy.files.push({ path: move.to, layer: "frontend-ts", state: "unmigrated" });
    }
    const moved = f.run("inventory");
    expect(moved.exit).toBe(0);
    expect(moved.report.evidence[0]).toMatchObject({ accounted: 10, resolved: 0 });
    expect(moved.report.evidence[0].symbols.every((symbol: any) => symbol.status === "bound-unresolved")).toBe(true);
    expect(f.run().exit).not.toBe(0);
    f.put(manifest.moves[0].to, "export {};");
    expect(codes(f.run("inventory"))).toContain("evidence-symbol-missing");
    f.policy.evidence[0].status = "resolved";
    expect(codes(f.run("inventory"))).toContain("evidence-policy");
  });
});
