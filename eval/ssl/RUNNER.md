# T11 runner commands

Run from the repository root, in this exact order:

1. `npm run ssl:build-corpus`
2. `npm run ssl:extract-features`
3. `npm run ssl:label-propagation`
4. `npm run eval:train-ordinal`
5. `npm run eval:train-ordinal -- --silver eval/ssl/out/silver-labels.jsonl`

Decision numbers:

- Propagation beats the heuristic baseline when `eval/ssl/out/report.md` shows the selected or best graph config has higher golden TEST exact accuracy than the fixed-boundary heuristic baseline, with mean absolute tier distance no worse. Adjacent accuracy is the tie-breaker.
- Golden+silver ordinal passes the downstream gate when command 5 prints `gate result: PASS`.
- The +3pp/ECE check is decided by command 5's holdout gate lines: exact must be at least heuristic +3pp, adjacent must be at least 90%, heavy recall must be at least 30%, and ECE must be at most 0.10.
- The value of silver is measured by comparing command 5's `ordinal-logistic gold+silver` line to command 4's `ordinal-logistic current`/`gold-only` line, especially exact delta and ECE delta.
