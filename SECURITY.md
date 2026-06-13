# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.5.x   | Yes       |
| < 0.5   | No        |

## Reporting a Vulnerability

**DO NOT open a public GitHub issue for security vulnerabilities.**

Please report security issues using one of the following methods:

- **Email:** pealmeida96@gmail.com — include a description of the issue, steps to reproduce, and any relevant logs or proof-of-concept code.
- **GitHub Private Vulnerability Reporting:** Use the "Report a vulnerability" button on the Security tab at [github.com/pealmeida/gateswarm-router](https://github.com/pealmeida/gateswarm-router).

You can expect an acknowledgement within 48 hours and a resolution timeline within 7 days for confirmed vulnerabilities.

## Provider Key Security

API keys for LLM providers (OpenAI, OpenRouter, Bailian, Z.AI, etc.) must never be committed to the repository.

- Copy `.env.example` to `.env` and fill in your keys — `.env` is gitignored.
- The gateway reads all keys from environment variables at startup.
- Keys are **never logged**, printed to stdout, or included in error messages.
- In production, inject secrets via your platform's secret management (e.g., GitHub Actions secrets, Docker secrets, or a vault).

If you believe a key has been accidentally exposed in a commit, rotate it immediately at the provider's dashboard and open a private report per the process above.
