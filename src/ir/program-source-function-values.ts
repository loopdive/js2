// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 S4) The value of a top-level function declaration on the Prepared whole-program path. A declaration read as
 * a value (`var g = f`, `return f`, `opts || f`) is a function value with Fa's all-dynamic signature: a closure over
 * a trampoline that calls the declaration's unit directly and puts its result into the carrier. Module-init creates
 * it once, before its first statement, as GlobalDeclarationInstantiation does, and stores it into the declaration's
 * dynamic home (the source-globals registry's `function-at-startup` row), which every read of the name reads.
 * Calls of the name stay direct calls of the declaration.
 */
import { ts } from "../ts-api.js";
import { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef, irUnitFuncRef } from "./callable-bindings.js";
import type { IrFunction, IrGlobalRef, IrInstr, IrValueId } from "./core/nodes.js";
import { irDynamic, type IrClosureSignature, type IrType } from "./core/types.js";
import type { AllocSiteRegistry } from "./analysis/alloc-registry.js";
import { irTypeIsBoolean } from "./boolean-brand.js";
import { recordLiftedUnitProvenance, type IrDerivedUnitProvenance } from "./identity.js";
import { JS_TAG_IDS } from "./js-tag-domain.js";
import { IrUnsupportedError } from "./outcomes.js";
import { fixedClosureParameters } from "./source-closure-invocation.js";
import { isValueReference } from "../shared/intrinsic-prototype-writes.js";
import { IR_DYN_CALL_BOX_FN } from "../shared/contracts/dynamic-call-helpers.js";
import { createDerivedIrUnitId } from "../shared/contracts/identity-values.js";
import type { IrFunctionIdentity, IrUnitId } from "../shared/contracts/ir-identity.js";

/**
 * The top-level declarations of `sourceFile` that some reference reads as a value: any but a call's or a `new`'s
 * callee, or an export specifier's local name (a module export, not a script read).
 */
export function functionDeclarationsReadAsValues(sourceFile: ts.SourceFile): readonly ts.FunctionDeclaration[] {
  const byName = new Map(
    sourceFile.statements.filter(ts.isFunctionDeclaration).flatMap((fn) => (fn.name ? [[fn.name.text, fn]] : [])),
  );
  const read = new Set<ts.FunctionDeclaration>();
  const visit = (node: ts.Node): void => {
    const declaration = ts.isIdentifier(node) ? byName.get(node.text) : undefined;
    if (declaration && isValueReference(node as ts.Identifier) && !isCalleeOrExport(node)) read.add(declaration);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...byName.values()].filter((declaration) => read.has(declaration));
}

function isCalleeOrExport(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isExportSpecifier(parent) ||
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node)
  );
}

/** A declaration whose value module-init creates into `home`. */
export interface StartupFunctionValue {
  readonly declaration: ts.FunctionDeclaration;
  /** The declaration's own unit. */
  readonly target: IrFunctionIdentity;
  readonly home: IrGlobalRef;
}

/** The parts of a lowered unit the startup function values extend. */
export interface LoweredUnit {
  readonly main: IrFunction;
  readonly lifted: readonly IrFunction[];
  readonly liftedUnitProvenance: readonly IrDerivedUnitProvenance[];
}

/**
 * `lowered` (a module-init) with `values` created first, each a `closure.new` of its trampoline stored into its home.
 * The prologue is logical IR, typed `closure` and boxed as from-ast boxes a function expression into a dynamic home,
 * so the legalization admits it as a function value and re-types its allocation like any other closure's.
 */
