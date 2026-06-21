---
id: 2521
title: "Native Messaging host: re-chunked >1 MiB messages desync a 1:1 receiver — contract gap (receiver reassembly vs in-body continuation marker) + missing runtime test"
status: backlog
sprint: Backlog
created: 2026-06-20
updated: 2026-06-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: examples
language_feature: native-messaging
goal: usability
related: [1530]
---

## Problem (reproduced)

The Native Messaging example host (`examples/native-messaging/nm_js2wasm.ts`)
splits any message larger than 1 MiB into multiple ≤1 MiB response frames —
required, because Chrome caps a host→extension message at 1 MiB. Today each
re-chunked frame is a bare JSON array (`[run]`) with no marker, so **one logical
request produces N response frames with nothing tying them together**.

A receiver that expects one response per request (the standalone test harness,
and a naive extension) therefore desyncs: the big message's extra frames are
read as the responses to the *following* messages.

Reported on loopdive/js2#389. **Reproduced exactly** under deno 2.8.3 with the
reporter's `nm_standalone_test.js`:

- 64 MiB request (`Array(209715*64)`): the host emits ~64 frames of
  `messageLength: 1048571`; the harness reads each as a separate message.
- 2 MiB request: surfaces as the reporter's exact error
  `ArrayBuffer.prototype.resize: Invalid length parameter` once the stream
  desyncs.
- Matches the reporter's symptom precisely: "64 MiB alone passes, 64 MiB **with**
  the ≤1 MiB tests fails" — alone, the extra frames drain at EOF with nothing
  after to desync.

The host wasm logic is otherwise correct (single messages of any size, and the
full sequence via buffered/Node-pipe I/O, all round-trip cleanly). The gap is
the **re-chunk contract**, not codegen.

## This is a contract gap, fixable on EITHER side — two options

It is **not** strictly a host defect. The fix can live entirely on the receiver,
or on the host. Pick based on whether there is a non-echo consumer.

### Option A — receiver reassembles to expected size (no host change)

For an **echo in request/response**, the sender knows exactly what it sent, so it
can reassemble with **no marker**: read frames and concatenate `chunk` elements
until the reassembled length equals the sent length, then send the next message.
The expected size *is* the termination condition. The reporter's harness can do
this unilaterally (loop in `echoNativeMessage` until `got.length === sent.length`;
also lift its 1 MiB `buffer` cap). **If the reporter fixes his side this way, no
host change is needed — prefer this and skip Option B.**

Limitation: only works when the receiver originated the message (it knows the
size). A receiver that didn't send it (an extension getting an unsolicited large
broadcast) has no termination condition without a marker.

### Option B — host emits an in-body continuation marker (general case)

Needed only if there's a consumer that can't predict the size (broadcast), or as
a convenience so receivers don't each track expected sizes. Each frame becomes an
envelope:

```json
{ "chunk": [ …slice… ], "more": true  }   // non-final frame
{ "chunk": [ …slice… ], "more": false }   // final frame
```

Receiver concatenates `chunk` until `more:false` — no size needed.

**Constraint:** the marker MUST live inside the JSON body. In the browser Chrome
owns the 4-byte framing and delivers each frame to the extension already
JSON-parsed, so the length prefix's bits are unavailable — only the message
*value* survives to the receiver. (Each envelope must stay ≤1 MiB → drop
`MAX_RUN` by the ~25-byte envelope overhead.)

### Decision

Default to **Option A** (receiver-side). Only implement **Option B** if a
non-request/response consumer needs it. Track but don't build Option B until then.

If Option B is built: single-frame (≤1 MiB) messages emit one envelope with
`more:false` for a uniform receiver path (alternative: keep ≤1 MiB verbatim and
only envelope multi-frame — pick during implementation). Open design choice
(architect): plain `{chunk,more}` vs `{seq,total,chunk}` (explicit index/total).

## Test coverage gap (the reason this slipped through — fix regardless of A/B)

Today **nothing runs the example host's re-chunk path**:
- `tests/issue-1530.test.ts` first block is **compile-only** (module validity,
  imports) — explicitly does not assert content.
- Its `#1618/#1651` round-trip block runs a **toy inline host** (not the example's
  `emitRun`/re-chunk loop) and feeds a **single 7-byte message** (`frame('{"a":1}')`).
- So the >1 MiB re-chunking path and any **multi-message sequence** have zero
  runtime coverage — exactly where the desync lives.

Add a runtime test that drives the **actual example host** (via the existing
`runWasiRaw` shim) with: (a) a >1 MiB message → assert it emits N ≤1 MiB frames,
and (b) a **multi-message sequence** (a >1 MiB message followed by small ones) →
assert a correct receiver reassembles each without desync. This test would have
caught loopdive/js2#389 and guards whichever fix (A or B) lands.

## Scope

- **Test (do regardless):** add the runtime multi-message + >1 MiB re-chunk test
  above to `tests/issue-1530.test.ts`.
- **Option A (default):** update `examples/native-messaging/nm_standalone_test.js`
  guidance / the README to reassemble-to-expected-size; lift the receiver's 1 MiB
  buffer cap. No host change.
- **Option B (only if a non-echo consumer needs it):**
  `examples/native-messaging/nm_js2wasm.ts` `emitRun` wraps output in the
  envelope + shrink `MAX_RUN`; README documents the marker; the background.js
  example shows the reassembling receiver.

## Acceptance criteria

- **Test (DONE — `tests/issue-2521-native-messaging-rechunk.test.ts`):** drives
  the actual example host via the `runWasiRaw` shim and covers the reporter's
  cases — (a) ≤1 MiB message echoes verbatim in one frame, (b) a >1 MiB array is
  split into N ≤1 MiB valid-JSON-array frames that reassemble to the original,
  (c) the reporter's multi-message sequence (big then `"test"`/`""`/`1`/`{"0":97}`)
  reassembles with every frame accounted for (no desync). Passes on current main
  — it documents that the host's stream is correct/reassemblable and the #389
  failure is the harness's 1:1 assumption, and gives the runtime coverage the
  re-chunk path lacked. (If Option B lands, update it to the envelope shape.)
- **Option A:** the reporter's `nm_standalone_test.js` sequence (64 MiB + ≤1 MiB
  messages), updated to reassemble-to-expected-size, round-trips cleanly — no host
  change.
- **Option B (only if built):** each frame is ≤1 MiB valid JSON carrying the
  marker; a size-agnostic receiver reassembles correctly; ≤1 MiB messages still
  round-trip.

## Notes

Surfaced + reproduced while investigating loopdive/js2#389. The reproduction did
NOT require running the reporter's deno harness — counting the host's emitted
frames (Node) plus reading the harness's 1-frame-per-request reader was enough;
deno (installed locally) only added end-to-end fidelity. Pairs with the example's
existing re-chunk design in #1530.
