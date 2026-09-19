// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Diagnostic only: the canonical full-AST fingerprint remains the acceptance oracle.
import { createSourceFile, forEachChild } from "../.npm-upstream-suites/typescript/src/compiler/parser.js";
import { ScriptKind, ScriptTarget, SyntaxKind } from "../.npm-upstream-suites/typescript/src/compiler/types.js";
import type {
  Identifier,
  LiteralLikeNode,
  Node,
  NodeArray,
} from "../.npm-upstream-suites/typescript/src/compiler/types.js";

const sourceText =
  'import { isNodeLikeSystem } from "./_namespaces/ts.js";\r\n\r\n// The following definitions provide the minimum compatible support for the Web Performance User Timings API\r\n// between browsers and NodeJS:\r\n\r\n/** @internal */\r\nexport interface PerformanceHooks {\r\n    shouldWriteNativeEvents: boolean;\r\n    performance?: Performance;\r\n    performanceTime?: PerformanceTime;\r\n}\r\n\r\n/** @internal */\r\nexport interface PerformanceTime {\r\n    now(): number;\r\n    timeOrigin: number;\r\n}\r\n\r\n/** @internal */\r\nexport interface Performance extends PerformanceTime {\r\n    mark(name: string): void;\r\n    measure(name: string, startMark?: string, endMark?: string): void;\r\n    clearMeasures(name?: string): void;\r\n    clearMarks(name?: string): void;\r\n}\r\n\r\n// Browser globals for the Web Performance User Timings API\r\ndeclare const performance: Performance | undefined;\r\n\r\nfunction tryGetPerformance() {\r\n    if (isNodeLikeSystem()) {\r\n        try {\r\n            // By default, only write native events when generating a cpu profile or using the v8 profiler.\r\n            // Some environments may polyfill this module with an empty object; verify the object has the expected shape.\r\n            const { performance } = require("perf_hooks") as Partial<typeof import("perf_hooks")>;\r\n            if (performance) {\r\n                return {\r\n                    shouldWriteNativeEvents: false,\r\n                    performance,\r\n                };\r\n            }\r\n        }\r\n        catch {\r\n            // ignore errors\r\n        }\r\n    }\r\n\r\n    if (typeof performance === "object") {\r\n        // For now we always write native performance events when running in the browser. We may\r\n        // make this conditional in the future if we find that native web performance hooks\r\n        // in the browser also slow down compilation.\r\n        return {\r\n            shouldWriteNativeEvents: true,\r\n            performance,\r\n        };\r\n    }\r\n\r\n    return undefined;\r\n}\r\n\r\nfunction tryGetPerformanceHooks(): PerformanceHooks | undefined {\r\n    const p = tryGetPerformance();\r\n    if (!p) return undefined;\r\n    const { shouldWriteNativeEvents, performance } = p;\r\n\r\n    const hooks: PerformanceHooks = {\r\n        shouldWriteNativeEvents,\r\n        performance: undefined,\r\n        performanceTime: undefined,\r\n    };\r\n\r\n    if (typeof performance.timeOrigin === "number" && typeof performance.now === "function") {\r\n        hooks.performanceTime = performance;\r\n    }\r\n\r\n    if (\r\n        hooks.performanceTime &&\r\n        typeof performance.mark === "function" &&\r\n        typeof performance.measure === "function" &&\r\n        typeof performance.clearMarks === "function" &&\r\n        typeof performance.clearMeasures === "function"\r\n    ) {\r\n        hooks.performance = performance;\r\n    }\r\n\r\n    return hooks;\r\n}\r\n\r\nconst nativePerformanceHooks = tryGetPerformanceHooks();\r\nconst nativePerformanceTime = nativePerformanceHooks?.performanceTime;\r\n\r\n/** @internal */\r\nexport function tryGetNativePerformanceHooks(): PerformanceHooks | undefined {\r\n    return nativePerformanceHooks;\r\n}\r\n\r\n/**\r\n * Gets a timestamp with (at least) ms resolution\r\n *\r\n * @internal\r\n */\r\nexport const timestamp: () => number = nativePerformanceTime ? () => nativePerformanceTime.now() : Date.now;\r\n';

export function fieldHash(field: number): number {
  const source = createSourceFile("input.ts", sourceText, ScriptTarget.Latest, true, ScriptKind.TS);
  let hash = 0x811c9dc5;
  const mix = (value: number): void => {
    hash = Math.imul(hash ^ value, 0x01000193) >>> 0;
  };
  const mixText = (text: string): void => {
    mix(text.length);
    for (let index = 0; index < text.length; index++) mix(text.charCodeAt(index));
  };
  const visitArray = (nodes: NodeArray<Node>): void => {
    if (field === 4) {
      mix(nodes.pos);
      mix(nodes.end);
      mix(nodes.length);
    }
    if (field === 5) mix(nodes.hasTrailingComma ? 1 : 0);
    for (const node of nodes) visit(node);
  };
  const visit = (node: Node): void => {
    if (field === 0) mix(node.kind);
    if (field === 1) mix(node.pos);
    if (field === 2) mix(node.end);
    if (field === 3) mix(node.flags);
    if (field === 6) {
      if (node.kind === SyntaxKind.Identifier) mixText((node as Identifier).escapedText as string);
      if (node.kind === SyntaxKind.StringLiteral) mixText((node as LiteralLikeNode).text);
    }
    forEachChild(node, visit, visitArray);
  };
  visit(source);
  return hash;
}

export function nodeKinds(): number {
  return fieldHash(0);
}
export function nodePositions(): number {
  return fieldHash(1);
}
export function nodeEnds(): number {
  return fieldHash(2);
}
export function nodeFlags(): number {
  return fieldHash(3);
}
export function arrayMetadata(): number {
  return fieldHash(4);
}
export function trailingCommas(): number {
  return fieldHash(5);
}
export function texts(): number {
  return fieldHash(6);
}
