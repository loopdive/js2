// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5351 — standalone/wasi: a lib.dom ambient `declare function` (`toString`,
 * `blur`, `focus`, …) shadows the script's own top-level binding and leaks an
 * `env::<name>` host import.
 *
 * Mechanism (measured 2026-09-05/06): `src/checker/index.ts` loads the full
 * default lib with no `lib:` restriction, so `node_modules/typescript/lib/
 * lib.dom.d.ts` declares `declare function toString(): string;` (and `blur`,
 * `focus`, …) as GLOBAL ambient functions. A test262-style SCRIPT (no
 * import/export — the corpus never uses modules) that does
 * `var toString = String.prototype.toString;` at top level puts that `var` in
 * the SAME global scope as the ambient declaration. A later use like
 * `toString.call(x)` then resolves — by a mechanism this issue does not need
 * to fully unwind — to a symbol whose declarations include the ambient lib
 * decl, and `collectReferencedGlobalNames` (`src/codegen/extern-declarations.ts`)
 * registers `toString` as lib-referenced, which `collectExternDeclarations`
 * turns into a host import `env::toString` under `--target standalone` or
 * `--target wasi` (only those two targets pass `libRefs` at all — the js-host
 * target is unaffected by construction).
 *
 * Renaming the binding, or wrapping the same code in a MODULE (adding any
 * `export`), avoids the collision — module-scope `var` is not global scope —
 * which is why this needs a script-shaped repro, not a `compile()` default.
 *
 * Sharp edge (not fixed here, recorded per the issue's implementation plan):
 * the checker still types the shadowed binding using the LIB signature
 * (`() => string` for `toString`), not the user's actual value type. Codegen
 * tolerates this for the 24 real test262 rows this issue targets (all compile
 * clean), but a binding whose lib-declared arity/shape differs from the
 * user's actual value could in principle mis-lower a call. The deeper fix —
 * restricting `lib:` in `src/checker/index.ts` and removing the DOM ambient
 * surface entirely — is a separate, wider issue.
 */
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.ts";

/** Extract `env` import names from WAT (mirrors tests/issue-2961.test.ts). */
function envImportNames(wat: string): string[] {
  const out: string[] = [];
  const re = /\(import\s+"env"\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wat)) !== null) out.push(m[1]!);
  return out;
}

async function compileScript(body: string, target: "standalone" | "wasi") {
  return compile(body, {
    allowJs: true,
    fileName: "probe.js",
    skipSemanticDiagnostics: true,
    target,
    deferTopLevelInit: true,
  });
}

// Script-shaped (no import/export) repros — this is what puts the `var` in
// GLOBAL scope alongside the lib.dom ambient decl. `Object.prototype.<name>`
// stands in for `blur`/`focus`, which have no natural namesake method but
// reproduce the identical mechanism (measured): the RHS need only be a
// PropertyAccessExpression, so the checker resolves the declaration's type
// through a lib interface member rather than a plain function-expression type.
const TOSTRING_SHADOW_SRC = `var toString = String.prototype.toString;\ntoString.call([]);\n`;
const BLUR_SHADOW_SRC = `var blur = Object.prototype.blur;\nblur.call({});\n`;
const FOCUS_SHADOW_SRC = `var focus = Object.prototype.focus;\nfocus.call({});\n`;
// Control: a genuinely NOT-shadowed global reference (no user-bound `parseInt`
// anywhere) — the fix must not touch this at all.
const PARSEINT_UNSHADOWED_SRC = `parseInt("42", 10);\n`;

describe("#5351 — lib.dom ambient declare function no longer shadows a user top-level binding", () => {
  describe("standalone", () => {
    it("toString: shadowed by `var toString = String.prototype.toString` emits ZERO env imports", async () => {
      const r = await compileScript(TOSTRING_SHADOW_SRC, "standalone");
      expect(r.success).toBe(true);
      expect(r.imports).toEqual([]);
      expect(envImportNames(r.wat)).toEqual([]);
    });

    it("blur: shadowed by `var blur = Object.prototype.blur` emits ZERO env imports", async () => {
      const r = await compileScript(BLUR_SHADOW_SRC, "standalone");
      expect(r.success).toBe(true);
      expect(r.imports).toEqual([]);
    });

    it("focus: shadowed by `var focus = Object.prototype.focus` emits ZERO env imports", async () => {
      const r = await compileScript(FOCUS_SHADOW_SRC, "standalone");
      expect(r.success).toBe(true);
      expect(r.imports).toEqual([]);
    });

    it("parseInt: NOT shadowed anywhere — import table is unaffected by the fix (measured: empty before and after, parseInt is native in standalone)", async () => {
      const r = await compileScript(PARSEINT_UNSHADOWED_SRC, "standalone");
      expect(r.success).toBe(true);
      expect(r.imports).toEqual([]);
    });
  });

  describe("wasi (the other target that passes libRefs — index.ts:5343/10542)", () => {
    it("toString shadow is fixed identically under --target wasi", async () => {
      const r = await compileScript(TOSTRING_SHADOW_SRC, "wasi");
      expect(r.success).toBe(true);
      expect(r.imports).toEqual([]);
    });
  });

  // Review round 1 (2026-09-06) — the exclusion must be scoped PER SOURCE
  // FILE. `compileMulti` hands `collectReferencedGlobalNames` every user file
  // at once; a single flat set of bound names let a MODULE-local binding in
  // one file strip another file's genuine lib global. Measured on the
  // pre-fix tree: the `env::queueMicrotask` import vanished and `main()`
  // trapped on `unreachable` where node returns 1.
  describe("compileMulti — a module-local binding is scoped to its own file", () => {
    const HELPER_BINDS = {
      "/helper.ts": `var queueMicrotask = 1;\nexport function h(): number { return queueMicrotask; }\n`,
      "/main.ts": `import { h } from "./helper.ts";\nexport function main(): number { var o = Object.prototype; queueMicrotask(function () {}); return h(); }\n`,
    };
    const MAIN_BINDS = {
      "/helper.ts": `export function h(): number { return 1; }\n`,
      "/main.ts": `import { h } from "./helper.ts";\nvar queueMicrotask = 7;\nexport function main(): number { var o = Object.prototype; return h() + queueMicrotask; }\n`,
    };

    it("helper binds `queueMicrotask`, main uses the GLOBAL: import present and main() matches node (1)", async () => {
      const r = await compileMulti(HELPER_BINDS, "/main.ts", {
        skipSemanticDiagnostics: true,
        target: "standalone",
      });
      expect(r.success).toBe(true);
      expect((r.imports ?? []).map((i) => `${i.module}::${i.name}`)).toEqual(["env::queueMicrotask"]);
      let hostCalled = false;
      const inst = await WebAssembly.instantiate(r.binary, {
        env: {
          queueMicrotask: () => {
            hostCalled = true;
          },
        },
      });
      // node oracle for the same shape: `queueMicrotask(fn)` then `return 1`.
      expect((inst.instance.exports as { main: () => number }).main()).toBe(1);
      expect(hostCalled).toBe(true);
    });

    it("MAIN itself binds `queueMicrotask` at top level: no env import", async () => {
      const r = await compileMulti(MAIN_BINDS, "/main.ts", {
        skipSemanticDiagnostics: true,
        target: "standalone",
      });
      expect(r.success).toBe(true);
      expect(r.imports ?? []).toEqual([]);
    });
  });
});