export function createStartupFunctionValues<Unit extends LoweredUnit>(
  lowered: Unit,
  values: readonly StartupFunctionValue[],
  signatures: ReadonlyMap<IrUnitId, IrClosureSignature>,
  allocations: AllocSiteRegistry,
): Unit {
  if (values.length === 0) return lowered;
  const owner = lowered.main.unitId;
  const liftedUnitProvenance = [...lowered.liftedUnitProvenance];
  let ordinal = nextDerivedOrdinal(liftedUnitProvenance, owner);
  let valueCount = lowered.main.valueCount;
  const prologue: IrInstr[] = [];
  const trampolines = values.map((value) => {
    const name = value.declaration.name!.text;
    const identity = {
      unitId: createDerivedIrUnitId({ parentId: owner, role: "lifted-closure", ordinal }),
      name: `${name}__value`,
      parentId: owner,
      role: "lifted-closure" as const,
      ordinal: ordinal++,
    };
    recordLiftedUnitProvenance(identity, { liftedUnitProvenance });
    const trampoline = functionValueTrampoline(value, identity, signatures.get(value.target.unitId)!);
    const signature = trampoline.closureSubtype!.signature;
    const closureType: IrType = { kind: "closure", signature };
    const closure = valueCount++ as IrValueId;
    const packed = valueCount++ as IrValueId;
    const dynamic = valueCount++ as IrValueId;
    prologue.push(
      {
        kind: "closure.new",
        liftedFunc: irUnitFuncRef(identity),
        signature,
        captureFieldTypes: [],
        captures: [],
        result: closure,
        resultType: closureType,
        alloc: allocations.fresh("closure", closureType),
      },
      // S11's `js.function.init(closure, name, length, flags)` fills the function object here, before it is stored.
      { kind: "coerce.to_externref", value: closure, result: packed, resultType: { kind: "callable", signature } },
      {
        kind: "call",
        target: irRuntimeFuncRef(IR_DYN_CALL_BOX_FN),
        args: [packed],
        result: dynamic,
        resultType: irDynamic(),
      },
      { kind: "global.set", target: value.home, value: dynamic, result: null, resultType: null },
    );
    return trampoline;
  });
  const [entry, ...rest] = lowered.main.blocks;
  return {
    ...lowered,
    main: {
      ...lowered.main,
      blocks: [{ ...entry!, instrs: [...prologue, ...entry!.instrs] }, ...rest],
      valueCount,
    },
    lifted: [...lowered.lifted, ...trampolines],
    liftedUnitProvenance,
  };
}

/**
 * The closure body `(__self, a0 … aN-1) → dynamic` of a declaration's value, N its formal count: the direct call of
 * the declaration, its result put into the carrier.
 */
function functionValueTrampoline(
  value: StartupFunctionValue,
  identity: IrFunctionIdentity,
  target: IrClosureSignature,
): IrFunction {
  const name = value.declaration.name!.text;
  if (target.params.some((param) => param.kind !== "dynamic"))
    unsupported(`function ${name} read as a value has a parameter that is not the dynamic value`);
  const signature: IrClosureSignature = { params: target.params, returnType: irDynamic() };
  const builder = new IrFunctionBuilder(identity, [irDynamic()]);
  builder.addParam("__self", { kind: "closure", signature });
  const args = value.declaration.parameters.map((_, index) => builder.addParam(`a${index}`, irDynamic()));
  builder.openBlock();
  const result = builder.emitCall(irUnitFuncRef(value.target), args, target.returnType);
  builder.terminate({ kind: "return", values: [intoCarrier(builder, result, target.returnType, name)] });
  return builder.finish({ signature, captureFieldTypes: [], ...fixedClosureParameters(value.declaration, signature) });
}

function intoCarrier(builder: IrFunctionBuilder, result: IrValueId | null, type: IrType | null, name: string) {
  if (type === null) return builder.emitDynUndefined();
  if (type.kind === "dynamic") return result!;
  if (irTypeIsBoolean(type)) return builder.emitBox(result!, irDynamic(JS_TAG_IDS.Boolean));
  if (type.kind === "val" && type.val.kind === "f64") return builder.emitBox(result!, irDynamic(JS_TAG_IDS.NumberF64));
  return unsupported(`function ${name} read as a value returns a value of type ${type.kind}`);
}

/** The first ordinal no lifted closure of `owner` has taken. */
function nextDerivedOrdinal(provenance: readonly IrDerivedUnitProvenance[], owner: IrUnitId): number {
  const taken = provenance.filter((row) => !("sourceUnit" in row) && row.parentId === owner).map((row) => row.ordinal);
  return taken.length === 0 ? 0 : Math.max(...taken) + 1;
}

function unsupported(detail: string): never {
  throw new IrUnsupportedError("type-resolution-unsupported", "build", detail);
}
