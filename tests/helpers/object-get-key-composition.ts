// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  invertConversionSource,
  invertPreWriteConversionSource,
  objectRuntimePath,
} from "./conversion-source-composition.js";

const BASE = "750fb7e7365692b315179dc909b57fa1407d4527";
const SOURCE_SHA = "692133e0345a24e3c45071ed031036b96dc3f6e7702dc358e2f99651820eed9e";
const RECEIPT_SHA = "441f90267d52ba734a6070e8fbdeece73fb6c86068ccec43affa89ff204aee5f";
export const objectRuntimeCompositionText = readFileSync(
  new URL("../fixtures/issue-3518-object-get-key-composition.json", import.meta.url),
  "utf8",
);
export type ObjectRuntimePeer = "key" | "getter";
interface Hunk {
  ordinal: number;
  baseStartLine: number;
  baseEndLine: number;
  peerStartLine: number;
  peerEndLine: number;
  before: string;
  after: string;
  beforeSha256: string;
  afterSha256: string;
}
interface Peer {
  commit: string;
  parent: string;
  sourceBlob: string;
  sourceSha256: string;
  hunks: Hunk[];
}
interface Receipt {
  schema: number;
  path: string;
  base: { commit: string; blob: string; sha256: string };
  peers: Record<ObjectRuntimePeer, Peer>;
}
const sha = (source: string) => createHash("sha256").update(source).digest("hex");
const expected = {
  key: { commit: "7a64d0b60cb11343128e0c5c0b006f4d2547ec28", count: 9 },
  getter: { commit: "4280967c297c5e33d14c55dca81af331785fd241", count: 8 },
};

/** Signed peer Git blobs were independently authenticated when this receipt was authored.
 * No candidate-derived joined hash or historical-receipt replacement is used.
 */
export function authenticateObjectRuntimeComposition(text: string): Receipt {
  if (sha(text) !== RECEIPT_SHA) throw new Error("object runtime composition receipt digest mismatch");
  const r = JSON.parse(text) as Receipt;
  if (
    r.schema !== 1 ||
    r.path !== "src/codegen/object-runtime.ts" ||
    r.base.commit !== BASE ||
    r.base.sha256 !== SOURCE_SHA
  )
    throw new Error("object runtime composition provenance mismatch");
  for (const name of ["key", "getter"] as const) {
    const peer = r.peers[name];
    if (peer.commit !== expected[name].commit || peer.parent !== BASE || peer.hunks.length !== expected[name].count)
      throw new Error("object runtime peer provenance mismatch");
    let priorEnd = 0;
    for (const [ordinal, hunk] of peer.hunks.entries()) {
      if (
        hunk.ordinal !== ordinal ||
        hunk.baseStartLine <= priorEnd ||
        hunk.baseEndLine < hunk.baseStartLine ||
        !hunk.before ||
        !hunk.after ||
        hunk.before === hunk.after ||
        sha(hunk.before) !== hunk.beforeSha256 ||
        sha(hunk.after) !== hunk.afterSha256
      )
        throw new Error("object runtime peer span mismatch");
      priorEnd = hunk.baseEndLine;
    }
  }
  return r;
}

function replacePeer(source: string, peer: Peer, inverse: boolean): string {
  let previousEnd = 0;
  const spans = peer.hunks.map((hunk) => {
    const from = inverse ? hunk.after : hunk.before,
      to = inverse ? hunk.before : hunk.after;
    const start = source.indexOf(from);
    if (start < 0 || source.indexOf(from, start + 1) !== -1)
      throw new Error(`object runtime peer span missing or duplicated: ${hunk.ordinal}`);
    if (start < previousEnd) throw new Error(`object runtime peer span order mismatch: ${hunk.ordinal}`);
    previousEnd = start + from.length;
    return { start, end: previousEnd, to };
  });
  for (const span of spans.reverse()) source = source.slice(0, span.start) + span.to + source.slice(span.end);
  return source;
}

/** The caller must still run its original full-source/donor checks on this result. */
export function invertObjectRuntimePeer(source: string, name: ObjectRuntimePeer): string {
  const peer = authenticateObjectRuntimeComposition(objectRuntimeCompositionText).peers[name];
  return replacePeer(invertConversionSource(objectRuntimePath, source), peer, true);
}

/** Undo the declared later conversion before consulting historical peer context. */
export function verifyObjectRuntimeComposition(source: string) {
  return verifyHistoricalObjectRuntimeComposition(invertConversionSource(objectRuntimePath, source));
}

/** Preserve older mutation controls on bytes actually reconstructed through the write inverse. */
export function verifyPreWriteObjectRuntimeComposition(source: string) {
  return verifyHistoricalObjectRuntimeComposition(invertPreWriteConversionSource(objectRuntimePath, source));
}

/** Both independent orders must reproduce each signed peer and the unchanged original. */
export function verifyHistoricalObjectRuntimeComposition(source: string) {
  const r = authenticateObjectRuntimeComposition(objectRuntimeCompositionText);
  const getterOnly = replacePeer(source, r.peers.key, true),
    keyOnly = replacePeer(source, r.peers.getter, true);
  if (sha(getterOnly) !== r.peers.getter.sourceSha256 || sha(keyOnly) !== r.peers.key.sourceSha256)
    throw new Error("object runtime signed peer source mismatch");
  const original = replacePeer(getterOnly, r.peers.getter, true);
  if (sha(original) !== SOURCE_SHA || replacePeer(keyOnly, r.peers.key, true) !== original)
    throw new Error("object runtime original source mismatch");
  if (replacePeer(keyOnly, r.peers.getter, false) !== source || replacePeer(getterOnly, r.peers.key, false) !== source)
    throw new Error("object runtime forward composition mismatch");
  return { original, keyOnly, getterOnly };
}
