# Safety & Responsible Use Guidelines

GateSwarm MoA Router is a **prompt complexity classifier and model router** — it does not generate content itself. It analyzes prompts and routes them to the most cost-effective LLM. These guidelines cover safe and responsible use of the project.

## Scope

This project:
- ✅ Analyzes prompt complexity using a 15/25-feature heuristic vector
- ✅ Classifies prompts into 6 tiers (trivial → extreme)
- ✅ Routes to optimal LLM models based on complexity
- ✅ Logs routing decisions and feedback for self-optimization

This project does **NOT**:
- ❌ Generate or modify text content
- ❌ Store or transmit user prompts to third parties (beyond the LLM providers you configure)
- ❌ Collect personal data or telemetry
- ❌ Make content moderation or safety decisions

## Security Considerations

### API Keys
- API keys for LLM providers are **your responsibility**. Never commit them to version control.
- Use environment variables (`.env`) and ensure `.env` is in `.gitignore`.
- Rotate keys regularly. Treat them like passwords.

### Prompt Data
- Prompts are processed **locally** for feature extraction (no network calls).
- Prompts are forwarded to LLM providers **you configure**. Review your providers' privacy policies.
- If using the feedback/self-eval loop, routing metadata is logged locally (SQLite or JSON files).
- **No prompt content is shared** with the GateSwarm maintainers or any third party.

### Anonymization
- The `llmfit/anonymizer.py` tool provides 35-rule PII/secret redaction for training datasets.
- Use it before sharing datasets publicly or contributing labeled data:
  ```bash
  python -m llmfit.anonymizer --input raw.jsonl --output clean.jsonl
  ```

## Responsible Routing

### Cost Awareness
- GateSwarm optimizes for **cost efficiency**. The default tier→model mapping uses budget-friendly providers.
- Override model assignments for your use case if cost isn't your priority:
  ```python
  set_tier_models({"extreme": {"model": "your-model", "provider": "your-provider"}})
  ```

### Accuracy Limits
- v0.3.5 achieves **74.7% accuracy** across 6 tiers. Misclassifications happen.
- moderate (42%), heavy (39%), and intensive (19%) tiers have lower per-tier accuracy.
- For critical applications (medical, legal, financial decisions), consider routing higher or using a single high-quality model.

### No Safety Filtering
- GateSwarm does **not** filter harmful, illegal, or abusive prompts.
- If you need content moderation, add a safety layer **before** GateSwarm in your pipeline.
- This is a routing tool, not a guardrail.

## Feedback Loop Safety

The self-optimizing feedback loop (v0.4+) logs:
- Prompt complexity scores
- Routing decisions (which tier/model was chosen)
- LLM judge assessments (10% sampling)

All feedback data stays **local**. If you share feedback data for retraining:
1. Strip any personal/sensitive information
2. Review logs for accidental data leakage
3. Use the anonymizer before sharing

## Docker Security

- Run containers as non-root when possible: `docker run --user 1000 gateswarm-moa-router`
- Mount only necessary volumes; avoid mounting sensitive directories
- Keep base images updated: `docker pull` regularly

## Reporting Vulnerabilities

If you find a security issue:
1. Do **not** open a public GitHub issue
2. Contact the maintainer privately
3. Allow reasonable time for a fix before public disclosure

## License & Liability

GateSwarm is provided under the **MIT License** — "as is", without warranty. You are responsible for how you use it and for compliance with your LLM providers' terms of service.

---

_Last updated: 2026-05-14_
