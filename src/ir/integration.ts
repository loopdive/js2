// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Integration point between the legacy codegen pipeline and the IR path.
//
// `compileIrPathFunctions` runs after `compileDeclarations`. It now runs in
// three explicit phases — driven by spec #1167b, which added module-scope
// inlining that requires seeing every IR function at once before any of
// them lower to Wasm:
//
//   1. Build — lower every selected AST function to an `IrFunction` and
//      collect them into an `IrModule`.
//   2. Pass — run per-function hygiene (CF → DCE → simplifyCFG), then
//      module-scope inlining (`inlineSmall`), then re-run hygiene on any
//      modified function. Each stage verifies.
//   3. Lower — replace each selected function's entry in `ctx.mod.functions`
//      with the Wasm body produced by `lowerIrFunctionToWasm`, keeping the
//      pre-allocated funcIdx/typeIdx/export state intact so the legacy
//      late-repair passes see a consistent module.
//
// Because the IR lowerer resolves IrFuncRef/IrGlobalRef symbols at this
// integration point (AFTER all imports have been registered), the legacy
// `shiftLateImportIndices` pass is a no-op for every body produced here.
// That's the whole point of the symbolic-ref design — spec #1131 §1.2.

import { ts } from "../ts-api.js";

import { ensureAnyHelpers, ensureAnyValueType } from "../codegen/any-helpers.js"; // (#2949) boxed-any carrier for IrType.dynamic
import { ensureDynMemberGet } from "../codegen/dyn-read.js"; // (#3053 U1) unified dynamic-reader carrier primitive __dyn_member_get
import { ensureLateImport, flushLateImportShifts } from "../codegen/shared.js"; // (#2949 S5.2) host __host_eq / __host_loose_eq registration; (#3143) flush the __extern_is_undefined batch pre-Phase-3
import { getOrRegisterPromiseType } from "../codegen/async-scheduler.js";
import {
  addGeneratorImports,
  addIteratorImports,
  addStringImports,
  addUnionImports, // (#2949 slice 3) host-mode dynamic op imports (__box_number/__typeof_* family)
  TYPED_ARRAY_NAMES,
} from "../codegen/index.js";
import { boxToAny } from "../codegen/value-tags.js"; // (#2949 slice 3) THE canonical boxing entry point (D4)
// (#2949 S5.1) THE canonical ToBoolean engine — one truthiness path for legacy and IR (D4).
import {
  emitToBoolean as emitCoercionToBoolean,
  emitToNumber as emitCoercionToNumber,
} from "../codegen/coercion-engine.js";
import { JsTag, jsTagUnboxKind } from "./js-tag.js";
import { ensureVecElemSet, VEC_ELEM_SET_PREFIX } from "../codegen/vec-elem-set.js"; // (#2856 C2) on-demand element-store helper
import { classMemberFuncKey } from "../codegen/class-member-keys.js"; // (#1983) collision-free class-member funcMap keys
import {
  ensureNativeStringHelpers,
  nativeStringLiteralInstrs,
  type StringEncoding,
} from "../codegen/native-strings.js";
import { addStringConstantGlobal, ensureExnTag } from "../codegen/registry/imports.js";
// (#2856) Console-variant parity with the legacy collectConsoleImports scan.
import { isBooleanType, isNumberType, isStringType } from "../checker/type-mapper.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
} from "../codegen/registry/types.js";
import type { CodegenContext, FunctionContext } from "../codegen/context/types.js";
import { applyIrTailCalls } from "../codegen/ir-tail-call.js";
import { ensureFmod, FMOD_FN } from "../codegen/fmod.js"; // #2945 — on-demand `%` helper materialization
// (#3156) — on-demand guarded charCodeAt helper materialization
import {
  ensureHostCharCodeAtGuarded,
  ensureNativeCharCodeAtHelper,
  JSSTR_CHARCODEAT_FN,
  NATIVE_CHARCODEAT_FN,
} from "../codegen/char-code-at-helpers.js";
import {
  IR_STRING_COMPARE_FN,
  lowerFunctionAstToIr,
  STRING_METHOD_TABLE,
  type IrFromAstResolver,
  type ModuleBindingGlobal,
} from "./from-ast.js";
import {
  lowerIrFunctionToWasm,
  lowerIrTypeToValType,
  type IrClassLowering,
  type IrClosureLowering,
  type IrDynamicLowering,
  type IrLowerResolver,
  type IrObjectStructLowering,
  type IrRefCellLowering,
  type IrUnionLowering,
} from "./lower.js";
import {
  forEachInstrDeep, // (#2949 slice 3) deep instr walk for preregisterDynamicSupport
  type IrClassShape,
  type IrClosureSignature,
  type IrFuncRef,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrModule,
  type IrObjectShape,
  type IrType,
  type IrTypeRef,
} from "./nodes.js";
import { analyzeEscape } from "./analysis/escape.js";
import { analyzeOwnership } from "./analysis/ownership.js";
import { constantFold } from "./passes/constant-fold.js";
import { deadCode } from "./passes/dead-code.js";
import { inlineSmall } from "./passes/inline-small.js";
import { monomorphize } from "./passes/monomorphize.js";
import { simplifyCFG } from "./passes/simplify-cfg.js";
import { UnionStructRegistry } from "./passes/tagged-union-types.js";
import { taggedUnions } from "./passes/tagged-unions.js";
import {
  collectModuleInitPopulation,
  makeModuleInitSynthetic,
  MODULE_INIT_UNIT_NAME,
  planIrCompilation,
  type IrSelection,
} from "./select.js";
import { verifyIrFunction } from "./verify.js";
import { AllocSiteRegistry, ALLOC_NAMESPACES } from "./alloc-registry.js";
import { analyzeEncoding } from "./analysis/encoding.js";
import { assertAllocProvenance } from "./verify-alloc.js";
import type { FieldDef, FuncTypeDef, Instr, StructTypeDef, ValType } from "./types.js";
import { definedFuncAt, replaceDefinedFuncAt } from "../codegen/func-space.js"; // (#1916 S2) positional read/write chokepoints

export interface IrIntegrationReport {
  readonly compiled: readonly string[];
  readonly errors: readonly IrIntegrationError[];
}

export interface IrIntegrationError {
  readonly func: string;
  readonly message: string;
  readonly kind?: "verify" | "build" | "lower" | "backend-legality";
}

/**
 * Per-function IR type overrides sourced from the Phase-2 propagation
 * pass. Indexed by function name. When present for a selected function,
 * these types are used in place of (or alongside) any explicit TS
 * annotations. They are also used to derive the `calleeTypes` map that
 * the AST→IR lowerer consults when lowering `CallExpression`.
 */
export interface IrTypeOverrideMap {
  // Slice 14 (#1228) — `returnType: IrType | null` where `null` means a
  // void-returning function (zero Wasm result types). Plumbs through to
  // `from-ast.ts` so the IR builder can be constructed with `[]` results.
  get(name: string): { readonly params: readonly IrType[]; readonly returnType: IrType | null } | undefined;
}

