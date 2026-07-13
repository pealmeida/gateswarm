<!-- Thanks for the PR. Fill out the sections below. -->

## Summary

<!-- What changed and why. Link issues with "Closes #N". -->

## Subsystem

- [ ] Python scorer (`router.py`, `train.py`, `llmfit/`)
- [ ] TypeScript gateway (`src/`)
- [ ] Docs / examples
- [ ] CI / tooling

## Verification

- [ ] `python -m pytest tests/test_router.py` passes
- [ ] `npm run typecheck && npx vitest run` passes (if touching TypeScript)
- [ ] Manually exercised the affected CLI / endpoint
- [ ] `CHANGELOG.md` updated

## Notes for reviewers

<!-- Tradeoffs, follow-ups, things to scrutinize. -->
