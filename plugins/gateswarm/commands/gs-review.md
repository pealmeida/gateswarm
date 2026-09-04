---
description: Grade delivered results and record quality votes against the models that produced them.
---

Apply the `model-delegation` skill, sections 4 and 5.

For each unit delivered in this session that has not yet been graded:

1. Judge the **output** against what that unit asked for — not against what a
   larger model would have written.
2. Call `submit_outcome` with the unit's `eventId` and a verdict of
   `accurate` / `partial` / `inaccurate` / `failed`.
3. Use `judge: "human"` only if the user made the call; your own judgement is
   `judge: "model"`.

Grade the successes as well as the failures — a vote set containing only
complaints makes every model look bad and the recalibration meaningless.

Then call `telemetry_summary` and report per-model quality so far. If any model
has 8+ votes, say that it is ready for `/gs-recalibrate`.

$ARGUMENTS