export function compileIrPathFunctions(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  selection?: IrSelection,
  overrides?: IrTypeOverrideMap,
  classShapes?: ReadonlyMap<string, IrClassShape>,
): IrIntegrationReport {
  const selected = selection ?? planIrCompilation(sourceFile, { experimentalIR: true });
  // (#3142 Slice 2) A claimable, non-empty module-init unit keeps the
  // pipeline alive even with no claimed functions/class members.
  const moduleInitClaim =
    selected.moduleInit && selected.moduleInit.reason === null && selected.moduleInit.stmtCount > 0
      ? selected.moduleInit
      : undefined;
  // #1370 Phase B: don't short-circuit when only class members are claimed —
  // a source file may declare a class with IR-eligible methods but no
  // top-level FunctionDeclarations.
  if (selected.funcs.size === 0 && (!selected.classMembers || selected.classMembers.size === 0) && !moduleInitClaim) {
    return { compiled: [], errors: [] };
  }

  // Build the calleeTypes map once — every IR-path function's lowerer
  // sees the same view, keyed by every selected function's propagated
  // signature. This is how cross-function calls keep their signatures
  // consistent on the IR side.
  const calleeTypes = new Map<string, { params: readonly IrType[]; returnType: IrType | null }>();
  if (overrides) {
    for (const name of selected.funcs) {
      const o = overrides.get(name);
      if (o) calleeTypes.set(name, { params: o.params, returnType: o.returnType });
    }
  }

  const compiled: string[] = [];
  const errors: IrIntegrationError[] = [];

  // #1586: one allocation-site registry per module compile. Threaded into the
  // builder (mints ids on value-creating instrs) and every pass (preserve /
  // fork / retire discipline). `alloc` ids are inert at lowering, so wiring the
  // registry does not change emitted Wasm.
  const allocRegistry = new AllocSiteRegistry();
  // #1588 PR-B: expose the registry on the context so the string-lowering
  // sites (literal / concat materialization) can read the `encoding`
  // annotation when `--utf8-storage` is on. Inert when off (sites never read).
  ctx.allocRegistry = allocRegistry;

  // Single shared union-struct registry across all IR-path functions in this
  // compilation. Registering a union once produces one WasmGC struct type;
  // subsequent `box`/`unbox`/`tag.test` uses from any function see the same
  // type index. The sink writes into `ctx.mod.types` directly so the
  // registered struct participates in the module's usual type emission.
  const unionRegistry = new UnionStructRegistry({
    push(def: StructTypeDef): number {
      const idx = ctx.mod.types.length;
      ctx.mod.types.push(def);
      return idx;
    },
  });

  // -------------------------------------------------------------------------
  // Phase 1 prep — From-ast resolver (#1185).
  //
  // The from-ast layer needs three resolver methods at build time:
  //   - `nativeStrings()` — drives the for-of strategy switch
  //   - `resolveString()` — slot ValType for string for-of
  //   - `resolveVec(valTy)` — element + array typeIdx for vec for-of
  //
  // None of these depend on the lazy registries (object / closure /
  // class) that get filled in during Phase 3, so we can build the
  // subset eagerly here. The full `IrLowerResolver` is built later in
  // Phase 3 once the registries exist; both share the same underlying
  // logic for the methods both expose.
  // -------------------------------------------------------------------------
  const fromAstResolver = makeFromAstResolver(ctx, sourceFile);

  // -------------------------------------------------------------------------
  // Phase 1 — Build: lower every selected AST function to an IrFunction.
  // -------------------------------------------------------------------------
  interface BuiltFn {
    readonly name: string;
    readonly fn: IrFunction;
    /**
     * Slice 3 (#1169c): set when `fn` is a lifted closure or nested
     * function rather than a top-level FunctionDeclaration. Synthesized
     * fns have no ts.FunctionDeclaration and no pre-allocated funcIdx —
     * the integration loop allocates a fresh slot in `ctx.mod.functions`
     * (mirrors the monomorphize-clone path).
     */
    readonly synthesized?: boolean;
    /**
     * #1370 Phase B: marks instance class methods. The legacy
     * `class-bodies.ts` already pre-allocated a typeIdx + signature for
     * the slot; before patching the body, the Phase 3 loop verifies the
     * IR-lowered typeIdx matches the existing one. On mismatch it skips
     * the patch — the legacy body stays in place, callers' `call $...`
     * ops keep working, and a warning is logged so the divergence is
     * visible. This guard is unnecessary for top-level FunctionDeclarations
     * where the slot's pre-allocated typeIdx is whatever the integration
     * lowerer chose (no legacy callers depending on it).
     */
    readonly classMember?: boolean;
    /**
     * (#3142 Slice 2) The synthetic `<module-init>` unit. Its target slot is
     * the legacy `__module_init` function (located by NAME at Phase 3 — it
     * is never in `ctx.funcMap`), patched in place with the same typeIdx
     * parity guard class members use. Never allocated a fresh slot.
     */
    readonly moduleInit?: boolean;
  }
  const built: BuiltFn[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(stmt)) continue;
    if (!stmt.name) continue;
    const name = stmt.name.text;
    if (!selected.funcs.has(name)) continue;

    try {
      // #1923 — test-only seam: simulate a build-time demotion on a CLAIMED
      // function so the post-claim metering + gate can be exercised without a
      // real compiler regression in the corpus. Off in every normal build.
      if (process.env.JS2WASM_TEST_INJECT_IR_BUILD_THROW) {
        throw new Error(`ir/from-ast: injected test build failure (${name})`);
      }
      const o = overrides?.get(name);
      const result = lowerFunctionAstToIr(stmt, {
        exported: hasExportModifier(stmt),
        paramTypeOverrides: o?.params,
        returnTypeOverride: o?.returnType,
        calleeTypes,
        classShapes,
        // Slice 6 part 4 refactor (#1185): thread the from-ast subset
        // of the IR resolver. Replaces the per-feature `nativeStrings:
        // boolean` + `anyStrTypeIdx: number` shortcuts that #1183 added.
        resolver: fromAstResolver,
        allocRegistry,
        // #2780 (hybrid Row 6): thread the TS checker so `lowerArrayLiteral`
        // can discharge the widening-escape proof via `getContextualType`.
        checker: ctx.checker,
      });
      const mainErrors = verifyIrFunction(result.main);
      if (mainErrors.length > 0) {
        for (const e of mainErrors) errors.push({ func: name, message: e.message, kind: "verify" });
        continue;
      }
      // Slice 3 (#1169c): verify each lifted function before pushing.
      let anyLiftedFailed = false;
      for (const lifted of result.lifted) {
        const liftedErrors = verifyIrFunction(lifted);
        if (liftedErrors.length > 0) {
          for (const e of liftedErrors) errors.push({ func: lifted.name, message: e.message, kind: "verify" });
          anyLiftedFailed = true;
        }
      }
      if (anyLiftedFailed) continue;

      built.push({ name, fn: result.main });
      for (const lifted of result.lifted) {
        built.push({ name: lifted.name, fn: lifted, synthesized: true });
      }
    } catch (e) {
      errors.push({ func: name, message: e instanceof Error ? e.message : String(e), kind: "build" });
    }
  }

  // -------------------------------------------------------------------------
  // #1370 Phase B — Build IR functions for class members claimed by the
  // selector. Mirrors the FunctionDeclaration loop above:
  //
  //   1. Walk class declarations from sourceFile.statements.
  //   2. Filter to MethodDeclarations whose synthetic name is in
  //      `selected.classMembers`.
  //   3. Currently restricted to NON-static instance methods. Static
  //      methods stay on legacy (no `self` injection complication; can
  //      be added in a follow-up). Constructors stay on legacy (Phase C
  //      handles their `struct.new + __self` epilogue).
  //   4. For each eligible method:
  //      - Look up the class's `IrClassShape` from the resolver-supplied
  //        `classShapes` map. Skip if absent (legacy class shape couldn't
  //        be projected — leave on legacy).
  //      - Call `lowerFunctionAstToIr(member, { funcName, selfParam: { type:
  //        IrType.class }, classShapes, resolver, calleeTypes })`. The
  //        widened lowerFunctionAstToIr (Phase B in from-ast.ts) injects
  //        a `__self` first param matching the legacy struct-ref slot.
  //      - Verify the IrFunction.
  //      - Push to `built` with `classMember: true`. The Phase 3 slot
  //        patch performs a typeIdx parity check before overwriting.
  // -------------------------------------------------------------------------
  if (selected.classMembers && selected.classMembers.size > 0) {
    for (const stmt of sourceFile.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
      const className = stmt.name.text;

      // #3000-E: `buildIrClassShapes` now seeds single-level subclasses of a
      // LOCAL user class (the shape carries `.parent`), so the wholesale
      // `extends`-skip that used to sit here is gone — the shape presence IS the
      // gate. A subclass of a builtin / externref-backed parent still gets NO
      // shape there, so the `if (!classShape) continue;` below keeps it on legacy;
      // the selector's `parentIsLocalClass` gate mirrors this exactly, so a
      // claimed subclass member always finds its shape (no post-claim demotion).
      const classShape = classShapes?.get(className);
      if (!classShape) continue;

      for (const member of stmt.members) {
        // Phase B v1 — instance methods + (#3000-B) instance get/set accessors
        // + (#3000-C) the constructor. Static members skip `self` injection and
        // use a different funcMap entry shape; defer. Abstract methods have no
        // body — Phase A already rejected them as `class-method`.
        const isCtorMember = ts.isConstructorDeclaration(member);
        const isAccessor = ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member);
        if (!ts.isMethodDeclaration(member) && !isAccessor && !isCtorMember) continue;
        // Non-ctor members: skip nameless / static / abstract. A constructor
        // carries no `.name`, is never static, and never abstract — so these
        // guards apply only to methods / accessors.
        if (!isCtorMember) {
          if (!member.name) continue;
          const isStatic = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false;
          if (isStatic) continue;
          if (member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)) continue;
        }

        // #3000-C: the constructor's synthetic funcMap key is `${className}_new`
        // (mirrors `class-bodies.ts`). Methods/accessors compute their key from
        // the member name below.
        let memberName: string;
        let returnTypeOverride: IrType | null | undefined;
        if (isCtorMember) {
          memberName = `${className}_new`;
        } else {
          // Phase A's `phase1MemberName` admits identifier / string-literal /
          // numeric-literal — replicate the dispatch here without re-importing
          // the helper (it's selector-private). The synthetic name format
          // mirrors `class-bodies.ts:275` exactly.
          let memberBaseName: string;
          if (ts.isIdentifier(member.name!)) memberBaseName = member.name!.text;
          else if (ts.isStringLiteral(member.name!) || ts.isNumericLiteral(member.name!)) {
            memberBaseName = member.name!.text;
          } else continue; // computed / private name — skipped by selector

          // #3000-B: accessors register under `${className}_get_${prop}` /
          // `${className}_set_${prop}` funcMap keys (see `class-bodies.ts`); a
          // setter is VOID (`returnTypeOverride: null`), a getter returns
          // `member.type` unchanged. Methods keep `${className}_${name}`.
          if (ts.isGetAccessorDeclaration(member)) {
            memberName = `${className}_get_${memberBaseName}`;
          } else if (ts.isSetAccessorDeclaration(member)) {
            memberName = `${className}_set_${memberBaseName}`;
            returnTypeOverride = null; // set accessor bodies return void
          } else {
            memberName = `${className}_${memberBaseName}`;
          }
        }
        if (!selected.classMembers.has(memberName)) continue;

        try {
          // #3000-C: a constructor is NOT passed `__self` — it allocates the
          // instance itself (`constructorClassShape` drives the `class.alloc` +
          // `return this` synthesis in from-ast). Methods/accessors get the
          // caller-supplied `selfParam` FIRST param instead.
          const result = lowerFunctionAstToIr(member, {
            exported: false, // class members are not directly exported
            funcName: memberName,
            ...(isCtorMember
              ? { constructorClassShape: classShape }
              : { selfParam: { type: { kind: "class", shape: classShape } as IrType }, returnTypeOverride }),
            calleeTypes,
            classShapes,
            resolver: fromAstResolver,
            allocRegistry,
            // #2780 (hybrid Row 6): thread the TS checker for the
            // ArrayLiteral widening-escape proof in method bodies too.
            checker: ctx.checker,
          });
          const mainErrors = verifyIrFunction(result.main);
          if (mainErrors.length > 0) {
            for (const e of mainErrors) errors.push({ func: memberName, message: e.message, kind: "verify" });
            continue;
          }
          // Class method bodies should not produce lifted closures in Phase B
          // (Phase 1 shape doesn't allow nested function decls inside method
          // bodies that capture `this`). Defensive re-verify if any appear.
          let anyLiftedFailed = false;
          for (const lifted of result.lifted) {
            const liftedErrors = verifyIrFunction(lifted);
            if (liftedErrors.length > 0) {
              for (const e of liftedErrors) errors.push({ func: lifted.name, message: e.message, kind: "verify" });
              anyLiftedFailed = true;
            }
          }
          if (anyLiftedFailed) continue;

          built.push({ name: memberName, fn: result.main, classMember: true });
          for (const lifted of result.lifted) {
            built.push({ name: lifted.name, fn: lifted, synthesized: true });
          }
        } catch (e) {
          errors.push({ func: memberName, message: e instanceof Error ? e.message : String(e), kind: "build" });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // (#3142 Slice 2) — Build the IR function for a claimable module-init unit.
  //
  // The unit lowers the SAME population the selector assessed
  // (`collectModuleInitPopulation`) through the ordinary from-ast path in
  // `moduleInitUnit` mode: statements lower as plain body statements
  // (constructor-body precedent) and top-level `let`/`const` bindings write
  // the legacy-allocated `__mod_<name>` globals via symbolic global refs, so
  // every other function observes exactly the storage legacy init wrote.
  //
  // Integration-time gates (each throws → the whole unit demotes to the
  // legacy body, which is ALWAYS still emitted — module-init is never in the
  // IR-first skip set):
  //   - the legacy `__module_init` slot must exist (legacy may drop
  //     side-effect-free statements and emit nothing — then there is nothing
  //     to patch and nothing to gain),
  //   - no static class initializers / live-func-binding seeds (legacy
  //     prepends those to the SAME body; replacing it would drop them),
  //   - every top-level binding must map to an f64/i32-backed module global
  //     (Slice 2 scope: numeric/boolean module state),
  //   - no direct top-level `throw` outside WASI (legacy DROPS those — see
  //     the #1789-adjacent collection note in declarations.ts; executing
  //     them would diverge from the legacy baseline).
  // -------------------------------------------------------------------------
  if (moduleInitClaim) {
    try {
      if (!ctx.mod.functions.some((f) => f.name === "__module_init")) {
        throw new Error("module-init: no legacy __module_init slot to patch (legacy collected no init statements)");
      }
      if (ctx.staticInitExprs.length > 0) {
        throw new Error("module-init: static class initializers present — legacy body carries them");
      }
      if ((ctx.liveFuncBindingGlobals?.size ?? 0) > 0) {
        throw new Error("module-init: live function-binding seeds present — legacy body carries them");
      }
      const population = collectModuleInitPopulation(sourceFile);
      if (!ctx.wasi) {
        for (const s of population) {
          if (ts.isThrowStatement(s)) {
            throw new Error("module-init: top-level throw is dropped by legacy outside WASI — keeping legacy body");
          }
        }
      }
      const moduleBindings = buildModuleBindingsMap(ctx, population);
      const synthetic = makeModuleInitSynthetic(population);
      const result = lowerFunctionAstToIr(synthetic, {
        exported: false,
        funcName: MODULE_INIT_UNIT_NAME,
        returnTypeOverride: null,
        moduleInitUnit: true,
        moduleBindings,
        calleeTypes,
        classShapes,
        resolver: fromAstResolver,
        allocRegistry,
        checker: ctx.checker,
      });
      const mainErrors = verifyIrFunction(result.main);
      if (mainErrors.length > 0) {
        for (const e of mainErrors) errors.push({ func: MODULE_INIT_UNIT_NAME, message: e.message, kind: "verify" });
      } else {
        let anyLiftedFailed = false;
        for (const lifted of result.lifted) {
          const liftedErrors = verifyIrFunction(lifted);
          if (liftedErrors.length > 0) {
            for (const e of liftedErrors) errors.push({ func: lifted.name, message: e.message, kind: "verify" });
            anyLiftedFailed = true;
          }
        }
        if (!anyLiftedFailed) {
          built.push({ name: MODULE_INIT_UNIT_NAME, fn: result.main, moduleInit: true });
          for (const lifted of result.lifted) {
            built.push({ name: lifted.name, fn: lifted, synthesized: true });
          }
        }
      }
    } catch (e) {
      errors.push({
        func: MODULE_INIT_UNIT_NAME,
        message: e instanceof Error ? e.message : String(e),
        kind: "build",
      });
    }
  }

  if (built.length === 0) return { compiled, errors };

  // -------------------------------------------------------------------------
  // Phase 2 — Pass: per-function hygiene → module-scope inline → re-run
  // hygiene on modified functions. Verify between stages.
  // -------------------------------------------------------------------------

  // 2a. Per-function hygiene (CF → DCE → simplifyCFG to fixpoint).
  const afterHygiene: BuiltFn[] = [];
  for (const entry of built) {
    const optimized = runHygienePasses(entry.fn, allocRegistry);
    const postErrors = verifyIrFunction(optimized);
    if (postErrors.length > 0) {
      for (const e of postErrors) {
        errors.push({ func: entry.name, message: `post-hygiene verify: ${e.message}`, kind: "verify" });
      }
      continue;
    }
    // #1586: alloc-provenance gate (debug-only). A pass that loses provenance
    // throws here at the same boundary that already catches malformed SSA.
    assertAllocProvenance(optimized, allocRegistry);
    afterHygiene.push({
      name: entry.name,
      fn: optimized,
      synthesized: entry.synthesized,
      classMember: entry.classMember,
      moduleInit: entry.moduleInit,
    });
  }

  if (afterHygiene.length === 0) return { compiled, errors };

  // #1588: string-encoding analysis. Read-only over the hygiene-stable IR;
  // writes `encoding` annotations onto string allocation sites in the
  // registry (`ALLOC_NAMESPACES.encoding`). Annotations are advisory and
  // inert at lowering, so the emitted Wasm is unchanged. Later passes
  // (inline/mono) preserve or alias the alloc ids, so an annotation written
  // here travels to the canonical site via the registry's alias merge.
  for (const entry of afterHygiene) {
    analyzeEncoding(entry.fn, allocRegistry);
  }

  // 2b. Module-scope inlining (#1167b).
  const modIn: IrModule = { functions: afterHygiene.map((e) => e.fn) };
  const modOut = inlineSmall(modIn, allocRegistry);

  // 2c. Re-run hygiene on functions the inline pass actually rewrote; verify.
  const afterInline: BuiltFn[] = [];
  for (let i = 0; i < afterHygiene.length; i++) {
    const before = afterHygiene[i]!;
    const after = modOut.functions[i]!;
    const changed = after !== before.fn;
    const final = changed ? runHygienePasses(after, allocRegistry) : after;
    const verifyErrors = verifyIrFunction(final);
    if (verifyErrors.length > 0) {
      for (const e of verifyErrors) {
        errors.push({ func: before.name, message: `post-inline verify: ${e.message}`, kind: "verify" });
      }
      continue;
    }
    assertAllocProvenance(final, allocRegistry);
    afterInline.push({
      name: before.name,
      fn: final,
      synthesized: before.synthesized,
      classMember: before.classMember,
      moduleInit: before.moduleInit,
    });
  }

  if (afterInline.length === 0) return { compiled, errors };

  // -------------------------------------------------------------------------
  // 2d. Monomorphize — specialize polymorphic callees across the module.
  // -------------------------------------------------------------------------
  // Clones live only in the IR — they have no ts.FunctionDeclaration and no
  // pre-allocated funcIdx from `compileDeclarations`. After monomorphize
  // produces clones, we allocate each a placeholder WasmFunction slot in
  // `ctx.mod.functions` and register it in `ctx.funcMap` so the Phase-3
  // lowerer's resolver can map the clone's `IrFuncRef` to a concrete index.
  // -------------------------------------------------------------------------
  const monoIn: IrModule = { functions: afterInline.map((e) => e.fn) };
  const monoResult = monomorphize(monoIn, allocRegistry);
  const originalNames = new Set<string>(afterInline.map((e) => e.name));

  // -------------------------------------------------------------------------
  // 2e. Tagged-union representation pass (identity in V1 — see
  // `passes/tagged-unions.ts` for the scope note). Structurally wired so
  // follow-up extension work lands in a purpose-built module.
  // -------------------------------------------------------------------------
  const modAfterTU = taggedUnions(monoResult.module);

  // -------------------------------------------------------------------------
  // 2f. Re-run hygiene on any function whose reference changed across the
  // mono + TU stages. Clones are fresh and well-formed; callers whose
  // call targets were rewritten may benefit from a second hygiene pass
  // (usually a no-op but cheap).
  // -------------------------------------------------------------------------
  const readyForLower: BuiltFn[] = [];
  const afterInlineByName = new Map<string, BuiltFn>();
  for (const e of afterInline) afterInlineByName.set(e.name, e);

  for (const fn of modAfterTU.functions) {
    const before = afterInlineByName.get(fn.name);
    const wasCloned = before === undefined;
    const changed = wasCloned || fn !== before.fn;
    const final = changed ? runHygienePasses(fn, allocRegistry) : fn;
    const verifyErrors = verifyIrFunction(final);
    if (verifyErrors.length > 0) {
      for (const e of verifyErrors) {
        errors.push({ func: fn.name, message: `post-mono verify: ${e.message}`, kind: "verify" });
      }
      continue;
    }
    assertAllocProvenance(final, allocRegistry);
    // Slice 3 (#1169c): clones from monomorphize don't have synthesized
    // info from the build phase; treat them as synthesized iff the
    // pre-mono entry was synthesized OR the function is brand-new (a
    // cloned specialization for a new param-type tuple).
    readyForLower.push({
      name: fn.name,
      fn: final,
      synthesized: before?.synthesized || wasCloned,
      classMember: before?.classMember,
      moduleInit: before?.moduleInit,
    });
  }

  if (readyForLower.length === 0) return { compiled, errors };

  // -------------------------------------------------------------------------
  // 2g. Ownership + access-semantics analysis (#1587) — gated, default OFF.
  //
  // Runs on the final (post-mono/TU) IR shape, writing inferred ownership /
  // access annotations to the registry `ownership` namespace. The analysis is
  // purely an optimization aid: it does NOT mutate the IR and registry
  // annotations are inert at lowering, so emitted Wasm is byte-identical
  // whether or not this runs (ADR-0014). Consumers query the per-function
  // `OwnershipResult` (the demonstration consumer in `analysis/stack-alloc.ts`
  // is likewise gated and annotation-only). Behind `JS2WASM_IR_OWNERSHIP=1`
  // for the rollout period.
  // -------------------------------------------------------------------------
  //
  // 2h. Escape analysis (#747) — gated, default OFF. When
  // `JS2WASM_IR_ESCAPE=1`, classifies each allocation
  // (local/returned/stored/captured/opaque) on top of the ownership result and
  // writes it to the registry `escape` namespace. Enabling escape implies
  // running ownership (its oracle). Both are inert — no IR mutation, byte-
  // identical Wasm — so scalar replacement / stack allocation stays a
  // follow-up consumer.
  const wantOwnership = ownershipAnalysisEnabled();
  const wantEscape = escapeAnalysisEnabled();
  if (wantOwnership || wantEscape) {
    for (const entry of readyForLower) {
      const ownershipResult = analyzeOwnership(entry.fn, allocRegistry);
      if (wantEscape) {
        analyzeEscape(entry.fn, allocRegistry, ownershipResult);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Register monomorphized clones in `ctx` — append a placeholder
  // WasmFunction slot and record the assigned funcIdx in `ctx.funcMap`.
  // The placeholder body is overwritten with the real lowered body in the
  // Phase-3 loop below.
  // -------------------------------------------------------------------------
  for (const entry of readyForLower) {
    // Top-level (non-synthesized) functions already have a funcIdx
    // allocated by `compileDeclarations`. Skip them.
    if (originalNames.has(entry.name) && !entry.synthesized) continue;
    // #1370 Phase B: class members have funcIdx pre-allocated by the
    // legacy `class-bodies.ts` pass (`ctorFuncIdx` / `methodFuncIdx`).
    // Don't allocate a new slot — Phase 3 will patch the existing one.
    if (entry.classMember) continue;
    // (#3142 Slice 2) The module-init unit patches the legacy
    // `__module_init` slot (located by name at Phase 3) — never a fresh one.
    if (entry.moduleInit) continue;
    if (ctx.funcMap.has(entry.name)) continue; // already registered (defensive)
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: entry.name,
      typeIdx: 0,
      locals: [],
      body: [],
      exported: false,
    });
    ctx.funcMap.set(entry.name, funcIdx);
  }

  // -------------------------------------------------------------------------
  // Phase 3 prep — Eagerly register string imports + literals BEFORE lowering.
  //
  // Rationale: `addStringImports` shifts existing function indices when called
  // late, and `addStringConstantGlobal` shifts global indices when called
  // after module globals exist. Both shift passes walk
  // `ctx.mod.functions[].body` AND `ctx.currentFunc.body`. They do NOT walk
  // the lowerer's local `out: Instr[]` buffer that holds the IR-lowered body
  // mid-emission. So if a `string.const` triggers `addStringConstantGlobal`
  // mid-emission, an earlier `global.get` we already pushed to `out` for this
  // function would carry a now-stale index.
  //
  // We avoid that race by pre-walking the IR BEFORE Phase 3 starts and
  // calling both registration helpers up front. Both are idempotent on
  // existing entries, so duplicate calls are safe and cheap.
  //
  // Native-strings mode bakes string globals inline as
  // `array.new_fixed`/`struct.new`, so it doesn't need the import shifting
  // machinery — but we still walk the IR for symmetry and to keep the
  // resolver path uniform.
  // -------------------------------------------------------------------------
  preregisterStringSupport(ctx, readyForLower);

  // -------------------------------------------------------------------------
  // Slice 6 part 3 (#1182) — iterator host imports.
  //
  // Walk every IR function for any `iter.*` / `forof.iter` / coercion-to-
  // externref instruction; if found, call `addIteratorImports(ctx)` so the
  // resolver can map `__iterator` / `__iterator_next` / `__iterator_done` /
  // `__iterator_value` / `__iterator_return` to concrete funcIdx values
  // BEFORE Phase 3 resolves IrFuncRef symbols. This pre-registration
  // matches `preregisterStringSupport`'s rationale.
  // -------------------------------------------------------------------------
  preregisterIteratorSupport(ctx, readyForLower);

  // -------------------------------------------------------------------------
  // Slice 7a (#1169f) — pre-register generator host imports if any IR
  // function will emit `gen.push` / `gen.epilogue`. Same rationale as
  // the string + iterator pre-registration above: late-import shifting
  // is expensive and can invalidate the lowerer's local op buffer if
  // it fires mid-emission. `addGeneratorImports` is idempotent on
  // `ctx.funcMap` membership, so the legacy-source detection at
  // `codegen/index.ts:4031` (which fires whenever the source contains
  // any `function*`) makes this call a no-op in practice — but the
  // call here is the supported entry point for IR-only test fixtures
  // that don't trigger legacy detection (e.g. an IR test that
  // synthesises a generator without the AST scan running).
  // -------------------------------------------------------------------------
  if (readyForLower.some((e) => e.fn.funcKind === "generator")) {
    addGeneratorImports(ctx);
  }
  // -------------------------------------------------------------------------
  // Slice 6 part 4 (#1183) — native-string helpers (notably __str_charAt).
  //
  // Walk every IR function for any `forof.string` instr; if found, call
  // `ensureNativeStringHelpers(ctx)` so `__str_charAt` (and the rest of
  // the native-string helper family) is registered before the lowerer
  // resolves the funcref. The helper itself is idempotent, but calling
  // it eagerly avoids late-import shifts during Phase 3 emission.
  // -------------------------------------------------------------------------
  preregisterNativeStringHelpers(ctx, readyForLower);

  // -------------------------------------------------------------------------
  // Slice 9 (#1169h) — pre-register the shared `__exn` exception tag if
  // any IR function emits `throw` or `try`. The tag itself doesn't
  // shift function indices (it lives in `ctx.mod.tags`), but
  // pre-registering here keeps the resolver path uniform and matches
  // the pattern used for other lazy registrations.
  // -------------------------------------------------------------------------
  preregisterExceptionSupport(ctx, readyForLower);

  // -------------------------------------------------------------------------
  // #2949 slice 3 — pre-register the dynamic box/unbox/tag.test backing
  // (fast: `ensureAnyHelpers` → $AnyValue + the `__any_box_*`/`__any_unbox_*`
  // defined-function family; host: `addUnionImports` → the `__box_number` /
  // `__unbox_*` / `__typeof_*` import family) if any IR function carries a
  // dynamic op. Same rationale as every preregister above: registration
  // during Phase-3 emission would shift funcIdx values under an in-flight
  // body buffer (the #329/#2078 bug class). Both entry points are
  // idempotent, and `addUnionImports` performs the defined-function shift
  // fix-up itself for anything already compiled.
  // -------------------------------------------------------------------------
  preregisterDynamicSupport(ctx, readyForLower);

  // -------------------------------------------------------------------------
  // Phase 3 — Lower: translate each IrFunction to Wasm and install in ctx.
  // -------------------------------------------------------------------------
  //
  // String backend: capture concrete funcIdx values for the native-string
  // helpers (`__str_concat`, `__str_equals`) and the wasm:js-string imports
  // (`concat`, `equals`, `length`) AT THIS POINT — after all late imports
  // (e.g. `addPrimitiveTypeImports` triggered by legacy compileDeclarations)
  // have shifted the index space. `ctx.nativeStrHelpers` is a stale map
  // post-shift (the shift pass updates `funcMap` and call ops in bodies but
  // not the helpers map), so we resolve names against `ctx.mod.functions`
  // directly to pick up the current absolute index.
  const stringBackend = computeStringBackend(ctx);
  // Build the resolver in two steps so the resolver and the
  // ObjectStructRegistry / ClosureStructRegistry can refer to each
  // other without a circular direct reference: the registries need
  // `lowerIrTypeToValType` (which calls `resolver.resolveString` /
  // `resolveObject` / `resolveClosure`), and the resolver delegates
  // back to the registries. We hand the resolver `Deferred*Resolver`
  // shells whose `resolve` callbacks are filled in after the
  // registries exist.
  const deferredObj: DeferredObjectResolver = {
    resolve: (_shape: IrObjectShape) => null,
  };
  const deferredCl: DeferredClosureResolver = {
    resolveBase: () => null,
    resolveSubtype: () => null,
  };
  const deferredCell: DeferredRefCellResolver = {
    resolve: () => null,
  };
  const deferredClass: DeferredClassResolver = {
    resolve: () => null,
  };
  const resolver = makeResolver(
    ctx,
    unionRegistry,
    stringBackend,
    deferredObj,
    deferredCl,
    deferredCell,
    deferredClass,
  );
  const objectRegistry = new ObjectStructRegistry(ctx, (t) => lowerIrTypeToValType(t, resolver, "<obj-registry>"));
  deferredObj.resolve = (shape) => objectRegistry.resolve(shape);
  const closureRegistry = new ClosureStructRegistry(ctx, (t) =>
    lowerIrTypeToValType(t, resolver, "<closure-registry>"),
  );
  deferredCl.resolveBase = (sig) => closureRegistry.resolveBase(sig);
  deferredCl.resolveSubtype = (sig, fields) => closureRegistry.resolveSubtype(sig, fields);
  const refCellRegistry = new RefCellRegistry(ctx);
  deferredCell.resolve = (inner) => refCellRegistry.resolve(inner);
  // Slice 4 (#1169d): the class registry is a thin lookup over the
  // legacy class-collection state — `ctx.structMap`, `ctx.structFields`,
  // and `ctx.funcMap` carry everything we need.
  const classRegistry = new ClassRegistry(ctx);
  deferredClass.resolve = (shape) => classRegistry.resolve(shape);
  for (const entry of readyForLower) {
    const name = entry.name;
    try {
      // (#3142 Slice 2) The module-init unit's slot is the legacy
      // `__module_init` function — located by NAME (it is never in
      // `ctx.funcMap`; the slot was pushed directly by compileDeclarations).
      const funcIdx = entry.moduleInit
        ? (() => {
            const local = ctx.mod.functions.findIndex((f) => f.name === "__module_init");
            return local >= 0 ? ctx.numImportFuncs + local : undefined;
          })()
        : ctx.funcMap.get(name);
      if (funcIdx === undefined) {
        errors.push({ func: name, message: `no funcIdx allocated for ${name}` });
        continue;
      }
      // #1916 S2 — definedFuncAt/replaceDefinedFuncAt are the positional
      // read/write chokepoints (func-space.ts).
      const existing = definedFuncAt(ctx, funcIdx);
      if (!existing) {
        errors.push({ func: name, message: `funcIdx ${funcIdx} out of local range for ${name}` });
        continue;
      }

      const { func: wasmFunc } = lowerIrFunctionToWasm(entry.fn, resolver);
      // #1370 Phase B: signature parity guard for class methods.
      //
      // The legacy `class-bodies.ts` pass pre-allocated this method's
      // typeIdx, and any legacy-compiled caller already emitted
      // `call $methodFuncIdx` ops that route through that typeIdx. If
      // the IR-lowered body's typeIdx differs (e.g. f64 vs i32 for the
      // same TS `number`), patching would leave callers calling through
      // a stale type — Wasm validation fails, or worse, runtime UB.
      //
      // `addFuncType` deduplicates on signature, so identical sigs
      // produce identical typeIdx. A mismatch here means the IR resolved
      // a different ValType than legacy. Skip the patch — the legacy
      // body stays in place; the IR's effort goes uncommitted but no
      // regression occurs.
      //
      // Top-level FunctionDeclarations don't need this check — their
      // pre-allocated body was empty and no legacy callers depend on
      // the slot's prior typeIdx.
      // (#3142 Slice 2) `__module_init` shares the guard: its slot's
      // `()->()` typeIdx was interned by compileDeclarations and the wasm
      // `start` section / `_start` wrapper depend on it. `addFuncType`
      // dedups on shape, so the IR-lowered void unit lands on the same
      // index; a mismatch means the lowering went wrong — keep legacy.
      if ((entry.classMember || entry.moduleInit) && wasmFunc.typeIdx !== existing.typeIdx) {
        errors.push({
          func: name,
          message: `${entry.moduleInit ? "module-init" : "class-method"} typeIdx parity mismatch: IR=${wasmFunc.typeIdx}, legacy=${existing.typeIdx} — keeping legacy body`,
        });
        continue;
      }
      // Tail-call optimization parity with the legacy AST path (#602): the IR
      // `return` lowering never rewrites a trailing `call`/`call_ref` into
      // `return_call`, so IR-claimed (e.g. top-level recursive) functions lost
      // TCO and deep recursion overflowed the Wasm stack. Apply the conversion
      // here, where the full module type info is available to enforce the same
      // guards (param-count + return-type match, never inside a try-with-handler).
      //
      // (#3142 Slice 2) EXCEPT for the module-init unit: later pipeline passes
      // APPEND epilogue instrs to the `__module_init` body — most critically
      // `finalizeInModuleInitFlag` (#2800), which wraps the body with
      // `__in_module_init = 1 … = 0`. The legacy body FALLS THROUGH; an
      // explicit trailing `return` (the IR's void-return lowering) or a
      // `return_call` rewrite would make every appended epilogue instr
      // unreachable — the flag stays 1 forever and every delete-aware read
      // misroutes (the PR #3168 merge_group regression:
      // language/statements/for-in/order-simple-object.js). So: no TCO for
      // module-init, strip the trailing `return`, and if ANY other
      // return-class op remains anywhere in the body, keep the legacy body.
      let finalBody: Instr[];
      if (entry.moduleInit) {
        finalBody = [...wasmFunc.body];
        while (finalBody.length > 0 && finalBody[finalBody.length - 1]!.op === "return") {
          finalBody.pop();
        }
        if (bodyContainsReturnClassOp(finalBody)) {
          errors.push({
            func: name,
            message:
              "module-init body contains a non-trailing return-class op — appended init epilogues would be skipped; keeping legacy body",
            kind: "lower",
          });
          continue;
        }
      } else {
        finalBody = applyIrTailCalls(ctx, wasmFunc.body, wasmFunc.typeIdx);
      }
      replaceDefinedFuncAt(ctx, funcIdx, {
        name: existing.name,
        typeIdx: wasmFunc.typeIdx,
        locals: wasmFunc.locals,
        body: finalBody,
        exported: existing.exported,
      });
      compiled.push(name);
    } catch (e) {
      errors.push({
        func: name,
        message: e instanceof Error ? e.message : String(e),
        // (#2134) "emission-schedule verify" marks a failure of the
        // independent schedule checker in lower.ts — classify it "verify" so
        // it is a HARD failure under CI/test (`irVerifierHardFailureEnabled`)
        // while remaining a demote-to-legacy warning in production.
        kind:
          e instanceof Error && e.message.includes("backend legality failed")
            ? "backend-legality"
            : e instanceof Error && e.message.includes("emission-schedule verify")
              ? "verify"
              : "lower",
      });
    }
  }

  return { compiled, errors };
}

function hasExportModifier(fn: ts.FunctionDeclaration): boolean {
  return !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * (#3142 Slice 2) Deep-scan a Wasm body for return-class ops (`return`,
 * `return_call`, `return_call_ref`) inside nested blocks. The `__module_init`
 * slot's body must FALL THROUGH — later passes append epilogue instrs
 * (`finalizeInModuleInitFlag`'s flag-clear, #2800) that a mid-body return
 * would skip. The selector's early-return barrier makes this unreachable in
 * practice; the scan is the airtight backstop.
 */
function bodyContainsReturnClassOp(body: readonly Instr[]): boolean {
  for (const instr of body) {
    if (instr.op === "return" || instr.op === "return_call" || instr.op === "return_call_ref") return true;
    const nested = instr as { then?: Instr[]; else?: Instr[]; body?: Instr[]; catchAll?: Instr[] };
    if (nested.then && bodyContainsReturnClassOp(nested.then)) return true;
    if (nested.else && bodyContainsReturnClassOp(nested.else)) return true;
    if (nested.body && bodyContainsReturnClassOp(nested.body)) return true;
    if (nested.catchAll && bodyContainsReturnClassOp(nested.catchAll)) return true;
    const catches = (instr as { catches?: { body: Instr[] }[] }).catches;
    if (catches) {
      for (const c of catches) if (c.body && bodyContainsReturnClassOp(c.body)) return true;
    }
  }
  return false;
}

/**
 * (#3142 Slice 2) Map every top-level declared binding in the module-init
 * population to its legacy-allocated Wasm global (`__mod_<name>`, TDZ flag
 * `__tdz_<name>` when tracked). Throws (→ whole-unit demote to the legacy
 * body) when a binding has no module global or its global is not f64/i32
 * backed — Slice 2's scope is numeric/boolean module state; string / ref /
 * externref-backed bindings stay on legacy.
 */
function buildModuleBindingsMap(
  ctx: CodegenContext,
  population: readonly ts.Statement[],
): Map<string, ModuleBindingGlobal> {
  const map = new Map<string, ModuleBindingGlobal>();
  for (const stmt of population) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) {
        throw new Error("module-init: top-level destructuring declaration not in Slice 2 scope");
      }
      const name = d.name.text;
      if (!ctx.moduleGlobals.has(name)) {
        throw new Error(
          `module-init: top-level binding '${name}' has no module global (shadowed or class-bound) — keeping legacy body`,
        );
      }
      const globalName = `__mod_${name}`;
      const g = ctx.mod.globals.find((gl) => gl.name === globalName);
      if (!g || (g.type.kind !== "f64" && g.type.kind !== "i32")) {
        throw new Error(
          `module-init: top-level binding '${name}' is ${g ? g.type.kind : "missing"}-backed — not in Slice 2 scope (f64/i32 only)`,
        );
      }
      const tdzGlobalName = ctx.mod.globals.some((gl) => gl.name === `__tdz_${name}`) ? `__tdz_${name}` : null;
      map.set(name, {
        globalName,
        tdzGlobalName,
        type: { kind: "val", val: { kind: g.type.kind } } as IrType,
      });
    }
  }
  return map;
}

/**
 * #1587 rollout gate. The ownership analysis is default-OFF: it only runs the
 * extra (inert) analysis pass when explicitly enabled, so production builds pay
 * nothing and emitted Wasm is unchanged until a consumer opts in.
 */
function ownershipAnalysisEnabled(): boolean {
  return process.env.JS2WASM_IR_OWNERSHIP === "1" || process.env.JS2WASM_IR_OWNERSHIP === "true";
}

/**
 * #747 rollout gate. Escape analysis is default-OFF and inert; enabling it runs
 * the ownership pass (its oracle) too. Stack allocation / scalar replacement
 * consuming the classification is a follow-up — Phase 1 only annotates.
 */
function escapeAnalysisEnabled(): boolean {
  return process.env.JS2WASM_IR_ESCAPE === "1" || process.env.JS2WASM_IR_ESCAPE === "true";
}

/**
 * Run the Phase 3a IR hygiene pipeline to fixpoint.
 *
 * Pipeline order (spec #1167a):
 *   constantFold → deadCode → simplifyCFG
 *
 * Each pass returns the same IrFunction reference when it makes no
 * changes, so reference equality is a reliable "unchanged" signal. The
 * loop iterates until a full pass round is a no-op. An iteration cap
 * guards against pathological non-convergence — with the V1 passes each
 * loop strictly removes instructions or blocks, so real code converges
 * in a handful of rounds.
 */
function runHygienePasses(fn: IrFunction, registry?: AllocSiteRegistry): IrFunction {
  const MAX_ITERS = 10;
  let cur = fn;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const afterCF = constantFold(cur, registry);
    const afterDCE = deadCode(afterCF, registry);
    const afterCFG = simplifyCFG(afterDCE);
    if (afterCFG === cur) return cur;
    cur = afterCFG;
  }
  return cur;
}

