# Contributing to GateSwarm MoMA Router

Thank you for your interest! This project makes AI model routing more efficient through data-driven complexity classification.

## How to Contribute

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Test locally:
   ```bash
   # Quick sanity check
   python router.py "test prompt" --json

   # Python test suite
   python -m pytest gateway/tests/test_router.py

   # TypeScript gateway tests
   cd gateway && npm run test
   ```
4. Run training validation (if modifying training): `python train.py`
5. Submit a pull request

## Development Setup

```bash
# Python scorer — runtime only
pip install numpy

# Python scorer — full dev (training + testing)
pip install scipy numpy scikit-learn datasets pytest
python -m pytest gateway/tests/test_router.py

# TypeScript gateway
cd gateway
cp .env.example .env   # add your API keys
npm install
npm run typecheck
npm run test
```

## Project Structure

| Path | Purpose | Edit with care |
|------|---------|---------------|
| `router.py` | Python scorer — must remain standalone | ⚠️ Zero cloud deps |
| `train.py` | Training pipeline (cascade + optimization) | ✅ |
| `v32_cascade_weights.json` | Pre-trained weights (5 classifiers) | ⚠️ Regenerate via `train.py` |
| `llmfit/` | Dataset factory toolkit | ✅ |
| `gateway/src/` | TypeScript gateway (port 8900) | ✅ |
| `gateway/tests/` | Vitest + pytest suites | ✅ |
| `docs/` | Architecture & strategy docs | ✅ |

## Code Style

- Python 3.11+ with type hints
- Keep `router.py` standalone (zero cloud dependencies)
- Training tools go in `train.py` or `llmfit/`
- TypeScript: strict mode (`tsc --noEmit` must pass)
- New features should include tests under `gateway/tests/`

## Reporting Issues

- Bug reports: [GitHub Issues](https://github.com/pealmeida/gateswarm-moma-router/issues)
- Feature requests: GitHub Issues with `enhancement` label
- Security vulnerabilities: See [SECURITY.md](SECURITY.md) — **do not** open public issues

## Pull Request Checklist

- [ ] `python -m pytest gateway/tests/test_router.py` passes
- [ ] `cd gateway && npm run typecheck && npm run test` passes (if touching gateway)
- [ ] No new external dependencies in `router.py`
- [ ] Docstrings updated for new public APIs
- [ ] CHANGELOG.md updated with changes

## License

By contributing, you agree your code is licensed under MIT.
