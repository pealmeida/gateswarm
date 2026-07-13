# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.6.x   | Yes       |
| 0.5.x   | Yes       |
| < 0.5   | No        |

## Reporting a Vulnerability

**DO NOT open a public GitHub issue for security vulnerabilities.**

Please use [GitHub private vulnerability reporting](https://github.com/pealmeida/gateswarm-router/security/advisories/new). Include a description, reproduction steps, affected versions, and any relevant logs or proof of concept. Do not open a public issue for vulnerabilities.

## Provider Key Security

API keys for LLM providers (OpenAI, OpenRouter, Bailian, Z.AI, etc.) must never be committed to the repository.

- Copy `.env.example` to `.env` and fill in your keys — `.env` is gitignored.
- The gateway reads all keys from environment variables at startup.
- Keys are **never logged**, printed to stdout, or included in error messages.
- In production, inject secrets via your platform's secret management (e.g., GitHub Actions secrets, Docker secrets, or a vault).

If you believe a key has been accidentally exposed in a commit, rotate it immediately at the provider's dashboard and open a private report per the process above.