/**
 * String-backend funcIdx resolution captured at Phase-3 entry. Both maps
 * (`ctx.nativeStrHelpers`, `ctx.jsStringImports`) can be stale after late
 * import shifts triggered during legacy compileDeclarations; we resolve by
 * name against the current state of `ctx.funcMap` / `ctx.mod.functions` to
 * pick up the absolute index in the post-shift index space.
 */
interface StringBackendIndices {
  /** Native-string helper funcIdx by name — null when missing. */
  readonly nativeHelpers: ReadonlyMap<string, number>;
  /** wasm:js-string import funcIdx by op name — null when missing. */
  readonly hostImports: ReadonlyMap<string, number>;
}

function computeStringBackend(ctx: CodegenContext): StringBackendIndices {
  const nativeHelpers = new Map<string, number>();
  const hostImports = new Map<string, number>();

  // Native helpers are stored as defined functions in `ctx.mod.functions`
  // with a stable `name` field; convert their local index to absolute via
  // `numImportFuncs`.
  if (ctx.nativeStrings) {
    for (let i = 0; i < ctx.mod.functions.length; i++) {
      const f = ctx.mod.functions[i]!;
      if (f.name === "__str_concat" || f.name === "__str_equals") {
        nativeHelpers.set(f.name, ctx.numImportFuncs + i);
      }
    }
  } else {
    // wasm:js-string imports live in `ctx.funcMap` keyed by op name (see
    // `addStringImports`). `funcMap` IS shift-aware, so this lookup is
    // already in the post-shift index space.
    for (const op of ["concat", "equals", "length"] as const) {
      const idx = ctx.funcMap.get(op);
      if (idx !== undefined) hostImports.set(op, idx);
    }
  }
  return { nativeHelpers, hostImports };
}

/**
 * Late-bound resolver delegate — used so the recursive struct registry
 * (which needs to lower IrType→ValType, including string types via the
 * resolver) and the resolver (whose resolveObject delegates to the
 * registry) can both refer to each other without a circular import.
 */
interface DeferredObjectResolver {
  resolve: (shape: IrObjectShape) => IrObjectStructLowering | null;
}

interface DeferredClosureResolver {
  resolveBase: (sig: IrClosureSignature) => IrClosureLowering | null;
  resolveSubtype: (sig: IrClosureSignature, fields: readonly IrType[]) => IrClosureLowering | null;
}

interface DeferredRefCellResolver {
  resolve: (inner: ValType) => IrRefCellLowering | null;
}

interface DeferredClassResolver {
  resolve: (shape: IrClassShape) => IrClassLowering | null;
}

