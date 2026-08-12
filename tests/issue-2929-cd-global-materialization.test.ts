// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2929 — buckets C + D of the EvalDeclarationInstantiation plan: eval-created
// GLOBAL var/function bindings must materialize as own properties of the realm
// global object, and CanDeclareGlobalVar/CanDeclareGlobalFunction must be able
// to refuse.
//
// These are the promoted forms of `.tmp/probe-cd-baseline.mts` and
// `.tmp/probe-provider-equiv.mts`. They are kept under #2929's name on purpose:
// `claim-issue.mjs --allocate` cannot reach GitHub from this sandbox, so no new
// issue id was reserved (hand-picking one is forbidden, #2531).
//
// The compiler-side change is a ROUTING predicate in `tryStaticEvalInline`:
// when a sloppy eval's VariableEnvironment is the GlobalEnvironmentRecord and
// its body declares vars/functions, the AOT constant-splice hands the call to
// the runtime-eval provider, whose interpreter already implements the whole of
// EvalDeclarationInstantiation (`prepareGlobalDeclarations`,
// `src/interp/eval-environment.ts`). So these assertions exercise the
// INTERPRETER tier and are skipped when it is not built — a refusal-tier run
// would report the documented TypeError, which is an instrument state, not a
// regression (#2928 E7).
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { CompilerPool } from "../scripts/compiler-pool.js";
import { selectCachedRuntimeEvalProvider } from "../scripts/runtime-eval-provider.mjs";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

function selectInterpreterTier(): { module: unknown; message: string } {
  const saved = process.env.JS2WASM_EVAL_ENGINE;
  process.env.JS2WASM_EVAL_ENGINE = "interpreter";
  try {
    return selectCachedRuntimeEvalProvider() as { module: unknown; message: string };
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_EVAL_ENGINE");
    else process.env.JS2WASM_EVAL_ENGINE = saved;
  }
}

// This suite specifies the kept native interpreter's declaration semantics,
// so it must never inherit the repository's QuickJS default (#4242).
const selection = selectInterpreterTier();
const INTERPRETER_TIER = typeof selection?.message === "string" && selection.message.startsWith("INTERPRETER");

let pool: CompilerPool;

beforeAll(async () => {
  pool = new CompilerPool(1, "unified");
  await pool.ready();
}, 120_000);

afterAll(() => {
  pool?.shutdown();
});

/**
 * Run a sloppy SCRIPT-goal source through the SAME faithful worker path the
 * test262 runner uses: wrap it as a `noStrict` test262 file, assemble the
 * original harness (so `assert*` exist), and execute it on the standalone
 * target. The body self-checks and throws on mismatch, so "ran without
 * throwing" IS the assertion.
 */
async function runScript(body: string, label: string): Promise<void> {
  const source = `/*---\ndescription: ${label}\nflags: [noStrict]\n---*/\n${body}`;
  const assembly = assembleOriginalHarness(source, parseMeta(source));
  const r = await pool.runTest(
    assembly.primary.source,
    {
      originalHarness: true,
      asyncTest: assembly.async,
      inferModuleStrictArguments: false,
      target: "standalone",
      label,
    },
    30_000,
  );
  expect(`${r.status}: ${r.error ?? ""}`.trim()).toBe("pass:");
}

