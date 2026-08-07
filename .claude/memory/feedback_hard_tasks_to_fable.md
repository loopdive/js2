# Model routing: Opus implements; Fable SPECS the really hard ones

## ⚠ CURRENT RULE (project lead, 2026-08-07) — supersedes the 2026-08-04 rule below

> *"continue work with opus instead of fable"* … *"if something is really hard
> ask fable to spec it first"*

So the split is now by **phase**, not by difficulty:

| phase | model |
| --- | --- |
| implementation, all tiers | **Opus** |
| implementation spec for a **really hard** issue | **Fable**, written first |

For a `feasibility: hard` / `reasoning_effort: max` issue: spawn a **Fable
architect** to write the `## Implementation Plan` into the issue file, and an
**Opus** lane to implement it. They can run **in parallel** — the implementer's
instrument setup and reproduction are on its critical path regardless, and a
spec arriving mid-flight is still useful. Do not stall the implementer waiting
for the spec.

Tell the implementer explicitly that **its own measurement outranks the spec**.
Specs in this repo are useful and routinely wrong in their specifics — on
2026-08-06 three separate specs/handoffs named wrong root causes (a mixed-ternary
IR bail for units rejected at an earlier stage entirely; `propertyHelper.js:31`
when the trigger was any value-position mention of `Function`; a scope-tracking
defect when the cause was acorn's `copyNode`).

Give the architect a hard boundary: **spec only, do not edit `src/`**, because
the implementer is concurrently editing exactly those files.

This does **not** change the issue-frontmatter convention — `model:` in an issue
file still records who the work was scoped for; read it, but route by the phase
table above.

---

## Superseded (project lead, 2026-08-04) — kept for provenance

**Rule:** when spawning agents for HARD tasks —
`feasibility: hard`, `reasoning_effort: max`, core-codegen/dispatch changes,
anything with a documented prior regression — run them on **Fable**
(`model: "fable"` on the Agent spawn, or omit `model` when the main loop is
already Fable so the agent inherits it). Do not default hard work to Opus.

Routine/mechanical agent work (sweeps, doc moves, well-templated fixes) may
still use Opus/Sonnet tiers.

This matches the existing issue-frontmatter convention (`model: fable` +
`fable_role` on #743 and other max-effort issues) — the spawn should honor
what the issue file already declares.

Context: on 2026-08-04 the #4155 Phase 2 agent (member-dispatch fast path —
exactly the place #1712 once regressed) was spawned on Opus out of habit from
two earlier Opus successes; the lead corrected that hard tasks belong on
Fable. Applied from then on.