/**
 * Slice 6 part 4 refactor (#1185): build the from-ast subset of the
 * IR resolver eagerly (before Phase 1 IR build). Only the methods
 * from-ast actually consults — `nativeStrings()`, `resolveString()`,
 * `resolveVec()` — are populated; everything else is absent.
 *
 * This is decoupled from `makeResolver` (the full Phase-3 resolver)
 * because the from-ast layer needs resolver-time info during build,
 * but the full resolver depends on lazy registries that don't exist
 * yet at that point. The two share the same logic for the methods
 * both expose — see `makeResolver` for the full body.
 */
/**
 * #1804 — shared `resolveVecForElement` body for both resolvers. Get-or-creates
 * the `$arr`/`$vec` types for `elementValType` via the legacy registry (so the
 * constructed vec shares identity with `compileArrayLiteral` output), and
 * returns the `IrVecLowering` the `vec.new_fixed` emitter needs. Mirrors the
 * legacy elemKind derivation in `compileArrayLiteral` (literals.ts) so the
 * registry keys collide intentionally and no parallel type is registered.
 */
function resolveVecForElementImpl(
  ctx: CodegenContext,
  elementValType: ValType,
): import("./lower.js").IrVecLowering | null {
  // Match the legacy elemKind key: ref/ref_null elements key on `ref_<typeIdx>`,
  // everything else on the ValType kind.
  const elemKind =
    elementValType.kind === "ref" || elementValType.kind === "ref_null"
      ? `ref_${(elementValType as { typeIdx: number }).typeIdx}`
      : elementValType.kind;
  const vecStructTypeIdx = getOrRegisterVecType(ctx, elemKind, elementValType);
  const arrayTypeIdx = getArrTypeIdxFromVec(ctx, vecStructTypeIdx);
  if (arrayTypeIdx < 0) return null;
  const arrayDef = ctx.mod.types[arrayTypeIdx];
  if (!arrayDef || arrayDef.kind !== "array") return null;
  return {
    vecStructTypeIdx,
    lengthFieldIdx: 0,
    dataFieldIdx: 1,
    arrayTypeIdx,
    elementValType: arrayDef.element,
  };
}

/**
 * (#2856) Brand an externref-shaped extern-member result with its extern
 * class name, resolved from the checker's type AT THE USE SITE. Returns
 * `undefined` (no brand — the IR carries a plain externref) when the result
 * isn't externref-shaped, no use-site node is available, or the use-site type
 * has no named symbol (unions of distinct classes, type params, anonymous
 * shapes). An unbranded result still lowers correctly — it just can't
 * dispatch FURTHER member access, which then demotes that function cleanly.
 */
function externResultClassName(
  ctx: CodegenContext,
  node: ts.Node | undefined,
  result: ValType | undefined,
): string | undefined {
  if (!node || !result || result.kind !== "externref") return undefined;
  try {
    const t = ctx.checker.getTypeAtLocation(node);
    const nonNull = ctx.checker.getNonNullableType(t);
    const name = nonNull.getSymbol()?.name;
    if (!name || name === "__type" || name === "__object") return undefined;
    return name;
  } catch {
    return undefined;
  }
}

function makeFromAstResolver(ctx: CodegenContext, sourceFile?: ts.SourceFile): IrFromAstResolver {
  return {
    // (#2955 slice 5) No raw `nativeStrings()` here anymore — from-ast's
    // interface no longer carries the mode discriminator; every mode
    // decision flows through the named capability/rep/strategy queries
    // below.
    // (#2955 slice 2) The WHOLE string-prototype-method mode decision table,
    // relocated here from from-ast's `lowerStringMethodCall` so the front-end
    // reads no `nativeStrings` at that site. Byte-inert by construction: the
    // returned plan reproduces exactly the decisions the old inline reads
    // made — same demotes (null), same target names, same index reps, same
    // pad strategy — so the emitted IR per mode is unchanged. The demote
    // half MUST stay a build-time answer (there is no lower-time demote
    // channel), which is why this is a resolver callback and not an
    // abstract-instr lowering case; promoting the rep half into a true
    // `str.method` instr is #2955's follow-up slice.
    stringMethodPlan(method: string, argCount: number) {
      const native = ctx.nativeStrings;
      // (#3156) charCodeAt — BOTH modes lower to a guarded defined helper
      // `(recv, i32 idx) -> f64` (src/codegen/char-code-at-helpers.ts;
      // materialized on demand by resolveFunc below). NOT the bare
      // `wasm:js-string charCodeAt` builtin: that one traps out-of-range
      // (#2003) and its bare funcMap name is shadowable by a user function
      // named `charCodeAt` (#1072). An omitted position pads i32 0.
      if (method === "charCodeAt") {
        return {
          funcName: native ? "__str_charCodeAt" : "__jsstr_charCodeAt",
          indexArgRep: "i32" as const,
          padOmitted: "charcode-zero" as const,
        };
      }
      // #2002 — the native string backend lowers the position arg via its
      // own __str_* helpers (src/codegen/string-ops.ts); defer to the legacy
      // native path rather than re-implement position handling in the IR.
      if (
        native &&
        (method === "indexOf" || method === "includes" || method === "startsWith" || method === "endsWith")
      ) {
        return null;
      }
      const sig = STRING_METHOD_TABLE[method];
      if (!sig) return null;
      const omitted = argCount < sig.hostArgs.length;
      // (#3156) substring — native `__str_substring` clamps both indices to
      // [0, len], so omissions pad exact sentinels (start 0 / end 0x7fffffff,
      // the legacy native arm's convention) and every arity lowers; host mode
      // rides the #1248 length-default pad in from-ast.
      if (method === "substring") {
        return native
          ? {
              funcName: "__str_substring",
              indexArgRep: "i32" as const,
              padOmitted: "native-substring" as const,
            }
          : {
              funcName: "string_substring",
              indexArgRep: "f64" as const,
              padOmitted: "host" as const,
            };
      }
      // #1248 — native mode only lowers fully-specified call sites, except
      // `slice(start)` whose implicit end defaults to recv.length.
      if (native && omitted && !(method === "slice" && argCount === 1)) return null;
      return {
        funcName: native ? `__str_${method}` : `string_${method}`,
        indexArgRep: (native ? "i32" : "f64") as "i32" | "f64",
        padOmitted: (native ? "native-slice-len" : "host") as "native-slice-len" | "host",
      };
    },
    resolveString(): ValType {
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
      }
      return { kind: "externref" };
    },
    // Slice 10 (#1169i): expose the legacy-collected extern-class
    // metadata to the from-ast layer. The legacy `collectExternFromDeclareVar`
    // and `collectInterfaceMembers` passes have already populated
    // `ctx.externClasses` by the time the IR runs, so this is a thin
    // pass-through. The from-ast layer slices `params[0]` off the
    // method signature (the legacy stores the receiver `externref` as
    // the first param so the host import takes a flat
    // `(receiver, args...)` shape).
    getExternClassInfo(className: string) {
      const info = ctx.externClasses.get(className);
      if (!info) return undefined;
      return {
        className: info.className,
        constructorParams: info.constructorParams,
        methods: info.methods,
        properties: info.properties,
      };
    },
    // (#2856) Host-global identifier → the `global_<name>` handle import the
    // legacy `collectDeclaredGlobals` pass registered. Nothing to resolve in
    // host-free modes: that pass skips registration under
    // standalone/strictNoHostImports, so `document` correctly stays
    // unresolvable there (and the selector's capability gate already deferred
    // any function that references it).
    getHostGlobalInfo(name: string) {
      const g = ctx.declaredGlobals.get(name);
      if (!g || !g.className) return undefined;
      return { importName: `global_${name}`, className: g.className };
    },
    // (#2856) Mode flag for the capability invariant assert at the from-ast
    // host-extern arms.
    jsHostExterns(): boolean {
      return !(ctx.standalone || ctx.wasi || ctx.strictNoHostImports);
    },
    // (#2955 number-box slice) Capability: this lane owns the
    // `__box_number` / `__unbox_number` f64⇄externref host imports (legacy
    // registers them via `addUnionImports`). The from-ast boxing arms
    // (`coerceToExpectedExtern`, `coerceReturnValue`) consult THIS predicate
    // instead of reading `nativeStrings` directly — the mode knowledge lives
    // here, on the lower/integration side, per #2955's de-polymorph
    // direction. Implementation is deliberately the exact truth value the
    // old in-place `nativeStrings?.() === false` reads produced (byte-inert
    // relocation). Widening — e.g. allowing the box pair under a
    // native-strings HOST compile, or lowering to `$AnyValue` boxing in
    // standalone instead of demoting — is a semantic follow-up tracked in
    // #2955's remaining-slices map, and must be validated against the
    // standalone floor (the demote arm is load-bearing there).
    hasHostNumberBox(): boolean {
      return !ctx.nativeStrings;
    },
    // (#2955 slice 3) Rep predicate: the string carrier is externref (host
    // strings), so string SSA values flow unchanged into externref-expected
    // positions (`coerceToExpectedExtern` host-call args) and take the
    // externref-shaped `__extern_is_undefined` arm of the strict
    // undefined-compare. The from-ast string-rep arms consult THIS
    // predicate instead of reading `nativeStrings` directly — the mode
    // knowledge lives here, on the lower/integration side, per #2955's
    // de-polymorph direction. Implementation is deliberately the exact
    // truth value the old in-place reads produced (byte-inert relocation).
    // The demote arm this gates in `coerceToExpectedExtern` is a build-time
    // claim/demote decision (no lower-time demote channel) and — unlike the
    // number-box capability — has no widening follow-up: a native
    // `(ref $AnyString)` can never satisfy an externref host-arg position.
    stringIsExternref(): boolean {
      return !ctx.nativeStrings;
    },
    // (#2955 slice 4) Capability: this lane owns the `number_toString`
    // `(f64) -> externref` host import (legacy pre-registers it on any
    // checker-number `.toString()` in source; its return IS host-mode's
    // string carrier). The from-ast `<number>.toString()` arm consults THIS
    // predicate instead of reading `nativeStrings` directly — same
    // build-time capability shape as `hasHostNumberBox`, deliberately the
    // exact truth value the old in-place `nativeStrings?.() === false` read
    // produced (byte-inert relocation). Widening — a native number
    // formatter returning the `(ref $AnyString)` carrier — is a semantic
    // follow-up tracked in #2955 and must be validated against the
    // standalone floor (the demote arm is load-bearing there).
    hasHostNumberToString(): boolean {
      return !ctx.nativeStrings;
    },
    // (#2955 slice 5) String for-of strategy — the LAST from-ast mode read,
    // relocated. Native strings iterate via the `__str_charAt` counter loop;
    // host strings feed the `__iterator` host protocol (already
    // externref-shaped). Byte-inert: same truth table as the old in-place
    // `nativeStrings?.()` read (absent → iter-host).
    stringForOfPlan(): "char-loop" | "iter-host" {
      return ctx.nativeStrings ? "char-loop" : "iter-host";
    },
    // (#2856 C2) TypedArray-view receiver detection for element STORES —
    // the same checker walk as the legacy `elementAccessTypedArrayName`
    // (assignment.ts): symbol name of the receiver's TS type against the
    // TYPED_ARRAY_NAMES registry. Writes into those views carry per-view
    // conversion semantics (ToUint8/ToUint8Clamp/packing) that the plain
    // vec store helper must not bypass, so the IR demotes them.
    isTypedArrayViewExpr(expr: ts.Expression): boolean {
      const t = ctx.checker.getTypeAtLocation(expr);
      let name = t.getSymbol()?.name ?? t.aliasSymbol?.name;
      if ((!name || !TYPED_ARRAY_NAMES.has(name)) && ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
        name = expr.expression.text;
      }
      return !!name && TYPED_ARRAY_NAMES.has(name);
    },
    // (#2856 C3) Module-scope binding → the Wasm global the legacy backend
    // allocated (`__mod_<name>` in ctx.mod.globals, TDZ flag `__tdz_<name>`
    // when tracked) + the extern-class brand of the held value from the
    // checker at the DECLARATION site. Only externref-shaped extern-class
    // instances resolve (e.g. `const cache = new Map()` → "Map"); plain
    // scalars / non-extern values return undefined so the identifier arm
    // demotes cleanly.
    getModuleScopeExternBinding(name: string) {
      if (!ctx.moduleGlobals.has(name)) return undefined;
      const globalName = `__mod_${name}`;
      const g = ctx.mod.globals.find((gl) => gl.name === globalName);
      if (!g || g.type.kind !== "externref") return undefined;
      // Brand from the checker: the module-level declaration's type symbol
      // must name a REGISTERED extern class (host mode only — in
      // standalone/nativeStrings the class isn't registered, so this
      // resolves nothing and the function demotes to legacy, which has the
      // native runtime interception).
      const sf = sourceFile;
      if (!sf) return undefined;
      let className: string | undefined;
      for (const stmt of sf.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || d.name.text !== name) continue;
          const t = ctx.checker.getTypeAtLocation(d.name);
          className = t.getSymbol()?.name ?? t.aliasSymbol?.name;
        }
      }
      if (!className || !ctx.externClasses.has(className)) return undefined;
      const tdzGlobalName = ctx.mod.globals.some((gl) => gl.name === `__tdz_${name}`) ? `__tdz_${name}` : null;
      return { globalName, tdzGlobalName, className };
    },
    // (#2856) Variant selection for `console.<m>(arg)` — the SAME checker
    // predicates as the legacy `collectConsoleImports` registration scan
    // (string → bool → number → externref, in that order), so the import
    // name the IR resolves (`console_<m>_<variant>`) is registered by
    // construction.
    consoleArgVariant(arg: ts.Expression) {
      const argType = ctx.checker.getTypeAtLocation(arg);
      if (isStringType(argType)) return "string";
      if (isBooleanType(argType)) return "bool";
      if (isNumberType(argType)) return "number";
      return "externref";
    },
    // (#2856) Chain-walking extern-member resolution + use-site result
    // branding. Mirrors the legacy `resolveExtern` (collectUsedExternImports)
    // and `compileExternPropertyGetFromStack` walks: start at the receiver's
    // class, follow `externClassParent` until a class carries the member.
    // The RESULT brand comes from the checker at the use site (`node`) — the
    // same per-site resolution legacy property-access/calls use — because
    // registration-time member signatures collapse overloads (e.g.
    // `Document.createElement`'s first overload returns a type-param) and
    // cannot brand. `getNonNullableType` strips `| null` (e.g.
    // `getElementById(): HTMLElement | null`) so the brand survives unions
    // with null/undefined.
    resolveExternMember(className: string, memberName: string, kind: "method" | "property", node?: ts.Node) {
      let current: string | undefined = className;
      while (current) {
        const info = ctx.externClasses.get(current);
        if (info) {
          if (kind === "method") {
            const method = info.methods.get(memberName);
            if (method) {
              return {
                importPrefix: info.importPrefix,
                method,
                resultClassName: externResultClassName(ctx, node, method.results[0]),
              };
            }
          } else {
            const property = info.properties.get(memberName);
            if (property) {
              return {
                importPrefix: info.importPrefix,
                property,
                resultClassName: externResultClassName(ctx, node, property.type),
              };
            }
          }
        }
        current = ctx.externClassParent.get(current);
      }
      return undefined;
    },
    // Same logic as `IrLowerResolver.resolveVec` in `makeResolver`.
    // Walks `ctx.mod.types` to recover the vec layout from a `(ref|
    // ref_null) $vec_*` ValType. See the corresponding doc on
    // `IrLowerResolver.resolveVec` for the contract.
    resolveVec(valType: ValType) {
      if (valType.kind !== "ref" && valType.kind !== "ref_null") return null;
      const typeIdx = (valType as { typeIdx: number }).typeIdx;
      const vecDef = ctx.mod.types[typeIdx];
      if (!vecDef || vecDef.kind !== "struct") return null;
      if (vecDef.fields.length < 2) return null;
      const lengthField = vecDef.fields[0]!;
      const dataField = vecDef.fields[1]!;
      if (lengthField.type.kind !== "i32") return null;
      if (dataField.type.kind !== "ref" && dataField.type.kind !== "ref_null") return null;
      const arrayTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;
      const arrayDef = ctx.mod.types[arrayTypeIdx];
      if (!arrayDef || arrayDef.kind !== "array") return null;
      return {
        vecStructTypeIdx: typeIdx,
        lengthFieldIdx: 0,
        dataFieldIdx: 1,
        arrayTypeIdx,
        elementValType: arrayDef.element,
      };
    },
    // #1804 — register-or-recover the vec struct for an element ValType, for
    // `vec.new_fixed` construction. See `resolveVecForElementImpl`.
    resolveVecForElement(elementValType: ValType) {
      return resolveVecForElementImpl(ctx, elementValType);
    },
    // #1375 narrow slice — TS-narrowing fast-path for optional chaining.
    // The IR's `isIrTypeNullable` flags `extern` (host class) values as
    // always nullable because at the Wasm level they're `externref`. But
    // TS narrowing often proves the receiver is non-null in context
    // (e.g. `m: Map<string, number>` without `| undefined`). When TS
    // confirms non-null, `lowerPropertyAccess` skips the `?.`-on-nullable
    // throw and lowers as a regular `.` access. Otherwise (genuinely
    // nullable, or no narrowing), legacy fallback continues.
    isExpressionTsNonNullable(expr: ts.Expression): boolean | undefined {
      const t = ctx.checker.getTypeAtLocation(expr);
      const nonNull = ctx.checker.getNonNullableType(t);
      // TS's `Type` objects are interned by the checker, so a strict
      // identity comparison is sound: equal identity ⇒ stripping null/
      // undefined was a no-op ⇒ the type was already non-null.
      return t === nonNull;
    },
  };
}

