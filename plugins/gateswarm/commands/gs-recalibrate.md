---
description: Rebuild the routing matrix from recorded quality votes and show what changed.
---

1. Call `telemetry_summary` first. If no model has at least ~8 graded outcomes,
   say so and stop — recalibrating on thin evidence produces movement that looks
   like learning and is not.
2. Call `recalibrate_matrix`.
3. Report, per model: prior quality → calibrated quality, sample count, and any
   `maxEffort` demotion, with the reason given for it.
4. Show which tiers now route to a different model than before, and the cost
   delta that implies.
5. Save the returned matrix to a file the user names, and remind them to pass it
   as `matrixPath` on later routing calls — otherwise the recalibration has no
   effect on anything.

State plainly that these qualities are relative to this matrix on this workload
and are not portable scores.

$ARGUMENTS
