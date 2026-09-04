// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The runtime-eval global mirror must not take a name away from the program.
//
// When a module needs the runtime-eval global environment, the push helper
// mirrors every top-level binding onto the global object. It chose the
// descriptor attributes with
//
//     const attributes = isScriptBinding ? 0x23 : 0x05;
//
// where `0x23` specifies exactly one thing — `configurable: false`. That is
// §9.1.1.4.16 CreateGlobalFunctionBinding's rule for a SCRIPT. A module's
// top-level function/var bindings are not global-object properties at all, so
// applying it there is not the spec attribute but a fabricated one, and it
// makes the program's own define throw:
//
//     function beforeEach(body) { … }
//     Object.defineProperty(globalThis, "beforeEach", { configurable: true, … });
//     // → TypeError: Cannot redefine property: beforeEach
//
// The throw happens inside `__module_init`, so NOTHING in the module runs.
// The upstream-suite shim installs its four vitest hooks in exactly that
// shape; axios' `tests/unit/core/mergeConfig.test.js` was 0/57 for this alone,
// and the package went 108/231 → 190/231.
//
// TWO things are load-bearing in every fixture below:
//
//   1. An INDIRECT eval (`const e = eval; e(…)`). Only that shape makes the
//      compiler emit `__runtime_eval_push_globals` — a direct `eval("1")`,
//      `new Function(…)` and a member-call eval all leave the mirror out
//      entirely, and the fixture then cannot exercise this at all.
//   2. The eval consumer must come BEFORE the program's own define. The
//      mirror runs where the consumer is; if the program defines first, the
//      mirror merely downgrades an already-configurable property and nothing
//      throws. axios reaches the throwing order because the shim's hooks are
//      installed well after the first eval consumer.
//
// Every fixture also uses a UNIQUE global name, including for its exported
// entry point: the mirror writes into the one real `globalThis` shared by the
// whole vitest process, so a shared name would make each test depend on the
// order the others ran in.
//
// `undefined` / `NaN` / `Infinity` are the §19.1 immutable global properties:
// non-writable AND non-configurable, so a mirror that specifies `configurable`
// throws on them too. `var undefined;` at module scope is a common idiom in
// published packages (axios reaches it through `get-intrinsic`), so those three
// names keep the pre-existing spelling — the fix's carve-out is what lets axios
// past them, and dropping the carve-out reintroduces a throw on `undefined`.
//
// NOT covered here: `var undefined;` in a module with an indirect eval throws
// `Cannot redefine property: undefined` on the PARENT commit too, for a reason
// that predates this change (the mirrored value is not yet SameValue with the
// existing global when the define runs). That shape is a separate defect; the
// carve-out keeps it exactly as it was rather than making it worse.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

let unique = 0;

/**
 * Compile `body(tag)` as an untyped module whose entry point is `run<tag>`, and
 * return what it answers. `tag` makes every global this fixture publishes
 * unique across the process.
 */
async function runModule(body: (tag: string) => string): Promise<unknown> {
  const tag = `x${++unique}`;
  const root = mkdtempSync(join(tmpdir(), "js2-eval-mirror-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  // The indirect eval goes FIRST — see the header.
  writeFileSync(join(root, "mod.js"), `const ev${tag} = eval;\nev${tag}("1");\n${body(tag)}`);
  writeFileSync(
    join(root, "entry.ts"),
    `import { run${tag} } from "./mod.js";\nexport function test(): any { return (run${tag} as unknown as () => unknown)(); }`,
  );
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("runtime-eval global mirror in a module", () => {
  it("lets the program redefine a global named like a top-level function", async () => {
    // The shim shape verbatim. On the parent commit the define throws inside
    // `__module_init`, so the entry point is never reached — reaching it is
    // the assertion.
    expect(
      await runModule(
        (t) => `function hook${t}(body) { return body; }
Object.defineProperty(globalThis, "hook${t}", {
  configurable: true,
  writable: true,
  value: function (body) { return "W" + body; },
});
export function run${t}() { return "init-ok"; }`,
      ),
    ).toBe("init-ok");
  });

  it("lets the program redefine several hook names at once", async () => {
    expect(
      await runModule(
        (t) => `function beforeEach${t}(b) { return b; }
function afterEach${t}(b) { return b; }
Object.defineProperty(globalThis, "beforeEach${t}", { configurable: true, writable: true, value: function (b) { return b; } });
Object.defineProperty(globalThis, "afterEach${t}", { configurable: true, writable: true, value: function (b) { return b; } });
export function run${t}() { return "init-ok"; }`,
      ),
    ).toBe("init-ok");
  });

  it("lets the program redefine a global named like a top-level var", async () => {
    expect(
      await runModule(
        (t) => `var slot${t} = 1;
Object.defineProperty(globalThis, "slot${t}", { configurable: true, writable: true, value: 9 });
export function run${t}() { return "init-ok"; }`,
      ),
    ).toBe("init-ok");
  });

  // Guard — the mirror still has to do its job.
  it("still exposes a top-level function binding to eval", async () => {
    expect(
      await runModule(
        (t) => `function seen${t}() { return "seen"; }
export function run${t}() { const e = eval; return String(e("seen${t}()")); }`,
      ),
    ).toBe("seen");
  });
});
