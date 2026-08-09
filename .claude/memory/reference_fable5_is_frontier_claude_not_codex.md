---
name: reference_fable5_is_frontier_claude_not_codex
description: "Team spans THREE frontier models: Opus 4.8 (this session), Fable 5 (claude-fable-5, Claude frontier, most expensive), and Codex GPT-5.6 sol (OpenAI frontier, slightly trailing Fable) which does the IR work on codex/<id> branches. fable is NOT codex and NOT cheaper than Opus."
metadata:
  node_type: memory
  type: reference
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
  modified: 2026-07-23T08:56:21.543Z
---

**User corrections (2026-07-21).** The team runs **three frontier model families** in parallel:

1. **Opus 4.8** (`claude-opus-4-8`) — THIS session: tech-lead orchestration + the Opus devs I
   spawn (Lane A).
2. **Fable 5** (`claude-fable-5`, Claude 5 family) — Claude's **frontier**, the **most capable
   and most expensive** of the three. NOT codex, NOT OpenAI, NOT "cheaper than Opus" (I had that
   exactly backwards).
3. **Codex / GPT-5.6 sol** — **OpenAI's frontier** model, **slightly trailing Fable** in
   capability. This is what does the **IR work** (backend-agnostic IR, IR full-coverage). Its
   PRs land on **`codex/<id>-slug`** branches — so the `codex/` prefix DOES indicate a real
   codex/OpenAI agent (do NOT tell yourself the prefix is model-agnostic — earlier over-correction).

**Rough capability/cost order:** Fable 5 ≳ Codex GPT-5.6 sol (both frontier, codex slightly
below) > Opus 4.8 > Sonnet 5 > Haiku 4.5.

**`model: frontier` — new lane-agnostic issue tag (user, 2026-07-23).** Spans BOTH Claude and
codex: it means "this needs a frontier model", satisfiable by Fable 5 OR codex GPT-5.6 sol —
unlike the lane-specific `model: fable` / `model: gpt-5.6-sol`. Treat `fable`,
`gpt-5.6-sol`, and `frontier` all as frontier-model work when routing; `opus` is the
distinct non-frontier-but-strong tier. Tag distribution when introduced (2026-07-23):
199 `fable`, 73 `opus`, 20 `gpt-5.6-sol`, **0 `frontier`** — the tag is new, so existing
issues have NOT been migrated; don't expect to find it yet.

**Why this matters (I got the topology wrong twice):**
- Do NOT call fable "cheaper" or a "fallback" — it's the top frontier Claude model.
- Do NOT conflate fable with codex — they're different vendors' frontier models.
- Routing my own **Opus** dev onto a Lane-B/IR issue is NOT "spending up" (the dev stays on
  Opus); the reason lane-crossing needs care is **dedup only** — codex (GPT-5.6) may already have
  that IR issue in flight on a `codex/` branch. Gate hard before claiming.

Model IDs (this env): Fable 5 `claude-fable-5`, Opus 4.8 `claude-opus-4-8`, Sonnet 5
`claude-sonnet-5`, Haiku 4.5 `claude-haiku-4-5-20251001`.

See [[feedback_mandatory_predispatch_gate_and_lane_partition]], [[feedback_devs_default_opus]],
[[feedback_po_uses_fable]].
