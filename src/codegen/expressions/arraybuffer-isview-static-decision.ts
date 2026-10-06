// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

interface IsViewClassMetadata {
  readonly standalone: boolean;
  readonly classExprNameMap: ReadonlyMap<string, string>;
  readonly classExternrefBackedSet: ReadonlySet<string>;
  readonly classBuiltinParentMap: ReadonlyMap<string, string>;
  readonly classParentMap: ReadonlyMap<string, string>;
}

interface IsViewRawType {
  isUnion(): boolean;
}

/** Undefined leaves the actual runtime brand test to the caller. */
export function arrayBufferIsViewStaticDecision(
  metadata: IsViewClassMetadata,
  argSym: string | undefined,
  isAnyOrUnknown: boolean,
  rawType: IsViewRawType,
  typedArrayNames: ReadonlySet<string>,
): boolean | undefined {
  const isView = argSym !== undefined && (typedArrayNames.has(argSym) || argSym === "DataView");
  const className = argSym === undefined ? undefined : (metadata.classExprNameMap.get(argSym) ?? argSym);
  // (#5150) Heritage admits this case to a runtime test, never constant true.
  const needsDataViewSubclassTest =
    metadata.standalone &&
    className !== undefined &&
    metadata.classExternrefBackedSet.has(className) &&
    metadata.classBuiltinParentMap.get(className) === "DataView" &&
    metadata.classParentMap.get(className) === "DataView";
  const isResolvableNonView =
    !isAnyOrUnknown &&
    !isView &&
    !needsDataViewSubclassTest &&
    argSym !== "BigInt64Array" &&
    argSym !== "BigUint64Array" &&
    !rawType.isUnion();
  if (isView || argSym === "BigInt64Array" || argSym === "BigUint64Array") return true;
  if (isResolvableNonView) return false;
  return undefined;
}
