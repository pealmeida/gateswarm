#!/usr/bin/env python3
"""GateSwarm "ops" engine: mini-swe-agent with a guarded, read-only-ish shell.

Usage:
  set -a; . /path/to/gateswarm/.env; set +a      # ZAI_BASE, ZAI_KEY (never printed)
  ops_agent.py "task text" [--config ops.local.json] [--model glm-5.3]
              [--step-limit 20] [--timeout 60] [--wall 150] [--log-dir logs]
Config (JSON, git-ignored: ops.local.json) or env OPS_SSH_ALIASES=a,b.
Exit codes: 0 submitted/finished cleanly, 2 limits/other agent exit, 1 error.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from guard import Denied, Policy, validate  # noqa: E402

SECRET_PATTERNS = [
    re.compile(r"(?i)(authorization:\s*bearer\s+)[A-Za-z0-9._\-]+"),
    re.compile(r"(?i)\b(api[_-]?key|secret|token|password|passwd|pwd)(\"?\s*[:=]\s*\"?)([^\s\"',}]{6,})"),
    re.compile(r"\b(sk|ghp|gho|ghs|github_pat|xox[a-z]|AKIA)[-_A-Za-z0-9]{12,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
    re.compile(r"\b[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b"),
    re.compile(r"(?i)(postgres(ql)?|mysql|redis|amqp)://[^\s:@/]+:[^\s@/]+@"),
]


def redact(text: str, known: list[str] | None = None) -> str:
    for k in known or []:
        if k and len(k) >= 6:
            text = text.replace(k, "[REDACTED]")
    text = SECRET_PATTERNS[0].sub(r"\1[REDACTED]", text)
    text = SECRET_PATTERNS[1].sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", text)
    text = SECRET_PATTERNS[2].sub("[REDACTED]", text)
    text = SECRET_PATTERNS[3].sub("[REDACTED PRIVATE KEY]", text)
    text = SECRET_PATTERNS[5].sub(lambda m: m.group(1) + "://[REDACTED]@", text)
    return text


def load_config(path: str | None) -> dict:
    cfg: dict = {}
    p = Path(path) if path else HERE / "ops.local.json"
    if p.exists():
        cfg = json.loads(p.read_text())
    if os.environ.get("OPS_SSH_ALIASES"):
        cfg["ssh_aliases"] = [a for a in os.environ["OPS_SSH_ALIASES"].split(",") if a]
    return cfg


def build(cfg: dict, args, log_path: Path):
    from minisweagent.agents.default import DefaultAgent
    from minisweagent.environments.local import LocalEnvironment
    from minisweagent.models.litellm_textbased_model import LitellmTextbasedModel
    import yaml
    import minisweagent

    base_cfg = yaml.safe_load((Path(minisweagent.__file__).parent / "config" / "mini_textbased.yaml").read_text())
    pol = Policy.from_config(cfg)
    key = os.environ.get("ZAI_KEY", "")
    base = os.environ.get("ZAI_BASE", "")
    if not key or not base:
        raise SystemExit("ZAI_BASE/ZAI_KEY not set in environment")
    known_secrets = [key]

    class GuardedEnv(LocalEnvironment):
        def execute(self, action, cwd="", *, timeout=None):
            cmd = action.get("command", "")
            try:
                validate(cmd, pol)
            except Denied as e:
                return {"output": f"BLOCKED by ops policy: {e}. Use an allowed read-only command.",
                        "returncode": 126, "exception_info": ""}
            out = super().execute(action, cwd, timeout=timeout)
            out["output"] = redact(out.get("output", ""), known_secrets)
            return out

    class OpsAgent(DefaultAgent):
        def serialize(self, *extra):
            data = super().serialize(*extra)
            return json.loads(redact(json.dumps(data), known_secrets))

    env_cfg = dict(base_cfg.get("environment", {}))
    env_cfg["timeout"] = args.timeout
    env_cfg["env"] = {**env_cfg.get("env", {}), "GIT_TERMINAL_PROMPT": "0"}
    # keep the model key out of the child-process environment
    model_cfg = dict(base_cfg.get("model", {}))
    model_cfg["model_name"] = f"openai/{args.model}"
    mk = dict(model_cfg.get("model_kwargs", {}))
    mk.update({"api_base": base, "api_key": key, "temperature": 0.0})
    model_cfg["model_kwargs"] = mk
    model_cfg["cost_tracking"] = "ignore_errors"
    os.environ.setdefault("MSWEA_COST_TRACKING", "ignore_errors")
    os.environ.setdefault("MSWEA_SILENT_STARTUP", "1")
    model = LitellmTextbasedModel(**model_cfg)
    # drop secrets from env seen by spawned commands
    for k in ("ZAI_KEY", "ZAI_BASE", "OPENAI_API_KEY"):
        os.environ.pop(k, None)
    agent_cfg = dict(base_cfg.get("agent", {}))
    agent_cfg.pop("mode", None)
    agent_cfg.pop("confirm_exit", None)
    agent_cfg.update(step_limit=args.step_limit, cost_limit=0.0, wall_time_limit_seconds=args.wall,
                     output_path=log_path)
    # read-only guardrail text appended to task by caller
    return OpsAgent(model, GuardedEnv(**env_cfg), **agent_cfg)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("task")
    ap.add_argument("--config")
    ap.add_argument("--model", default="glm-5.3")
    ap.add_argument("--step-limit", type=int)
    ap.add_argument("--timeout", type=int)
    ap.add_argument("--wall", type=int)
    ap.add_argument("--log-dir")
    args = ap.parse_args(argv)
    cfg = load_config(args.config)
    args.step_limit = args.step_limit or cfg.get("step_limit", 20)
    args.timeout = args.timeout or cfg.get("command_timeout", 60)
    args.wall = args.wall or cfg.get("wall_time_limit", 150)
    log_dir = Path(args.log_dir or cfg.get("log_dir") or HERE / "logs")
    log_path = log_dir / f"ops-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}.json"
    try:
        agent = build(cfg, args, log_path)
        task = args.task + ("\n\nRULES: read-only verification only. Allowed ssh aliases: " + (", ".join(sorted(cfg.get("ssh_aliases", []))) or "none") + ". Commands are filtered by an allowlist "
                            "(ssh to configured alias, docker ps/logs/inspect/exec, gh read, curl GET, cat/ls/grep, "
                            "psql SELECT). No variables/subshells/redirects to files. Never print secrets. "
                            "When done, run exactly: echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT "
                            "(alone) and put your summary in the lines of your THOUGHT before it.")
        result = agent.run(task)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"ops_agent error: {type(e).__name__}: {redact(str(e))[:300]}", file=sys.stderr)
        return 1
    print(f"exit_status={result.get('exit_status')} steps={agent.n_calls} log={log_path}")
    last = next((m for m in reversed(agent.messages) if m.get("role") == "assistant"), None)
    if last:
        print(redact(str(last.get("content", ""))[:3000]))
    return 0 if result.get("exit_status") == "Submitted" else 2


if __name__ == "__main__":
    sys.exit(main())
