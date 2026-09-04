---
description: Score a task, split it into units, and route each to the cheapest capable model.
---

Take the task below, apply the `model-delegation` skill, and stop after routing.

1. Split it into units on deliverable boundaries (one artifact per unit).
2. Call `route_prompt` for each unit, keeping every `eventId`.
3. Show a table: unit, tier, model, provider, blended cost, reason.
4. Note any recommendation you would override, and why.

Do not execute the units yet — this command plans the distribution so the user
can approve it. Report the total blended cost against what routing everything at
the highest tier would have cost.

Task: $ARGUMENTS