function makeResolver(
  ctx: CodegenContext,
  unionRegistry: UnionStructRegistry,
  stringBackend: StringBackendIndices,
  objResolver: DeferredObjectResolver,
  closureResolver: DeferredClosureResolver,
  refCellResolver: DeferredRefCellResolver,
  classResolver: DeferredClassResolver,
): IrLowerResolver {
  // (#2949 slice 3) One dynamic-lowering handle per resolver (undefined =
  // not yet built; null = mode has no dynamic op lowering).
  let dynamicLoweringMemo: IrDynamicLowering | null | undefined;
  return {
    resolveFunc(ref: IrFuncRef): number {
      // #2945 — `%` lowers to a call of the Wasm-native exact-fmod helper.
      // Materialize it on demand: `ensureFmod` is idempotent (funcMap-cached)
      // and appends a DEFINED function (never an import), so no existing
      // funcIdx shifts — same append-only discipline as the IR's own closure
      // functions. On-demand keeps the helper out of modules that never use
      // `%` (parity with legacy, which also emits it lazily).
      if (ref.name === FMOD_FN) return ensureFmod(ctx);
      // (#2856 C2) `__vec_elem_set_<vecTypeIdx>` — element-store helper with
      // full legacy grow semantics. Materialized on demand, same append-only
      // defined-function discipline as `ensureFmod` (never an import, no
      // existing funcIdx shifts). Idempotent via funcMap.
      if (ref.name.startsWith(VEC_ELEM_SET_PREFIX)) {
        const vecTypeIdx = Number(ref.name.slice(VEC_ELEM_SET_PREFIX.length));
        const helperIdx = Number.isInteger(vecTypeIdx) ? ensureVecElemSet(ctx, vecTypeIdx) : null;
        if (helperIdx === null) {
          throw new Error(`ir/integration: cannot materialize ${ref.name} (not a recognisable vec struct)`);
        }
        return helperIdx;
      }
      // (#3156) Guarded charCodeAt helpers — materialized on demand, same
      // append-only defined-function discipline as ensureFmod (never an
      // import, no existing funcIdx shifts). Idempotent via funcMap. The
      // host variant bakes the `wasm:js-string` builtin import indices from
      // `ctx.jsStringImports` (the #1072 shadowing-safe registry; import
      // indices never shift) — `preregisterStringSupport` guarantees
      // `addStringImports` ran before Phase-3 emission whenever a lowered
      // function calls this helper.
      if (ref.name === JSSTR_CHARCODEAT_FN) {
        const helperIdx = ensureHostCharCodeAtGuarded(ctx);
        if (helperIdx === null) {
          throw new Error(`ir/integration: cannot materialize ${ref.name} (wasm:js-string builtins not registered)`);
        }
        return helperIdx;
      }
      if (ref.name === NATIVE_CHARCODEAT_FN) {
        const helperIdx = ensureNativeCharCodeAtHelper(ctx);
        if (helperIdx === null) {
          throw new Error(`ir/integration: cannot materialize ${ref.name} (native-string helpers unavailable)`);
        }
        return helperIdx;
      }
      // (#3167) String relational compare helper. Resolve mode-appropriately:
      //   native/WASI → the `__str_compare` defined helper (idempotently
      //     ensured via `ensureNativeStringHelpers`; append-only, so no funcIdx
      //     shift — same discipline as `ensureFmod`/the charCodeAt helpers).
      //   host → the `string_compare` env import (registered by the legacy
      //     declaration-collection pass whenever source has a string relational,
      //     so it is already in `ctx.funcMap`; its import index is stable).
      // Both are `(str, str) -> i32` returning a -1/0/1 lexicographic sign.
      if (ref.name === IR_STRING_COMPARE_FN) {
        if (ctx.nativeStrings) {
          ensureNativeStringHelpers(ctx);
          const helperIdx = ctx.nativeStrHelpers.get("__str_compare");
          if (helperIdx === undefined) {
            throw new Error(`ir/integration: cannot materialize ${ref.name} (native __str_compare unavailable)`);
          }
          // Re-resolve by name against the post-shift function table (the
          // helper map's captured index can predate later import inserts).
          for (let i = 0; i < ctx.mod.functions.length; i++) {
            if (ctx.mod.functions[i]!.name === "__str_compare") return ctx.numImportFuncs + i;
          }
          return helperIdx;
        }
        const hostIdx = ctx.funcMap.get("string_compare");
        if (hostIdx === undefined) {
          throw new Error(`ir/integration: cannot resolve ${ref.name} (host string_compare import not registered)`);
        }
        return hostIdx;
      }
      const idx = ctx.funcMap.get(ref.name);
      if (idx !== undefined) return idx;
      // Slice 6 part 4 (#1183): native-string helpers (`__str_charAt`,
      // `__str_concat`, `__str_equals`, `__str_flatten`, etc.) are
      // registered in `ctx.nativeStrHelpers`, not `ctx.funcMap`. The
      // helper map captures funcIdx at registration time and does NOT
      // get re-shifted by late-import passes, so we re-resolve by name
      // against the post-shift `ctx.mod.functions` (parallel to
      // `computeStringBackend`'s rationale for the host string ops).
      for (let i = 0; i < ctx.mod.functions.length; i++) {
        if (ctx.mod.functions[i]!.name === ref.name) {
          return ctx.numImportFuncs + i;
        }
      }
      // Last fallback: the (potentially stale) helpers map. Used when
      // a name doesn't appear in `ctx.mod.functions` because it's a
      // host import rather than a defined helper.
      const helperIdx = ctx.nativeStrHelpers.get(ref.name);
      if (helperIdx !== undefined) return helperIdx;
      throw new Error(`ir/integration: unknown function ref "${ref.name}"`);
    },
    resolveGlobal(ref: IrGlobalRef): number {
      const localIdx = ctx.mod.globals.findIndex((g) => g.name === ref.name);
      if (localIdx < 0) throw new Error(`ir/integration: unknown global ref "${ref.name}"`);
      return ctx.numImportGlobals + localIdx;
    },
    resolveType(ref: IrTypeRef): number {
      const idx = ctx.mod.types.findIndex((t) => "name" in t && (t as { name?: string }).name === ref.name);
      if (idx < 0) throw new Error(`ir/integration: unknown type ref "${ref.name}"`);
      return idx;
    },
    internFuncType(type: FuncTypeDef): number {
      return addFuncType(ctx, type.params, type.results, type.name);
    },
    resolveUnion(members: readonly ValType[]): IrUnionLowering | null {
      return unionRegistry.resolve(members);
    },
    resolveObject(shape: IrObjectShape): IrObjectStructLowering | null {
      return objResolver.resolve(shape);
    },
    // -------------------------------------------------------------------
    // Closure / ref-cell dispatch (#1169c).
    // -------------------------------------------------------------------
    resolveClosure(sig: IrClosureSignature): IrClosureLowering | null {
      return closureResolver.resolveBase(sig);
    },
    resolveClosureSubtype(sig: IrClosureSignature, fields: readonly IrType[]): IrClosureLowering | null {
      return closureResolver.resolveSubtype(sig, fields);
    },
    resolveRefCell(inner: ValType): IrRefCellLowering | null {
      return refCellResolver.resolve(inner);
    },
    // -------------------------------------------------------------------
    // Class dispatch (#1169d).
    // -------------------------------------------------------------------
    resolveClass(shape: IrClassShape): IrClassLowering | null {
      return classResolver.resolve(shape);
    },
    // -------------------------------------------------------------------
    // Vec dispatch (slice 6 part 2 — #1181).
    //
    // Walks the legacy `ctx.mod.types` registry to recover the layout the
    // for-of vec fast path needs from a `(ref $vec_*)` ValType. The legacy
    // `getOrRegisterVecType` always shapes a vec as
    //   { length: i32, data: (ref $arr_<elem>) }
    // so we just verify that shape and read the element ValType off the
    // backing array type. Returns null when the input isn't a recognisable
    // vec — the caller treats that as a selector bug (the for-of selector
    // should have rejected the function).
    // -------------------------------------------------------------------
    resolveVec(valType: ValType): import("./lower.js").IrVecLowering | null {
      if (valType.kind !== "ref" && valType.kind !== "ref_null") return null;
      const typeIdx = (valType as { typeIdx: number }).typeIdx;
      const vecDef = ctx.mod.types[typeIdx];
      if (!vecDef || vecDef.kind !== "struct") return null;
      if (vecDef.fields.length < 2) return null;
      const lengthField = vecDef.fields[0]!;
      const dataField = vecDef.fields[1]!;
      if (lengthField.type.kind !== "i32") return null;
      if (dataField.type.kind !== "ref" && dataField.type.kind !== "ref_null") return null;
      const arrayTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;
      const arrayDef = ctx.mod.types[arrayTypeIdx];
      if (!arrayDef || arrayDef.kind !== "array") return null;
      return {
        vecStructTypeIdx: typeIdx,
        lengthFieldIdx: 0,
        dataFieldIdx: 1,
        arrayTypeIdx,
        elementValType: arrayDef.element,
      };
    },
    // #1804 — register-or-recover the vec struct for an element ValType, for
    // `vec.new_fixed` construction. See `resolveVecForElementImpl`.
    resolveVecForElement(elementValType: ValType): import("./lower.js").IrVecLowering | null {
      return resolveVecForElementImpl(ctx, elementValType);
    },
    // -------------------------------------------------------------------
    // String backend dispatch (#1169a).
    // -------------------------------------------------------------------
    resolveString(): ValType {
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
      }
      return { kind: "externref" };
    },
    // -------------------------------------------------------------------
    // Dynamic (boxed-any) carrier dispatch (#2949 slice 1).
    //
    // MUST match legacy `resolveWasmType`'s any/unknown arm EXACTLY
    // (codegen/index.ts — "any/unknown → ref_null $AnyValue in fast mode,
    // externref otherwise") so IR-claimed and legacy-compiled functions
    // agree on the `any` ABI. `ensureAnyValueType` is idempotent and only
    // APPENDS a type (never shifts existing indices), the same lazy
    // registration legacy performs at its own first `any` use.
    // -------------------------------------------------------------------
    resolveDynamic(): ValType {
      if (ctx.fast) {
        ensureAnyValueType(ctx);
        return { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
      }
      return { kind: "externref" };
    },
    // (#2949 slice 3) Op-emission handle for dynamic box/unbox/tag.test —
    // memoized so all arms of one lowering run share a single handle. The
    // factory's mode split mirrors resolveDynamic above by construction
    // (both key on ctx.fast). Helpers/imports the handle resolves by name
    // were registered up front by preregisterDynamicSupport.
    resolveDynamicLowering(): IrDynamicLowering | null {
      if (dynamicLoweringMemo === undefined) {
        dynamicLoweringMemo = makeDynamicLowering(ctx);
      }
      return dynamicLoweringMemo;
    },
    // Slice 6 part 4 refactor (#1185): expose the nativeStrings mode
    // discriminator so the from-ast for-of arms can dispatch without
    // needing the per-feature shortcut threaded through LowerCtx.
    nativeStrings(): boolean {
      return ctx.nativeStrings;
    },
    emitStringConst(value: string, alloc?: import("./nodes.js").AllocSiteId): readonly Instr[] {
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        // #1588 PR-B part 2: when --utf8-storage is on, read the encoding
        // annotation off the string.const's alloc site and let
        // nativeStringLiteralInstrs pick i8 (Utf8String) vs i16 (NativeString).
        // When off, or the annotation is absent/wtf16, this is the i16 path —
        // byte-identical to before.
        if (ctx.utf8Storage && alloc !== undefined && ctx.allocRegistry) {
          const enc = ctx.allocRegistry.read<StringEncoding>(alloc, ALLOC_NAMESPACES.encoding);
          return nativeStringLiteralInstrs(ctx, value, enc);
        }
        // Native strings: inline `array.new_fixed` of WTF-16 code units +
        // `struct.new $NativeString(len, off, data)` — same shape as
        // `compileNativeStringLiteral` in the legacy path.
        const ops: Instr[] = [
          { op: "i32.const", value: value.length },
          { op: "i32.const", value: 0 },
        ];
        for (let i = 0; i < value.length; i++) {
          ops.push({ op: "i32.const", value: value.charCodeAt(i) });
        }
        ops.push({ op: "array.new_fixed", typeIdx: ctx.nativeStrDataTypeIdx, length: value.length });
        ops.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
        return ops;
      }
      // Host strings: pre-registration in `preregisterStringSupport` already
      // ensured the string global exists. Look up the (now-final) index.
      const globalIdx = ctx.stringGlobalMap.get(value);
      if (globalIdx === undefined || globalIdx < 0) {
        throw new Error(`ir/integration: string literal "${value}" was not pre-registered`);
      }
      return [{ op: "global.get", index: globalIdx }];
    },
    emitStringConcat(): readonly Instr[] {
      if (ctx.nativeStrings) {
        const idx = stringBackend.nativeHelpers.get("__str_concat");
        if (idx === undefined) {
          throw new Error("ir/integration: __str_concat helper not registered");
        }
        return [{ op: "call", funcIdx: idx }];
      }
      const idx = stringBackend.hostImports.get("concat");
      if (idx === undefined) throw new Error("ir/integration: wasm:js-string concat not registered");
      return [{ op: "call", funcIdx: idx }];
    },
    emitStringEquals(): readonly Instr[] {
      if (ctx.nativeStrings) {
        const idx = stringBackend.nativeHelpers.get("__str_equals");
        if (idx === undefined) {
          throw new Error("ir/integration: __str_equals helper not registered");
        }
        return [{ op: "call", funcIdx: idx }];
      }
      const idx = stringBackend.hostImports.get("equals");
      if (idx === undefined) throw new Error("ir/integration: wasm:js-string equals not registered");
      return [{ op: "call", funcIdx: idx }];
    },
    emitStringLen(): readonly Instr[] {
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        // AnyString.length is field 0 (matches struct definition in
        // src/codegen/native-strings.ts).
        return [{ op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 }];
      }
      const idx = stringBackend.hostImports.get("length");
      if (idx === undefined) throw new Error("ir/integration: wasm:js-string length not registered");
      return [{ op: "call", funcIdx: idx }];
    },
    // -------------------------------------------------------------------
    // Exception handling dispatch (slice 9 — #1169h).
    //
    // Lazily registers the shared `__exn` tag via the legacy registry's
    // `ensureExnTag`. The tag has signature `(externref)` and is shared
    // between IR-compiled and legacy-compiled functions so cross-path
    // throws / catches interoperate. The integration loop pre-registers
    // the tag (see `preregisterExceptionSupport`) for any IR function
    // that emits `throw` / `try`, but this method is the formal
    // resolver entry point and remains correct even if pre-registration
    // is skipped.
    // -------------------------------------------------------------------
    ensureExnTag(): number {
      return ensureExnTag(ctx);
    },
    // -------------------------------------------------------------------
    // Async / Promise dispatch (#1373b Slice 1).
    //
    // Lazily registers (or retrieves) the standalone `$Promise` WasmGC
    // struct type. The struct layout matches the canonical registration
    // in `src/codegen/async-scheduler.ts`:
    //   { state: i32, value: externref, callbacks: externref }
    //
    // Lower's `async.return` / `async.throw` / `await` arms call this
    // to construct or inspect Promise values without going through the
    // JS-host `Promise.resolve` / `Promise.reject` imports.
    // -------------------------------------------------------------------
    resolvePromiseType(): number {
      return getOrRegisterPromiseType(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// String pre-registration (#1169a)
// ---------------------------------------------------------------------------

interface BuiltFnRef {
  readonly fn: IrFunction;
}

/**
 * Walk every IR function the lowerer is about to emit and pre-register the
 * string-backend support it will need. This must run BEFORE Phase 3 starts
 * because both `addStringImports` and `addStringConstantGlobal` re-shift
 * function/global indices in already-compiled bodies; calling them
 * mid-emission risks invalidating the lowerer's local op buffer.
 *
 * Idempotent — repeat calls are no-ops, and the helpers themselves are
 * idempotent on `(ctx.hasStringImports, ctx.stringGlobalMap)`.
 */
function preregisterStringSupport(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  // Find all distinct string literals + whether any string op is used at all.
  // Slice 10 (#1169i): the `extern.regex` instr lowers to two `string.const`
  // ops (pattern + flags). We collect them here too so the host-strings
  // backend pre-registers their `string_constants.<value>` globals before
  // Phase 3 emission. `forof.*` body instrs also need walking — slice 6
  // body buffers may contain string ops nested inside the for-of.
  const literals = new Set<string>();
  let usesStringOp = false;
  const walk = (instr: IrInstr): void => {
    if (instrUsesStrings(instr)) usesStringOp = true;
    if (instr.kind === "string.const") literals.add(instr.value);
    // (#3156) The host guarded-charCodeAt helper wraps the `wasm:js-string`
    // charCodeAt/length builtins — its materialization (resolveFunc) reads
    // `ctx.jsStringImports`, so `addStringImports` must have run BEFORE
    // Phase-3 emission. A claimed function can carry this call with NO other
    // string op (e.g. `f(s: string) { return s.charCodeAt(0); }` — receiver
    // is a param, no literals), so detect the call target explicitly.
    if (instr.kind === "call" && instr.target.name === JSSTR_CHARCODEAT_FN) {
      usesStringOp = true;
    }
    // (#3167) A body may carry a string relational (`a < b` on string params)
    // with NO other string op — no literal, concat, or eq. Detect the compare
    // call so host-mode pre-registration (`addStringImports` + any literal
    // globals) and native-mode helper availability are guaranteed before
    // Phase-3 emission. (`resolveFunc` also ensures the native `__str_compare`
    // on demand, but flagging here keeps the host string-import path uniform.)
    if (instr.kind === "call" && instr.target.name === IR_STRING_COMPARE_FN) {
      usesStringOp = true;
    }
    if (instr.kind === "extern.regex") {
      // RegExp literal lowers via emitStringConst(pattern) + emitStringConst(flags).
      usesStringOp = true;
      literals.add(instr.pattern);
      literals.add(instr.flags);
    }
    if (instr.kind === "forof.vec" || instr.kind === "forof.iter" || instr.kind === "forof.string") {
      for (const sub of instr.body) walk(sub);
    }
    // (#3156) Value-producing if/else arms and try bodies are nested instr
    // buffers too — a `s.charCodeAt(i)` (or any string op) inside a ternary
    // arm or try block would otherwise escape pre-registration.
    if (instr.kind === "if") {
      for (const sub of instr.then) walk(sub);
      for (const sub of instr.else) walk(sub);
    }
    if (instr.kind === "try") {
      for (const sub of instr.body) walk(sub);
      if (instr.catchClause) for (const sub of instr.catchClause.body) walk(sub);
      if (instr.finallyBody) for (const sub of instr.finallyBody) walk(sub);
    }
  };
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const instr of block.instrs) walk(instr);
    }
  }
  if (!usesStringOp) return;

  if (!ctx.nativeStrings) {
    // Host-string backend: ensure all five `wasm:js-string` imports exist.
    addStringImports(ctx);
    // Pre-register every string literal as a global import. The helper is
    // idempotent on `value`, so repeat calls (e.g. literals also collected
    // by the legacy path) are no-ops.
    for (const value of literals) {
      addStringConstantGlobal(ctx, value);
    }
  }
  // Native strings: nothing to pre-register here. The native-string struct
  // types and helpers (`__str_concat`, `__str_equals`, `__str_flatten`) are
  // emitted up front by the legacy codegen whenever any string literal /
  // operation appears in source. The IR selector accepts `string` only when
  // a string operation appears in source, so the helpers are guaranteed to
  // exist by the time Phase 3 runs. (If they don't, the resolver throws
  // with a clear message and the caller falls back to legacy.)
}

