---
name: model-delegation
description: Distribute a task across multiple models and providers by complexity, then grade what each one returned and feed those grades back into routing. Use when a task splits into parts of uneven difficulty, when the user asks to route/delegate work across models or providers, to cut model spend on a multi-part job, or when asked to review whether a model's output justified the model it was sent to.
---

# Delegating work across models and providers

You are the teacher. GateSwarm scores complexity and names the cheapest capable
model; you decide what to send, judge what comes back, and your judgements are
what recalibrate the next decision.

The loop: **split → route → delegate → grade → recalibrate.** Grading is not
optional bookkeeping. A routing matrix that is never graded is a table of
guesses, and skipping the grade is what makes the next decision no better than
this one.

## 1. Split before routing

Route *units of work*, not whole conversations. A task like "add OAuth to the
API, write the tests, and update the README" has three parts of very different
difficulty, and routing it as one prompt sends the README to a reasoning model.

Split on **deliverable boundaries** — one artifact per unit. Do not split below
that: a unit that cannot be judged on its own cannot be graded, and an ungraded
unit teaches nothing.

If the task is genuinely one indivisible unit, route it as one. Splitting a
single coherent task into fragments to look thorough produces worse work and
noisier grades.

## 2. Route each unit

Call `route_prompt` (or `route_session` when prior turns change the difficulty)
for each unit. Pass `project` so votes accumulate in one place, and `matrixPath`
when the user has a matrix of models they can actually reach.

Read the response as advice with a stated basis, not as an instruction:

- `tier` and `score` — the complexity estimate.
- `model` / `provider` — the cheapest capable option at that tier.
- `alternatives` — what else could serve it.
- `eventId` — **keep this.** It is how the grade you record later joins the
  decision it is grading.

Override the recommendation when you have information the scorer cannot see —
the repository's conventions, a constraint from earlier in the conversation, a
provider the user has said is down. Say so when you do: "routing said `light` /
`gemini-flash-lite`, but this touches the auth path, so I sent it to
`claude-sonnet`." An unexplained override is indistinguishable from ignoring the
router, and it also silently poisons the grade you record against that model.

## 3. Delegate

Execute each unit against the chosen model through whatever the user's setup
provides — the GateSwarm gateway, a provider SDK, a subagent, a CLI. GateSwarm
itself executes nothing; it only advises.

Prefer spreading units across providers when the tiers genuinely differ. It is
not diversity for its own sake: it is how you get graded evidence about more
than one provider, and a matrix with evidence on one model is a matrix that can
only ever confirm that model.

Never send a unit to a model rated below its tier without saying why. If no
capable model is reachable, say that rather than quietly downgrading.

## 4. Grade what comes back — every unit, before you report

After a unit completes, judge **the output**, then call `submit_outcome` with
its `eventId`.

Grade the answer, not the difficulty:

| verdict | meaning |
|---|---|
| `accurate` | correct, complete, usable as delivered |
| `partial` | broadly right but needed correction, filled a gap, or missed a stated requirement |
| `inaccurate` | wrong, or unusable without redoing it |
| `failed` | transport/provider error — no answer to judge. Excluded from quality, counted separately |

Judge against **what the unit asked for**, not against what a larger model would
have written. A `light` model that answers a `light` unit correctly is
`accurate`; it is not `partial` for being terse. Grading every cheap model down
for not sounding expensive drives the matrix toward always routing high, which
is precisely the failure this system exists to prevent.

Set `judge: "human"` **only** when a person actually made the call. Your own
judgement is `judge: "model"` — it is weighted lower on purpose, and mislabelling
it corrupts the one signal that outranks yours.

Two mistakes to avoid:

- **Do not use `submit_feedback` to report a bad answer.** That tool judges
  whether the *tier* was right and moves the complexity boundaries.
  `submit_outcome` judges whether the *output* was good. A bad answer from a
  correctly-tiered model is a quality problem, not a boundary problem, and
  filing it as one shifts routing for every future prompt.
- **Do not grade only the failures.** A grade set containing only complaints
  makes every model look bad and the recalibration meaningless. Grade the
  successes too, in the same pass.

## 5. Recalibrate

Once votes have accumulated — roughly 8+ per model, which is where a model's own
evidence starts to outweigh its prior — call `recalibrate_matrix`. It returns a
new matrix in which each model's `quality` is what it actually delivered here,
and a model that repeatedly underperformed at its ceiling tier has been demoted
out of it.

Pass that matrix to subsequent routing calls. That is the whole point of the
grades: the next decision is made from measured delivery rather than from the
priors someone typed into a table.

Two properties worth knowing when you report results:

- Quality is **relative within one matrix on one workload**. The numbers are
  renormalised onto the original matrix's span, so they compare models against
  each other here — they are not portable scores.
- Thin evidence barely moves anything. Three votes will not overturn a prior,
  by design. If a model looks mis-rated and the matrix will not move, the answer
  is more graded outcomes, not a lower `pseudoCounts`.

## 6. Report

Tell the user what you routed where, what it cost, and how it graded. A run that
saved money by routing three units cheaply is only worth reporting alongside the
grades those units earned — cost without quality is half the story, and the half
that flatters the router.

Report an override, a `failed` unit, or a demotion explicitly. Those are the
events that change what happens next.
