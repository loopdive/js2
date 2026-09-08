// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ts } from "../ts-api.js";
import { collectUnsafePrimitiveFlows } from "./primitive-semantic-safety.js";
import { collectStructuralUnsoundness } from "./structural-semantic-safety.js";
import { collectUnsafeLookups } from "./lookup-semantic-safety.js";
import type { UnsafeTypeAssumption } from "./semantic-safety-types.js";

/** Known unsupported semantic flows: independent of TypeScript error suppression. */
export function collectUnsafeTypeAssumptions(
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  standalone: boolean,
): UnsafeTypeAssumption[] {
  return files.flatMap((file) =>
    file.isDeclarationFile
      ? []
      : [
          ...collectUnsafePrimitiveFlows(checker, file),
          ...collectStructuralUnsoundness(checker, file),
          ...collectUnsafeLookups(checker, file, { standalone }),
        ],
  );
}