describe.skipIf(!INTERPRETER_TIER)("#2929 bucket C — eval-created GLOBAL bindings become own properties", () => {
  it("tier announcement is the INTERPRETER provider", () => {
    expect(selection.message).toMatch(/^INTERPRETER \(key [0-9a-f]+/);
  });

  it("direct eval: a NEW global var is an own, fully-configurable property", async () => {
    await runScript(
      `eval('var cdVarNew;');
var d = Object.getOwnPropertyDescriptor(this, 'cdVarNew');
if (d === undefined) throw new Error('cdVarNew should be an own property');
if (d.value !== undefined) throw new Error('initial value must be undefined, got ' + d.value);
if (!d.writable || !d.enumerable || !d.configurable) throw new Error('eval D=true means w/e/c all true');
`,
      "cd/direct-var-new",
    );
  });

  it("direct eval: a NEW global function is instantiated BEFORE the body statements run", async () => {
    await runScript(
      `var initial = null;
eval('initial = f; function f() { return 33; }');
if (typeof initial !== 'function') throw new Error('function must be hoisted+instantiated, got ' + typeof initial);
if (initial() !== 33) throw new Error('wrong function');
var d = Object.getOwnPropertyDescriptor(this, 'f');
if (d === undefined) throw new Error('f should be an own property');
if (!d.configurable) throw new Error('an eval-created global function must be configurable');
`,
      "cd/direct-func-new",
    );
  });

  it("indirect eval: varEnv is the global record regardless of call site", async () => {
    await runScript(
      `(0,eval)('var cdIndirect = 7;');
var d = Object.getOwnPropertyDescriptor(this, 'cdIndirect');
if (d === undefined) throw new Error('cdIndirect should be an own property');
if (d.value !== 7) throw new Error('value should be 7, got ' + d.value);
if (!d.configurable) throw new Error('should be configurable');
`,
      "cd/indirect-var-new",
    );
  });

  it("an EXISTING script var keeps its non-configurable descriptor; only the value updates", async () => {
    // ScriptDeclarationInstantiation seeds script vars as configurable:false.
    // `prepareGlobalVarBinding` early-returns when the own property exists, so
    // the descriptor survives — deliberately NOT "fixed" to redefine.
    await runScript(
      `var cdExisting = 23;
var before = cdExisting;
eval('cdExisting = 45; var cdExisting;');
if (before !== 23) throw new Error('initial should be 23, got ' + before);
if (cdExisting !== 45) throw new Error('value should update to 45, got ' + cdExisting);
var d = Object.getOwnPropertyDescriptor(this, 'cdExisting');
if (d === undefined) throw new Error('cdExisting should be an own property');
if (d.configurable) throw new Error('a script var stays configurable:false across eval redeclaration');
`,
      "cd/existing",
    );
  });

  it("Annex B eval functions replace and call an existing primitive script var", async () => {
    // The provider already published both closures correctly: `typeof direct`
    // and `typeof indirect` read "function" after pull-sync. The pre-IR
    // primitive-callee guard nevertheless trusted the original numeric
    // initializers and emitted unconditional TypeErrors at both call sites.
    // These bindings are runtime-mutable, so their calls must reach the native
    // IsCallable dispatcher instead.
    await runScript(
      `var direct = 123;
eval('{ function direct() { return 41; } }');
if (typeof direct !== 'function') throw new Error('direct binding was not updated');
if (direct() !== 41) throw new Error('direct eval closure was not callable');

var indirect = 123;
(0,eval)('{ function indirect() { return 42; } }');
if (typeof indirect !== 'function') throw new Error('indirect binding was not updated');
if (indirect() !== 42) throw new Error('indirect eval closure was not callable');
`,
      "cd/annexb-existing-primitive-call",
    );
  });

  it("delete of an eval-created global severs the compiled read path", async () => {
    // No static storage was ever allocated for the name, so the AOT read is the
    // HasProperty-guarded dynamic global read — removing the property makes it
    // throw ReferenceError, both ways by construction.
    await runScript(
      `eval('var cdDeletable = 5;');
if (cdDeletable !== 5) throw new Error('should read 5, got ' + cdDeletable);
if (!delete this.cdDeletable) throw new Error('delete should succeed (configurable:true)');
var threw = false;
try { cdDeletable; } catch (e) { threw = (e instanceof ReferenceError); }
if (!threw) throw new Error('a deleted eval-created global must throw ReferenceError on read');
`,
      "cd/delete-severs",
    );
  });

  it("eval('x = 1') with no declaration keeps splicing and still assigns", async () => {
    // varNames is empty, so the routing predicate does not fire. Pinned because
    // the predicate keying on declarations (not assignments) is load-bearing.
    await runScript(
      `var cdAssigned = 0;
eval('cdAssigned = 1;');
if (cdAssigned !== 1) throw new Error('assignment-only eval should still work, got ' + cdAssigned);
`,
      "cd/assign-only",
    );
  });
});

describe.skipIf(!INTERPRETER_TIER)("#2929 bucket D — CanDeclareGlobalVar/Function can refuse", () => {
  it("a non-extensible global makes a new eval var a TypeError (direct)", async () => {
    await runScript(
      `var nonExtensible;
try { Object.preventExtensions(this); nonExtensible = !Object.isExtensible(this); } catch (e) { nonExtensible = false; }
if (!nonExtensible) throw new Error('preventExtensions(this) must work for this test to mean anything');
var error;
try { eval('var unlikelyVariableName'); } catch (e) { error = e; }
if (!(error instanceof TypeError)) throw new Error('expected TypeError, got ' + error);
`,
      "d/direct-var",
    );
  });

  it("a non-extensible global makes a new eval var a TypeError (indirect)", async () => {
    await runScript(
      `Object.preventExtensions(this);
var error;
try { (0,eval)('var unlikelyVariableName'); } catch (e) { error = e; }
if (!(error instanceof TypeError)) throw new Error('expected TypeError, got ' + error);
`,
      "d/indirect-var",
    );
  });

  it("indirect eval of a function declaration onto a non-extensible global throws TypeError", async () => {
    await runScript(
      `Object.preventExtensions(this);
var error;
try { (0,eval)('function unlikelyFunctionName() {}'); } catch (e) { error = e; }
if (!(error instanceof TypeError)) throw new Error('expected TypeError, got ' + error);
`,
      "d/indirect-func",
    );
  });
});

describe.skipIf(!INTERPRETER_TIER)("#2929 — realm gap that buckets C+D do NOT close", () => {
  it("NaN is not an own property of the standalone global (why non-definable-global-function still fails)", async () => {
    // test262 `direct/non-definable-global-{function,generator}` eval
    // "function NaN(){}" and expect CanDeclareGlobalFunction to refuse because
    // NaN is an existing {w:false,e:false,c:false} own property of the realm
    // global. In standalone it is not a global own property at all, so the
    // check correctly returns true and no TypeError is raised. That is a
    // realm-POPULATION gap (#4205 G2 neighbourhood), not an eval-routing gap —
    // pinned here so the next reader does not re-diagnose it as a routing bug.
    await runScript(
      `if (Object.prototype.hasOwnProperty.call(this, 'NaN')) {
  throw new Error('NaN IS now a global own property — revisit the two non-definable-global-function/generator files');
}
`,
      "gap/nan-not-own",
    );
  });
});
