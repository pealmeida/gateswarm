# GateSwarm plugin

Routes each unit of work to the cheapest capable model, grades what comes back,
and rebuilds the routing matrix from those grades.

```sh
claude plugin marketplace add pealmeida/gateswarm
claude plugin install gateswarm@gateswarm
```

## What it adds

| Component | Purpose |
|---|---|
| `model-delegation` skill | Teaches the split → route → delegate → grade → recalibrate loop. Loads on its own when a task splits across models. |
| `/gs-route` | Split a task and show the routing plan with costs, before executing. |
| `/gs-review` | Grade delivered results; record quality votes. |
| `/gs-recalibrate` | Rebuild the matrix from those votes and show what changed. |
| `gateswarm` MCP server | `route_prompt`, `route_session`, `submit_feedback`, `submit_outcome`, `recalibrate_matrix`, `cost_report`, `telemetry_summary`. |

## The two votes, which are not the same

- `submit_feedback` judges whether the **tier** was right. It feeds the golden
  dataset that recalibrates the complexity scorer and moves tier boundaries.
- `submit_outcome` judges whether the **output** was good. It feeds the matrix
  recalibration that changes which model serves a tier.

Filing a bad answer as a tier problem shifts routing for every future prompt.
Keep them separate.

## Configuration

- **Project slug** — groups telemetry and votes.
- **Telemetry directory** — defaults to `~/.gateswarm/telemetry`.
- **Model matrix** — a `ModelSpec[]` JSON of models you can actually reach.
  Without it the built-in demo matrix is used, which is a reviewed starting
  point and not a description of your account.

Advisory only: the plugin never executes a request or holds a provider key. Your
code, or the GateSwarm gateway, does the calling.
