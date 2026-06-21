---
name: user-timezone-berlin
description: "User is in the Berlin timezone (CET/CEST, UTC+2 in summer) — convert UTC CI timestamps to their local time"
metadata: 
  node_type: memory
  type: user
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

The user is in the **Berlin timezone** (Europe/Berlin: CEST = UTC+2 in summer, CET = UTC+1 in winter). Confirmed 2026-06-20 when they said "it's 4:40am now" against a 02:40 UTC reading.

CI / GitHub Actions timestamps surface in **UTC**. When reporting times or ETAs to the user, add the Berlin offset (e.g. "03:40 UTC = ~05:40 Berlin") so they don't have to convert. Also relevant for judging when they're likely asleep/away vs. live — a late-night UTC session may be the small hours for them.
