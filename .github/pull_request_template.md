<!-- Thanks for the PR. Fill out the sections below. -->

## Summary

<!-- What changed and why. Link issues with "Closes #N". -->

## Subsystem

- [ ] Python scorer (`router.py`, `train.py`, `llmfit/`)
- [ ] TypeScript gateway (`gateway/`)
- [ ] Docs / examples
- [ ] CI / tooling

## Verification

- [ ] `python -m pytest gateway/tests/test_router.py` passes
- [ ] `cd gateway && npm run typecheck && npm run test` passes (if touching gateway)
- [ ] Manually exercised the affected CLI / endpoint
- [ ] `CHANGELOG.md` updated

## Notes for reviewers

<!-- Tradeoffs, follow-ups, things to scrutinize. -->