function instrUsesStrings(instr: IrInstr): boolean {
  return (
    instr.kind === "string.const" ||
    instr.kind === "string.concat" ||
    instr.kind === "string.eq" ||
    instr.kind === "string.len"
  );
}

// ---------------------------------------------------------------------------
// Iterator pre-registration (#1182)
// ---------------------------------------------------------------------------

/**
 * Slice 6 part 3 (#1182): pre-register the iterator host imports if any
 * IR function emits an `iter.*` or `forof.iter` instr. Same pattern and
 * rationale as `preregisterStringSupport`: late import registration
 * shifts function indices, and we want the shift to be a no-op on the
 * IR path's `IrFuncRef` resolution.
 *
 * `addIteratorImports` is idempotent on `ctx.funcMap.has("__iterator")`,
 * so it's safe to call repeatedly.
 */
function preregisterIteratorSupport(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  const usesIter = (instr: IrInstr): boolean => {
    switch (instr.kind) {
      case "iter.new":
      case "iter.next":
      case "iter.done":
      case "iter.value":
      case "iter.return":
        return true;
      case "forof.iter": {
        // forof.iter is itself an iter user, but ALSO walk the body in
        // case the IR ever materialises iter.* directly inside.
        for (const sub of instr.body) {
          if (usesIter(sub)) return true;
        }
        return true;
      }
      case "forof.vec": {
        // A vec for-of body can syntactically contain nested iter ops.
        for (const sub of instr.body) {
          if (usesIter(sub)) return true;
        }
        return false;
      }
      default:
        return false;
    }
  };
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const instr of block.instrs) {
        if (usesIter(instr)) {
          if (ctx.standalone || ctx.wasi) {
            ctx.errors.push({
              message:
                "Codegen error: #681 standalone/WASI for-of over this iterable still requires the JS-host iterator protocol; " +
                "known array for-of lowers to an index loop, but generic/custom iterables need a future pure-Wasm Iterator Record path " +
                "(ECMA-262 §7.4 IteratorStepValue/IteratorClose, §14.7.5 for-of).",
              line: 0,
              column: 0,
              severity: "error",
            });
            return;
          }
          addIteratorImports(ctx);
          return;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Native-string helper pre-registration (#1183)
// ---------------------------------------------------------------------------

/**
 * Slice 6 part 4 (#1183): pre-register native-string helpers
 * (`__str_charAt`, `__str_concat`, `__str_equals`, `__str_flatten`, …)
 * if any IR function emits a `forof.string` instr. Same rationale as
 * `preregisterStringSupport` and `preregisterIteratorSupport` —
 * idempotent helper, called eagerly so Phase 3's funcref resolution
 * sees stable indices.
 *
 * `forof.string` is only produced by from-ast in native-strings mode,
 * so the helper call here is a no-op in host-strings mode.
 */
function preregisterNativeStringHelpers(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  if (!ctx.nativeStrings) return;
  const usesForOfString = (instr: IrInstr): boolean => {
    switch (instr.kind) {
      case "forof.string":
        return true;
      case "forof.vec":
      case "forof.iter":
        for (const sub of instr.body) {
          if (usesForOfString(sub)) return true;
        }
        return false;
      default:
        return false;
    }
  };
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const instr of block.instrs) {
        if (usesForOfString(instr)) {
          ensureNativeStringHelpers(ctx);
          return;
        }
      }
    }
  }
}

/**
 * Slice 9 (#1169h): pre-register the shared `__exn` exception tag if any
 * IR function emits `throw` or `try`. The tag itself doesn't shift
 * function indices (it lives in `ctx.mod.tags`), but pre-registering
 * keeps the resolver path uniform with other lazy registrations and
 * avoids a late `ensureExnTag` call mid-emission.
 */
