# ops-harness

Small "ops" engine built on [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent): an LLM
gets a bash-only loop for read-only operational checks (SSH to configured aliases, docker/gh
read-only, psql SELECT). Every command passes through `guard.py` before running.

## Usage
    pip install mini-swe-agent pytest          # in a virtualenv
    cp ops.example.json ops.local.json         # edit; ops.local.json is git-ignored
    export ZAI_BASE=<openai-compatible base url> ZAI_KEY=<api key>   # never printed; redacted in logs; OPS_SSH_ALIASES=a,b also works
    python ops_agent.py "<task description>"   # see the header of ops_agent.py for options

Logs (trajectories, redacted) go to `logs/` (git-ignored).

## Config (`ops.example.json`)
- `ssh_aliases`: only these `~/.ssh/config` aliases may be used with ssh
- `docker_exec_containers`, `curl_allowed_hosts`: explicit allowlists (empty = none)
- `step_limit`, `command_timeout`, `wall_time_limit`: hard caps
- `extra_deny_patterns`: extra regexes to block

## Limits — read this
The allowlist is **not a sandbox**. It is regex/token-based command analysis plus a denylist of
destructive and secret-reading patterns. It can block legitimate commands (e.g. `grep drop`) and
can't be assumed to stop a determined bypass. Run with least-privilege credentials, read-only
remote accounts, and treat output as untrusted. Redaction of secrets in logs is best-effort.

## Tests
    python -m pytest -q scripts/ops-harness/tests