function preregisterExceptionSupport(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  const usesExceptions = (instr: IrInstr): boolean => {
    switch (instr.kind) {
      case "throw":
        return true;
      case "try":
        return true;
      case "forof.vec":
      case "forof.iter":
      case "forof.string":
        for (const sub of instr.body) {
          if (usesExceptions(sub)) return true;
        }
        return false;
      default:
        return false;
    }
  };
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const instr of block.instrs) {
        if (usesExceptions(instr)) {
          ensureExnTag(ctx);
          return;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic (boxed-any) op lowering (#2949 slice 3)
// ---------------------------------------------------------------------------

/**
 * #2949 slice 3 — does this instruction carry a dynamic box/unbox/tag.test?
 * `jsTag` presence is the dynamic-operand discriminator for unbox/tag.test
 * (verifier R2/R3 make it REQUIRED exactly there and reject it elsewhere).
 */
/**
 * (#3143) The function names `addUnionImports` (src/codegen/index.ts) registers
 * — host `env::*` imports OR wasi/standalone native funcs of the same names. A
 * from-ast boxing/unboxing coercion can emit a DIRECT symbolic `call` to one of
 * these (bypassing the `box`/`unbox` IR instruction), relying on legacy's
 * dual-compile side effect to have registered it. Under IR-first that side
 * effect is skipped, so `preregisterDynamicSupport` must register the family
 * itself when it sees such a call. Kept in lockstep with `addUnionImports`.
 */
const UNION_IMPORT_FUNC_NAMES: ReadonlySet<string> = new Set([
  "__box_number",
  "__unbox_number",
  "__box_boolean",
  "__unbox_boolean",
  "__box_bigint",
  "__to_bigint",
  "__bigint_ctor",
  "__box_symbol",
  "__is_truthy",
  "__typeof",
  "__typeof_number",
  "__typeof_string",
  "__typeof_boolean",
  "__typeof_bigint",
  "__typeof_object",
  "__typeof_function",
  "__typeof_undefined",
]);

function isDynamicOp(instr: IrInstr): boolean {
  if (instr.kind === "box") return instr.toType.kind === "dynamic";
  if (instr.kind === "unbox" || instr.kind === "tag.test") return instr.jsTag !== undefined;
  // #2949 S5.1 — dyn.truthy always consumes the boxed-any carrier, so its
  // presence requires the dynamic backing (ensureAnyHelpers / addUnionImports).
  if (instr.kind === "dyn.truthy") return true;
  // #2949 S5.3 — dyn.to_number consumes the carrier and calls the canonical
  // ToNumber helper (`__any_to_f64` gc / `__unbox_number` host), so it requires
  // the dynamic backing pre-registered too.
  if (instr.kind === "dyn.to_number") return true;
  // #2949 S5.2 — dyn.eq consumes two carriers and calls the canonical equality
  // helpers, so it too requires the dynamic backing pre-registered.
  if (instr.kind === "dyn.eq") return true;
  // #3053 U1 / #2949 S5.4 — dyn.member_get calls `__dyn_member_get`, which is
  // built on the canonical any-helper family (`__any_from_extern_honest` /
  // `__any_to_extern` / `__box_*`), so it requires the dynamic backing too.
  // The helper itself is registered separately below (`ensureDynMemberGet`).
  if (instr.kind === "dyn.member_get") return true;
  return false;
}

/**
 * #3053 U1 — does this instruction lower through the unified dynamic-reader
 * carrier primitive `__dyn_member_get` (#3053 U0)? That helper is a DEFINED
 * function built at finalize by `ensureDynMemberGet`, gated on the
 * `ctx.usesDynMemberGet` latch; it must be REGISTERED up-front (before Phase 3)
 * so the handle's `emitMemberGet` can resolve its funcidx by name, exactly like
 * the any/eq helper families above.
 */
function usesDynMemberGet(instr: IrInstr): boolean {
  return instr.kind === "dyn.member_get";
}

/**
 * #2949 S5.2 — does this instruction lower through the canonical any-equality
 * helper family (`__any_strict_eq` / `__any_eq`, plus `__any_from_extern` in
 * host mode)? These are DEFINED functions built by `ensureAnyHelpers`, which
 * the host (non-fast) preregister path does NOT otherwise run — so a `dyn.eq`
 * in a host module needs the extra registration below.
 */
function usesDynEq(instr: IrInstr): boolean {
  return instr.kind === "dyn.eq";
}

/**
 * #2949 slice 3 — map a box target's tag refinement onto `boxToAny`'s
 * `jsType` hint. One partition table (js-tag.ts) → one hint vocabulary
 * (value-tags.ts); "unknown" reproduces the historical kind-keyed dispatch
 * exactly, so an unrefined box is behavior-identical to legacy's unbranded
 * `any` coercion.
 */
function jsTagToStaticType(
  hint: JsTag | undefined,
): "null" | "undefined" | "boolean" | "number" | "string" | "object" | "function" | "unknown" {
  switch (hint) {
    case JsTag.Null:
      return "null";
    case JsTag.Undefined:
      return "undefined";
    case JsTag.Boolean:
      return "boolean";
    case JsTag.NumberI32:
    case JsTag.NumberF64:
      return "number";
    case JsTag.String:
      return "string";
    case JsTag.Object:
      return "object";
    case JsTag.Function:
      return "function";
    default:
      return "unknown";
  }
}

/**
 * #2949 slice 3 — pre-register everything `makeDynamicLowering`'s emit
 * methods can resolve by name, BEFORE Phase-3 emission starts:
 *   - fast (gc strategy): `ensureAnyHelpers` — $AnyValue + the canonical
 *     `__any_box_*` / `__any_unbox_*` family. These are DEFINED functions
 *     (appended, no import shift), but ensureAnyHelpers also pulls string
 *     imports on some paths, so it must not fire mid-emission.
 *   - host: `addUnionImports` — `__box_number` / `__unbox_number` /
 *     `__unbox_boolean` / `__typeof_*`. This is a late-IMPORT registration
 *     that shifts every defined funcIdx; running it here (before any IR
 *     body buffer exists) makes the shift a no-op hazard-wise, exactly
 *     like `preregisterStringSupport`.
 * Both are idempotent, so overlapping legacy registration is a no-op.
 */
function preregisterDynamicSupport(ctx: CodegenContext, fns: readonly BuiltFnRef[]): void {
  let usesDynamicOps = false;
  let usesEq = false;
  let usesMemberGet = false;
  // (#3143) A from-ast lowering can emit a DIRECT named call to a member of the
  // `addUnionImports` family (`__box_number` / `__unbox_number` / `__box_boolean`
  // / …) rather than a `box`/`unbox` IR instruction — e.g. `coerceToExpectedExtern`
  // boxes f64→externref via `emitCall({name:"__box_number"})` (from-ast.ts:3355),
  // and `coerceReturnValue` unboxes via `__unbox_number`. Under the OVERLAY those
  // imports are registered as a side effect of legacy's own compile of the same
  // function (the documented dual-compile assumption at from-ast.ts:3345). Under
  // IR-first the legacy body is skipped, so that side effect never happens and the
  // funcref resolves to nothing — a hard `unknown function ref` at Phase 3. Detect
  // such a named call here (a `call` whose symbolic target is a union-import name)
  // and pre-register the family. `isDynamicOp` does NOT catch these: they are plain
  // `call` instrs, not the `box`/`unbox`/`dyn.*` kinds it inspects.
  let usesNamedUnionImport = false;
  // (#3143) `__extern_is_undefined` ((externref)->i32) is a from-ast-emitted
  // late-import helper (from-ast.ts:6261, `x !== undefined` on an externref)
  // that legacy registers on demand via `ensureLateImport` — another
  // dual-compile side effect IR-first skips. Detect + register the same way.
  let usesExternIsUndefined = false;
  for (const entry of fns) {
    for (const block of entry.fn.blocks) {
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (i) => {
          if (isDynamicOp(i)) usesDynamicOps = true;
          if (usesDynEq(i)) usesEq = true;
          if (usesDynMemberGet(i)) usesMemberGet = true;
          if (i.kind === "call") {
            if (UNION_IMPORT_FUNC_NAMES.has(i.target.name)) usesNamedUnionImport = true;
            else if (i.target.name === "__extern_is_undefined") usesExternIsUndefined = true;
          }
        });
      }
    }
  }
  // (#3143) A named union-import call needs the host/native import family
  // registered even when no `dyn.*` op is present (the boxing-coercion path).
  // `addUnionImports` covers host (env imports) AND wasi/standalone (native
  // funcs), is idempotent, and runs here — before any Phase-3 body buffer —
  // so its defined-funcIdx shift is hazard-free, exactly like the dynamic-op
  // path below. In `fast` (gc) mode the any-helper family owns boxing, but a
  // from-ast `__box_number` funcref is only emitted when the lane actually has
  // that host import (its `hasHostNumberBox` gate), so registering it here is
  // correct in every mode the call can appear.
  if (usesNamedUnionImport) addUnionImports(ctx);
  if (usesExternIsUndefined) {
    ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
    // (#3143) Apply the deferred import's funcIdx shift + defined-body fix-up
    // NOW, before Phase-3 emission bakes any funcIdx. `ensureLateImport` only
    // BATCHES the import; leaving it pending here desyncs the Phase-3 resolver
    // (a sibling IR function's `ctx.funcMap` funcIdx would be read pre-shift and
    // fall out of the defined-function range — the #329/#2078 late-shift class).
    // `addUnionImports` above already self-flushes; this covers the bare
    // extern-is-undefined path (no union import present).
    flushLateImportShifts(ctx, null);
  }
  if (!usesDynamicOps) return;
  if (ctx.fast) {
    // gc: ensureAnyHelpers registers $AnyValue + the __any_box_*/__any_unbox_*
    // family AND the equality helpers (__any_strict_eq / __any_eq) — one call
    // covers every gc dynamic op, dyn.eq included.
    ensureAnyHelpers(ctx);
  } else {
    // host: the classifier / box import family for box/unbox/tag.test/truthy.
    addUnionImports(ctx);
    // #2949 S5.2 — dyn.eq in host mode calls `__host_eq` (JS `===`) /
    // `__host_loose_eq` (JS `==`) — the SAME host-import equality legacy
    // `any === any` uses. Register them up-front (they are LATE IMPORTS that
    // shift defined funcIdxs) so no emit can trigger a mid-emission shift
    // (#329/#2078), exactly like `addUnionImports` above. Both are idempotent;
    // only fired when a host module actually carries a dyn.eq.
    if (usesEq) {
      ensureLateImport(ctx, "__host_eq", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
      ensureLateImport(ctx, "__host_loose_eq", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    }
  }
  // #3053 U1 — a `dyn.member_get` present in any IR body needs the unified
  // reader primitive `__dyn_member_get` (#3053 U0) REGISTERED up-front so the
  // handle's `emitMemberGet` resolves its funcidx by name at emit time (the
  // finalize `ensureDynMemberGet` runs AFTER Phase 3, too late for that). Flip
  // the latch and register here; `ensureDynMemberGet` mints only DEFINED funcs
  // (`addFuncType` + `mintDefinedFunc` — no import shift) and reuses the any-
  // helper family just registered above, so this is funcidx-shift-safe at
  // preregister time. It self-guards (bails, resetting the latch, if the object
  // runtime's `__extern_get` is not yet registered), and the finalize pass is
  // then idempotent via the `dynMemberGetHelpersEmitted` latch. Byte-inert
  // until S5.P (U2) opens the selector scan: no from-ast producer emits
  // `dyn.member_get` in a claimed function today, so `usesMemberGet` is never
  // set in a production compile.
  if (usesMemberGet) {
    ctx.usesDynMemberGet = true;
    ensureDynMemberGet(ctx);
  }
}

/**
 * #2949 slice 3 — the PRODUCTION `IrDynamicLowering` factory (see
 * `backend/handles.ts` for the full contract, incl. the V2 numeric-class
 * tag.test rule and the payload-field table). Exported so tests exercise
 * the exact implementation the compiler uses, not a mock.
 *
 * Mode split MUST mirror `resolveDynamic()` (same `ctx.fast` test — the
 * carrier and its ops are one decision):
 *   - fast → "gc": `ref_null $AnyValue`; box via `boxToAny` (THE canonical
 *     tag-selection policy — same helper family, same tags, byte-parity
 *     with legacy's `any` coercion for the same operand kind); unbox via
 *     the canonical `__any_unbox_f64` / `__any_unbox_i32` readers (V2:
 *     they accept BOTH numeric tags) or a direct payload `struct.get`;
 *     tag.test via a tag-field read.
 *   - non-fast → "host": externref; `__box_number` family + `__typeof_*`
 *     classifier imports (registered by `preregisterDynamicSupport`).
 *
 * Every funcIdx is resolved BY NAME at emit time (never captured at handle
 * creation) — the #2191/#2193 name-based-repoint discipline.
 *
 * Producer contracts the emit arms rely on (enforced upstream, asserted
 * here defensively):
 *   - unbox is only emitted under a tag.test proof (verifier R2 field
 *     rules + producer discipline) — a wasm-null gc carrier traps.
 *   - a BOOLEAN-branded i32 must not be boxed through `emitBox` (both
 *     strategies box bare i32 as a NUMBER, matching legacy's unbranded
 *     kind-keyed dispatch); a boolean-aware box needs the jsType hint
 *     plumbed through — a later producer slice.
 */
export function makeDynamicLowering(ctx: CodegenContext): IrDynamicLowering | null {
  if (ctx.fast) {
    ensureAnyValueType(ctx);
    const anyTypeIdx = ctx.anyValueTypeIdx;
    const callHelper = (name: string): Instr => {
      const idx = ctx.funcMap.get(name);
      if (idx === undefined) {
        throw new Error(
          `ir/integration: ${name} not registered — preregisterDynamicSupport must run before Phase 3 (#2949)`,
        );
      }
      return { op: "call", funcIdx: idx };
    };
    const payloadFieldIdx = (tag: JsTag): number => {
      switch (jsTagUnboxKind(tag)) {
        case "i32":
          return 1; // i32val (NumberI32 / Boolean)
        case "f64":
          return 2; // f64val (NumberF64)
        case "ref":
          // String rides extern-shaped in `externval` under tag 5 in BOTH
          // string modes (the #42 / tag-5-field-4 contract); Object and
          // Function refs ride in `refval` (eqref).
          return tag === JsTag.String ? 4 : 3;
        default:
          throw new Error(`ir/integration: JsTag ${JsTag[tag]} is a singleton partition — no payload field (#2949)`);
      }
    };
    return {
      carrier: { kind: "ref_null", typeIdx: anyTypeIdx },
      strategy: "gc",
      anyValueTypeIdx: anyTypeIdx,
      tagFieldIdx: 0,
      payloadFieldIdx,
      emitBox(from: ValType, hint?: JsTag): readonly Instr[] {
        // Route through boxToAny — THE canonical boxing entry point. It only
        // touches `fctx.body`, so a body-only context shim is sound; using it
        // (instead of re-deriving the helper choice here) keeps ONE
        // kind→tag policy for legacy and IR (June-audit D4), including the
        // native-string re-tag arm and the honestAnyBoxing flag behavior.
        // The refinement hint maps onto boxToAny's jsType hint verbatim —
        // same "never override representation" contract.
        const shim = { body: [] } as unknown as FunctionContext;
        if (!boxToAny(ctx, shim, from, jsTagToStaticType(hint))) {
          throw new Error(
            `ir/integration: no canonical boxing arm for operand kind "${from.kind}" — ` +
              `was preregisterDynamicSupport skipped? (#2949)`,
          );
        }
        return shim.body;
      },
      emitUnbox(tag: JsTag): readonly Instr[] {
        switch (tag) {
          case JsTag.NumberF64:
            // V2 numeric class: the canonical reader converts a tag-2 i32
            // payload, so a class-proven "number" always reads correctly.
            return [callHelper("__any_unbox_f64")];
          case JsTag.NumberI32:
            // V2 numeric class: trunc-sats a tag-3 f64 payload.
            return [callHelper("__any_unbox_i32")];
          case JsTag.Boolean:
          case JsTag.String:
          case JsTag.Object:
          case JsTag.Function:
            // Exact-tag partitions: direct payload read after the proof.
            return [{ op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: payloadFieldIdx(tag) }];
          default:
            throw new Error(`ir/integration: cannot unbox singleton partition ${JsTag[tag]} (#2949 R2)`);
        }
      },
      emitTagTest(tag: JsTag): readonly Instr[] {
        if (tag === JsTag.NumberI32 || tag === JsTag.NumberF64) {
          // Numeric CLASS test (V2): tag ∈ {2,3} ⇔ (tag − 2) ≤u 1. Keeps
          // gc and host tag.test semantics identical — host `typeof` has
          // exactly one "number".
          return [
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
            { op: "i32.const", value: JsTag.NumberI32 },
            { op: "i32.sub" },
            { op: "i32.const", value: 1 },
            { op: "i32.le_u" },
          ];
        }
        return [
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "i32.const", value: tag },
          { op: "i32.eq" },
        ];
      },
      emitToBoolean(): readonly Instr[] {
        // #2949 S5.1 — ToBoolean(carrier) via THE canonical coercion-engine
        // path (D4): for the `$AnyValue` carrier it emits `__any_unbox_bool`
        // (proper JS truthiness — `0`/`NaN`/`""`/`null`/`undefined` falsy).
        // `ensureAnyHelpers` already ran in `preregisterDynamicSupport`, so
        // the internal `ensureAnyHelpers` here is an idempotent no-op — no
        // mid-emission funcIdx shift.
        return emitCoercionToBoolean(ctx, { kind: "ref_null", typeIdx: anyTypeIdx }, []);
      },
      emitToNumber(): readonly Instr[] {
        // #2949 S5.3 — ToNumber(carrier) for the gc `$AnyValue` carrier via
        // `__any_to_f64`: THE canonical boxed-any→f64 helper legacy's
        // `__any_lt`/`__any_gt`/… + arithmetic helpers use (null→0, undefined→
        // NaN, boolean→0/1, number→value) — one ToNumber engine (D4). Chosen
        // directly rather than through `coercion-engine.emitToNumber`, whose
        // `$AnyValue` arm routes to `coerceType(…,"number")` and allocates a
        // temp local (via `allocTempLocal`), which the handle's pure `Instr[]`
        // contract cannot supply. `ensureAnyHelpers` (run up-front in
        // `preregisterDynamicSupport`) registers `__any_to_f64`, so `callHelper`
        // resolves it by name with no mid-emission funcIdx shift.
        return [callHelper("__any_to_f64")];
      },
      emitEqOperand(): readonly Instr[] {
        // #2949 S5.2 — the gc carrier IS `(ref null $AnyValue)`, already the
        // `__any_strict_eq`/`__any_eq` parameter shape. No marshalling.
        return [];
      },
      emitStrictEq(negate: boolean): readonly Instr[] {
        // Canonical `===` engine (D4): the tag-5 classifier — cross-type
        // falsity, numeric-class `23 === 23.0`, `NaN === NaN → false`
        // (`f64.eq`), reference identity — lives in `__any_strict_eq`'s body.
        return negate ? [callHelper("__any_strict_eq"), { op: "i32.eqz" }] : [callHelper("__any_strict_eq")];
      },
      emitLooseEq(negate: boolean): readonly Instr[] {
        return negate ? [callHelper("__any_eq"), { op: "i32.eqz" }] : [callHelper("__any_eq")];
      },
      emitMemberGet(): readonly Instr[] {
        // #3053 U1 / #2949 S5.4 — dynamic member read via the unified reader
        // primitive. The carrier IS `(ref null $AnyValue)`, exactly the
        // `__dyn_member_get(recv, key)` param shape, and the result is the same
        // carrier — no marshalling. Flip the latch that makes the finalize
        // `ensureDynMemberGet` pass build the helper; it was pre-registered
        // up-front by `preregisterDynamicSupport`, so `callHelper` resolves it
        // by name with no mid-emission funcidx shift.
        ctx.usesDynMemberGet = true;
        return [callHelper("__dyn_member_get")];
      },
      emitElementGet(): readonly Instr[] {
        // Indexed form — the reader is key-uniform (the helper's own
        // `__any_to_extern(key)` converts a boxed number key to a decimal
        // property key), so it lowers to the identical bare call.
        ctx.usesDynMemberGet = true;
        return [callHelper("__dyn_member_get")];
      },
    };
  }

  // Host (non-fast): externref carrier; ops via the union-import family.
  const callImport = (name: string): Instr => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) {
      throw new Error(
        `ir/integration: host import ${name} not registered — preregisterDynamicSupport must run before Phase 3 (#2949)`,
      );
    }
    return { op: "call", funcIdx: idx };
  };
  return {
    carrier: { kind: "externref" },
    strategy: "host",
    anyValueTypeIdx: -1,
    tagFieldIdx: -1,
    payloadFieldIdx(tag: JsTag): number {
      throw new Error(`ir/integration: host dynamic carrier has no payload fields (asked for ${JsTag[tag]})`);
    },
    emitBox(from: ValType, hint?: JsTag): readonly Instr[] {
      switch (from.kind) {
        case "f64":
          return [callImport("__box_number")];
        case "i32":
          // Boolean-REFINED i32 boxes as a host boolean (mirrors legacy's
          // type-aware coerceType, #2785). Unrefined i32 keeps NUMBER
          // semantics — identical to legacy's unbranded i32→externref
          // coercion.
          if (hint === JsTag.Boolean) {
            return [callImport("__box_boolean")];
          }
          return [{ op: "f64.convert_i32_s" }, callImport("__box_number")];
        case "externref":
          // Host strings / already-host-boxed values ARE the carrier.
          return [];
        case "ref":
        case "ref_null":
        case "eqref":
          // Struct/array/closure refs are anyref subtypes — re-tag.
          return [{ op: "extern.convert_any" }];
        default:
          throw new Error(`ir/integration: no host boxing arm for operand kind "${from.kind}" (#2949)`);
      }
    },
    emitUnbox(tag: JsTag): readonly Instr[] {
      switch (tag) {
        case JsTag.NumberF64:
          return [callImport("__unbox_number")];
        case JsTag.NumberI32:
          // Same narrowing the gc reader applies to a tag-3 payload.
          return [callImport("__unbox_number"), { op: "i32.trunc_sat_f64_s" }];
        case JsTag.Boolean:
          // ToBoolean on a PROVEN boolean is the identity payload read.
          return [callImport("__unbox_boolean")];
        case JsTag.String:
        case JsTag.Object:
        case JsTag.Function:
          // The host carrier IS the host value — identity.
          return [];
        default:
          throw new Error(`ir/integration: cannot unbox singleton partition ${JsTag[tag]} (#2949 R2)`);
      }
    },
    emitTagTest(tag: JsTag, scratch: () => number): readonly Instr[] {
      switch (tag) {
        case JsTag.NumberI32:
        case JsTag.NumberF64:
          // Numeric CLASS test (V2) — host typeof has one "number".
          return [callImport("__typeof_number")];
        case JsTag.String:
          return [callImport("__typeof_string")];
        case JsTag.Boolean:
          return [callImport("__typeof_boolean")];
        case JsTag.Function:
          return [callImport("__typeof_function")];
        case JsTag.Undefined:
          return [callImport("__typeof_undefined")];
        case JsTag.Null:
          // JS null crosses the boundary as THE null externref; undefined
          // is a real (non-null) host value — so ref.is_null is exactly
          // the Null partition test.
          return [{ op: "ref.is_null" }];
        case JsTag.Object: {
          // `typeof v === "object"` is true for null (host semantics);
          // the Object PARTITION excludes it. Read the operand twice via
          // the lazily-allocated carrier scratch local.
          const s = scratch();
          return [
            { op: "local.tee", index: s },
            callImport("__typeof_object"),
            { op: "local.get", index: s },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            { op: "i32.and" },
          ];
        }
        default:
          throw new Error(`ir/integration: no host tag.test arm for ${JsTag[tag]} (#2949)`);
      }
    },
    emitToBoolean(): readonly Instr[] {
      // #2949 S5.1 — ToBoolean(externref carrier) via the canonical
      // coercion-engine path (D4): `__is_truthy` (0/NaN/null/undefined/""
      // → falsy). `addUnionImports` already ran in
      // `preregisterDynamicSupport` (which registers `__is_truthy`), so the
      // internal `addUnionImports` / `ensureLateImport` here find the import
      // by name and add nothing — no import shift mid-emission.
      return emitCoercionToBoolean(ctx, { kind: "externref" }, []);
    },
    emitToNumber(): readonly Instr[] {
      // #2949 S5.3 — ToNumber(externref carrier) via THE canonical
      // `coercion-engine.emitToNumber` (D4): for the externref carrier it emits
      // a single `__unbox_number` (`Number(v)`, §7.1.4 — string→StringToNumber,
      // null→0, undefined→NaN, boolean→0/1). No temp-local allocation for the
      // externref arm (unlike the gc `$AnyValue` arm), so the body-only
      // `FunctionContext` shim is sound (same pattern as the gc `emitBox`).
      // `addUnionImports` already ran in `preregisterDynamicSupport` (which
      // registers `__unbox_number`), so the internal `addUnionImports` here
      // finds it by name and adds nothing — no import shift mid-emission.
      const shim = { body: [] } as unknown as FunctionContext;
      emitCoercionToNumber(ctx, shim, { kind: "externref" });
      return shim.body;
    },
    emitEqOperand(): readonly Instr[] {
      // #2949 S5.2 — the host carrier is `externref`, which is EXACTLY the
      // `(externref, externref)` shape `__host_eq` / `__host_loose_eq` take.
      // No marshalling — legacy host `any === any` compares the raw externrefs
      // (verified: a `boxToAny`+`__any_eq` marshalling DIVERGES — it drops the
      // §7.2.15 coercions, giving `"5" == 5 → false`; the `__any_eq` path is the
      // STANDALONE `noJsHost` branch in binary-ops, not host's).
      return [];
    },
    emitStrictEq(negate: boolean): readonly Instr[] {
      // #2949 S5.2 — host STRICT `===` via the SAME `__host_eq` (JS `===`,
      // §7.2.16) legacy host `any === any` uses (D4, byte-parity with the host
      // runtime result). `__host_eq` is a host import in this (non-fast,
      // JS-host) mode; standalone/wasi is the `gc` strategy, which uses the
      // native `__any_strict_eq` instead — so there is no host-import leak into
      // a host-free module.
      return negate ? [callImport("__host_eq"), { op: "i32.eqz" }] : [callImport("__host_eq")];
    },
    emitLooseEq(negate: boolean): readonly Instr[] {
      // Host LOOSE `==` via `__host_loose_eq` (JS `==`, §7.2.15) — the coercion
      // arms (String⇄Number, `null == undefined`) are JS's, matching legacy.
      return negate ? [callImport("__host_loose_eq"), { op: "i32.eqz" }] : [callImport("__host_loose_eq")];
    },
    emitMemberGet(): readonly Instr[] {
      // #3053 U1 / #2949 S5.4 — dynamic member read. In host mode the carrier
      // IS `externref` and `__dyn_member_get` is a thin `__extern_get` wrapper
      // (a DEFINED function, resolved by name — same funcMap lookup as
      // `callImport`), so the read is a bare call with no box/peel. Flip the
      // latch the finalize `ensureDynMemberGet` reads.
      ctx.usesDynMemberGet = true;
      return [callImport("__dyn_member_get")];
    },
    emitElementGet(): readonly Instr[] {
      ctx.usesDynMemberGet = true;
      return [callImport("__dyn_member_get")];
    },
  };
}

// ---------------------------------------------------------------------------
// Object struct registry (#1169b)
// ---------------------------------------------------------------------------

/**
 * Hash-based registry for `IrObjectShape` → WasmGC struct mappings.
 *
 * Slice-2 invariants:
 *   - Same canonical shape always maps to the same struct typeIdx.
 *   - The registry hashes shapes the same way as the legacy
 *     `fieldsHashKey` in `codegen/index.ts`, so a shape registered by
 *     legacy `ensureStructForType` and a shape registered through the IR
 *     converge on a single anonymous struct (`__anon_<n>`).
 *   - Field reference types are widened from `ref` to `ref_null` so
 *     `struct.new` defaults match the legacy `ensureStructForType`
 *     pattern (`codegen/index.ts:4584-4589`).
 *
 * Resolution can fail with `null` when a field IrType cannot be lowered
 * to a ValType — the lowerer surfaces that as a clean error, so the
 * containing function falls back to legacy.
 */
class ObjectStructRegistry {
  private readonly cache = new Map<string, IrObjectStructLowering>();

  constructor(
    private readonly ctx: CodegenContext,
    private readonly resolveValType: (t: IrType) => ValType,
  ) {}

  resolve(shape: IrObjectShape): IrObjectStructLowering | null {
    const key = this.hashKey(shape);
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Lower each field IrType to a ValType. If any field is a kind we
    // can't lower, bail with null so the caller throws a clean error
    // and the function falls back to legacy.
    const fields: FieldDef[] = [];
    for (const f of shape.fields) {
      let wasm: ValType;
      try {
        wasm = this.resolveValType(f.type);
      } catch {
        return null;
      }
      // Widen non-null refs to ref_null so struct.new with default
      // initialization works — matches `codegen/index.ts:4584-4589`.
      if (wasm.kind === "ref") {
        wasm = { kind: "ref_null", typeIdx: wasm.typeIdx };
      }
      fields.push({ name: f.name, type: wasm, mutable: true });
    }

    // Reuse an existing anonymous struct with the same legacy hash key
    // if one was already registered (legacy↔IR convergence).
    const legacyKey = legacyFieldsHashKey(fields);
    let structName = this.ctx.anonStructHash.get(legacyKey);
    let typeIdx: number;
    if (structName !== undefined) {
      typeIdx = this.ctx.structMap.get(structName)!;
      // The structFields entry already exists from the legacy
      // registration; reuse it rather than overwriting.
    } else {
      structName = `__anon_${this.ctx.anonTypeCounter++}`;
      typeIdx = this.ctx.mod.types.length;
      this.ctx.mod.types.push({
        kind: "struct",
        name: structName,
        fields,
      } as StructTypeDef);
      this.ctx.structMap.set(structName, typeIdx);
      this.ctx.typeIdxToStructName.set(typeIdx, structName);
      this.ctx.structFields.set(structName, fields);
      this.ctx.anonStructHash.set(legacyKey, structName);
    }

    const fieldIdxByName = new Map<string, number>();
    fields.forEach((f, i) => fieldIdxByName.set(f.name, i));
    const lowering: IrObjectStructLowering = {
      typeIdx,
      fieldIdx: (name: string): number => {
        const idx = fieldIdxByName.get(name);
        if (idx === undefined) {
          throw new Error(`ir/integration: shape has no field "${name}"`);
        }
        return idx;
      },
    };
    this.cache.set(key, lowering);
    return lowering;
  }

  /**
   * Canonical hash for a shape — names + recursive IR-type keys, joined
   * with stable separators. Different shapes always hash differently;
   * structurally identical shapes (already pre-sorted by name in the
   * builder) always hash identically.
   */
  private hashKey(shape: IrObjectShape): string {
    return shape.fields.map((f) => `${f.name}:${irTypeKey(f.type)}`).join("|");
  }
}

/**
 * Recursive IrType→string key for shape hashing. Mirrors the legacy
 * `fieldsHashKey` format closely so identical shapes registered through
 * either path collide on a single struct (although the actual
 * legacy/IR convergence is enforced via `legacyFieldsHashKey` on the
 * lowered ValTypes — this key is the IR-side memo).
 */
function irTypeKey(t: IrType): string {
  if (t.kind === "val") {
    if (t.val.kind === "ref" || t.val.kind === "ref_null") {
      return `${t.val.kind}:${(t.val as { typeIdx: number }).typeIdx}`;
    }
    return t.val.kind;
  }
  if (t.kind === "string") return "string";
  if (t.kind === "object") {
    return `object{${t.shape.fields.map((f) => `${f.name}:${irTypeKey(f.type)}`).join(",")}}`;
  }
  if (t.kind === "closure") {
    const ps = t.signature.params.map(irTypeKey).join(",");
    return `closure(${ps})->${irTypeKey(t.signature.returnType)}`;
  }
  // Slice 4 (#1169d): class is keyed by name — uniqueness across the
  // compilation unit makes this safe.
  if (t.kind === "class") return `class:${t.shape.className}`;
  // Slice 10 (#1169i): extern is keyed solely on className.
  if (t.kind === "extern") return `extern:${t.className}`;
  // #1926 — union members / boxed inner are IrTypes; recurse.
  if (t.kind === "union") return `union<${t.members.map(irTypeKey).join(",")}>`;
  // #2949 — dynamic is keyed with its optional JsTag refinement: two
  // dynamics with different refinements are distinct types (irTypeEquals is
  // exact on the tag), so their keys must differ too.
  if (t.kind === "dynamic") return t.tag === undefined ? "dynamic" : `dynamic:${t.tag}`;
  return `boxed<${irTypeKey(t.inner)}>`;
}

/**
 * Mirror of `fieldsHashKey` in `src/codegen/index.ts`. Re-implemented
 * locally so the IR module doesn't pull on `codegen/index.ts`'s public
 * surface (which is large). The two implementations must stay in sync —
 * they're the legacy↔IR struct-dedup contract.
 */
function legacyFieldsHashKey(fields: readonly FieldDef[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const t = f.type;
    if (t.kind === "ref" || t.kind === "ref_null") {
      parts.push(`${f.name}:${t.kind}:${(t as { typeIdx: number }).typeIdx}`);
    } else {
      parts.push(`${f.name}:${t.kind}`);
    }
  }
  return parts.join("|");
}

// ---------------------------------------------------------------------------
// Closure / ref-cell registries (#1169c)
// ---------------------------------------------------------------------------

/**
 * Slice 3 (#1169c): per-signature closure struct registry. Maintains:
 *   - **base** structs (one per signature) — single-funcref-field
 *     supertype; carried by `IrType.closure` so all closures of the same
 *     signature share one Wasm value type.
 *   - **subtype** structs (one per `(signature, captureFieldTypes)`
 *     pair) — extends the base with capture fields. Constructed at
 *     each `closure.new` site; lifted bodies `ref.cast` __self to
 *     their corresponding subtype to read captures.
 */
class ClosureStructRegistry {
  private readonly baseCache = new Map<string, IrClosureLowering>();
  private readonly subCache = new Map<string, IrClosureLowering>();

  constructor(
    private readonly ctx: CodegenContext,
    private readonly resolveValType: (t: IrType) => ValType,
  ) {}

  resolveBase(sig: IrClosureSignature): IrClosureLowering | null {
    const key = sigKey(sig);
    const cached = this.baseCache.get(key);
    if (cached) return cached;

    // Synthesize the base struct: just the funcref field, no captures.
    // Mark as `superTypeIdx: -1` (root of hierarchy, non-final) so
    // subtypes can extend it. A bare struct with `superTypeIdx`
    // undefined is emitted as final by the Wasm spec, which would
    // make the subtype declaration invalid (`type N extends final
    // type M`).
    const baseStructIdx = this.ctx.mod.types.length;
    const baseStructName = `__ir_closure_base_${this.baseCache.size}`;
    const baseFields: FieldDef[] = [{ name: "func", type: { kind: "funcref" }, mutable: false }];
    this.ctx.mod.types.push({
      kind: "struct",
      name: baseStructName,
      fields: baseFields,
      superTypeIdx: -1,
    } as StructTypeDef);
    this.ctx.structMap.set(baseStructName, baseStructIdx);
    this.ctx.typeIdxToStructName.set(baseStructIdx, baseStructName);
    this.ctx.structFields.set(baseStructName, baseFields);

    // Lifted func type: (ref $base, ...sig.params) -> sig.returnType.
    let paramTypes: ValType[];
    let resultTypes: ValType[];
    try {
      paramTypes = sig.params.map((p) => this.resolveValType(p));
      resultTypes = [this.resolveValType(sig.returnType)];
    } catch {
      return null;
    }
    const liftedFuncTypeIdx = addFuncType(
      this.ctx,
      [{ kind: "ref", typeIdx: baseStructIdx }, ...paramTypes],
      resultTypes,
      `${baseStructName}_funcType`,
    );

    const lowering: IrClosureLowering = {
      structTypeIdx: baseStructIdx,
      funcFieldIdx: 0,
      capFieldIdx: () => {
        throw new Error("ir/integration: base closure struct has no captures");
      },
      funcTypeIdx: liftedFuncTypeIdx,
    };
    this.baseCache.set(key, lowering);
    return lowering;
  }

  resolveSubtype(sig: IrClosureSignature, captureFieldTypes: readonly IrType[]): IrClosureLowering | null {
    const key = `${sigKey(sig)}#${captureFieldTypes.map(irTypeKey).join(",")}`;
    const cached = this.subCache.get(key);
    if (cached) return cached;

    const base = this.resolveBase(sig);
    if (!base) return null;

    const fields: FieldDef[] = [{ name: "func", type: { kind: "funcref" }, mutable: false }];
    for (let i = 0; i < captureFieldTypes.length; i++) {
      let ft: ValType;
      try {
        ft = this.resolveValType(captureFieldTypes[i]!);
      } catch {
        return null;
      }
      fields.push({ name: `cap${i}`, type: ft, mutable: false });
    }

    const subIdx = this.ctx.mod.types.length;
    const subName = `__ir_closure_${this.subCache.size}`;
    this.ctx.mod.types.push({
      kind: "struct",
      name: subName,
      fields,
      superTypeIdx: base.structTypeIdx,
    } as StructTypeDef);
    this.ctx.structMap.set(subName, subIdx);
    this.ctx.typeIdxToStructName.set(subIdx, subName);
    this.ctx.structFields.set(subName, fields);

    const fieldIdxByCap = new Map<number, number>();
    for (let i = 0; i < captureFieldTypes.length; i++) fieldIdxByCap.set(i, i + 1);

    const lowering: IrClosureLowering = {
      structTypeIdx: subIdx,
      funcFieldIdx: 0,
      capFieldIdx: (i: number): number => {
        const v = fieldIdxByCap.get(i);
        if (v === undefined) throw new Error(`ir/integration: closure subtype has no capture index ${i}`);
        return v;
      },
      // call_ref dispatches via the BASE func type — subtype shares it.
      funcTypeIdx: base.funcTypeIdx,
    };
    this.subCache.set(key, lowering);
    return lowering;
  }
}

function sigKey(sig: IrClosureSignature): string {
  const ps = sig.params.map(irTypeKey).join(",");
  return `(${ps})->${irTypeKey(sig.returnType)}`;
}

/**
 * Slice 3 (#1169c): trivial wrapper around the legacy
 * `getOrRegisterRefCellType` so legacy and IR ref cells share a single
 * WasmGC struct per inner ValType.
 */
class RefCellRegistry {
  constructor(private readonly ctx: CodegenContext) {}

  resolve(inner: ValType): IrRefCellLowering | null {
    const typeIdx = getOrRegisterRefCellType(this.ctx, inner);
    return { typeIdx, fieldIdx: 0 };
  }
}

/**
 * #3000-C: the default value pushed for one struct field when allocating a
 * fresh class instance (the `class.alloc` IR instr). Mirrors the `newBody`
 * default switch in `class-bodies.ts` (the legacy `<className>_new` alloc
 * prefix) EXACTLY — the `__tag` slot gets the class discrimination constant,
 * every other field gets its ValType zero/null. Keeping this identical to the
 * legacy switch is what makes the IR-emitted allocation byte-compatible with
 * the struct the legacy path builds.
 */
function defaultFieldAllocInstr(field: FieldDef, tagValue: number): Instr {
  if (field.name === "__tag") return { op: "i32.const", value: tagValue };
  switch (field.type.kind) {
    case "f64":
      return { op: "f64.const", value: 0 };
    case "i32":
      return { op: "i32.const", value: 0 };
    case "externref":
      return { op: "ref.null.extern" };
    case "ref":
    case "ref_null":
      return { op: "ref.null", typeIdx: field.type.typeIdx };
    case "i64":
      return { op: "i64.const", value: 0n };
    case "eqref":
      return { op: "ref.null.eq" };
    default:
      // Legacy fallback for any unhandled type — push i32 0 (mirrors
      // class-bodies.ts). A mis-typed default can only make `struct.new`
      // fail validation (a clean legacy fallback via the caller's try),
      // never miscompile.
      return { op: "i32.const", value: 0 };
  }
}

/**
 * Slice 4 (#1169d): per-class lookup over the legacy class registry.
 *
 * The legacy `collectClassDeclaration` pass (in `class-bodies.ts`)
 * registers, for each class declared in source:
 *   - a struct type in `ctx.structMap` (key = className)
 *   - the canonical fields list in `ctx.structFields` (with `__tag` at
 *     field 0 for root classes)
 *   - a constructor function `<className>_new` in `ctx.funcMap`
 *   - one method function `<className>_<methodName>` per instance
 *     method in `ctx.funcMap`
 *
 * `ClassRegistry.resolve` maps an `IrClassShape` to that legacy state
 * via the `className`, with one defensive lookup per resolution call so
 * a class that wasn't registered (e.g. shape was synthesized incorrectly)
 * surfaces as `null` and the caller falls back to legacy.
 *
 * Cached per className for cheap re-resolution.
 */
class ClassRegistry {
  private readonly cache = new Map<string, IrClassLowering>();

  constructor(private readonly ctx: CodegenContext) {}

  resolve(shape: IrClassShape): IrClassLowering | null {
    const cached = this.cache.get(shape.className);
    if (cached) return cached;

    const structTypeIdx = this.ctx.structMap.get(shape.className);
    if (structTypeIdx === undefined) return null;
    const legacyFields = this.ctx.structFields.get(shape.className);
    if (!legacyFields) return null;

    // Build a name → wasm-field-index map directly from the legacy
    // struct field list so the IR sees the same indices the legacy
    // path uses for `struct.get` / `struct.set`. The `__tag` prefix
    // (at index 0 for root classes) is included in legacyFields, so a
    // user field "x" at IR position 0 corresponds to legacy field
    // index 1 (or higher, depending on the parent chain). Slice 4
    // doesn't claim functions referencing inherited classes, so
    // legacyFields[0] is always `__tag`; user fields start at index 1.
    const fieldIdxByName = new Map<string, number>();
    for (let i = 0; i < legacyFields.length; i++) {
      fieldIdxByName.set(legacyFields[i]!.name, i);
    }

    // (#1983) Route synthetic class-member names through `classMemberFuncKey`
    // so the IR backend resolves the SAME (possibly relocated) funcMap key the
    // legacy pass registered. Without this, a class whose `${className}_new` /
    // `${className}_${method}` key collided with a user function resolves to the
    // user function's funcIdx (wrong signature → validation trap). Identical to
    // the legacy name for every non-colliding class.
    const ctx = this.ctx;
    const constructorFuncName = classMemberFuncKey(ctx, `${shape.className}_new`);
    // #3000-E: the parent-init entry a derived `super(...)` chains to. Legacy
    // registers `<className>_init` for every non-externref-backed class (the
    // only kind that can be an IR subclass parent), keyed the same way.
    const initFuncName = classMemberFuncKey(ctx, `${shape.className}_init`);

    // #3000-C: precompute the default-alloc instruction prefix so the
    // `class.alloc` IR instr (used by the IR constructor-body lowering to
    // synthesise `this`) emits the SAME allocation the legacy
    // `<className>_new` emits before its tail-call to `<className>_init`.
    // The field defaults + `__tag` constant mirror `class-bodies.ts`
    // (the `newBody` loop) exactly, keyed off the SAME `legacyFields` /
    // `classTagMap`, so the emitted `struct.new` prefix is byte-identical.
    const tagValue = ctx.classTagMap.get(shape.className) ?? 0;
    const allocInstrs: Instr[] = [];
    for (const field of legacyFields) {
      allocInstrs.push(defaultFieldAllocInstr(field, tagValue));
    }
    allocInstrs.push({ op: "struct.new", typeIdx: structTypeIdx });

    // (#3144) instanceof-compatible tags: own tag + every transitive
    // descendant's. Mirrors legacy `collectInstanceOfTags` (typeof-delete.ts)
    // exactly — the walk finds children via `classParentMap` (child → parent)
    // so `class.instanceof` compares the identical set `compileInstanceOf`
    // emits. Empty when the class has no tag (lowering folds to false).
    const collectTags = (className: string, seen: Set<string>): number[] => {
      if (seen.has(className)) return []; // circular-inheritance guard
      seen.add(className);
      const ownTag = ctx.classTagMap.get(className);
      if (ownTag === undefined) return [];
      const tags = [ownTag];
      for (const [child, parent] of ctx.classParentMap) {
        if (parent === className) tags.push(...collectTags(child, seen));
      }
      return tags;
    };
    const instanceOfTags = collectTags(shape.className, new Set());

    const lowering: IrClassLowering = {
      structTypeIdx,
      fieldIdx: (name: string): number => {
        const idx = fieldIdxByName.get(name);
        if (idx === undefined) {
          throw new Error(`ir/integration: class ${shape.className} has no field "${name}"`);
        }
        return idx;
      },
      constructorFuncName,
      initFuncName,
      instanceOfTags,
      methodFuncName: (name: string): string => {
        // Returns a NAME — the resolver's `resolveFunc` maps it to the
        // funcIdx via `ctx.funcMap`, which the legacy collection pass
        // populated with stable indices. (#1983) collision-free key.
        return classMemberFuncKey(ctx, `${shape.className}_${name}`);
      },
      allocInstrs,
    };
    this.cache.set(shape.className, lowering);
    return lowering;
  }
}
