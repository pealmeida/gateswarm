"""Command guard (allowlist + denylist) for the GateSwarm "ops" engine.

No secrets or account hosts live here: SSH aliases etc. come from config.
Policy: default deny. A command line is split into simple commands (&&, ||, ;, |);
every simple command must match an allowlisted rule; ssh remote commands are
validated recursively with the same rules.
"""
from __future__ import annotations

import re
import shlex
from dataclasses import dataclass, field

DEFAULT_DENY = [
    r"\brm\b", r"\brmdir\b", r"\bdrop\b", r"\btruncate\b", r"\bdelete\b", r"reset\s+--hard",
    r"\bmkfs", r"\bdd\b", r"\bshutdown\b", r"\breboot\b", r"\bchmod\b", r"\bchown\b",
    r"\bkill(all)?\b", r"\bpkill\b", r"\bsudo\b", r"\bsu\b", r"git\s+(push|clean|checkout|restore)",
    r"docker\s+(compose\s+)?(rm|stop|restart|kill|down|prune|rmi|up|run|start|pull|build|cp|network|volume|system)\b",
    r"\bsystemctl\b", r"\bmv\b", r"\bcp\b", r"\btee\b", r"\bsed\s+-i", r"\bwget\b", r"\bnc\b",
    r"\bprintenv\b", r"\benv\b", r"\bexport\b", r"\beval\b", r"\bbash\b", r"\bsh\s", r"\bpython", r"\bnode\b",
]
SECRET_PATH = re.compile(r"(^|/)(\.env[^/]*|id_[a-z0-9]+|[^/]*\.pem|[^/]*\.key|\.ssh|shadow|\.netrc|\.git-credentials|ghcr[^/]*token[^/]*)(/|$)", re.I)
SAFE_REDIRECT = re.compile(r"^(2>&1|[0-9]?>\s*/dev/null|2>/dev/null)$")
SIMPLE_READ = {"cat", "ls", "grep", "head", "tail", "wc", "sort", "uniq", "jq", "stat", "pwd", "date",
               "uptime", "df", "free", "echo", "true", "cut", "tr", "basename", "dirname", "id", "whoami", "hostname", "test"}
PSQL_FORBIDDEN = re.compile(r"\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|call|do|vacuum|reindex|set|reset|begin|commit|lock|refresh|comment|import|execute|pg_terminate_backend|pg_cancel_backend|lo_\w+|pg_read_file|pg_ls_dir)\b", re.I)
GH_VIEW = {"view", "list", "status", "diff", "checks", "download_dummy"}


class Denied(Exception):
    pass


@dataclass
class Policy:
    ssh_aliases: set[str] = field(default_factory=set)
    docker_exec_containers: set[str] = field(default_factory=set)  # empty = any container
    curl_allowed_hosts: set[str] = field(default_factory=set)      # empty = any host
    extra_deny: list[str] = field(default_factory=list)

    @classmethod
    def from_config(cls, cfg: dict) -> "Policy":
        return cls(set(cfg.get("ssh_aliases", [])), set(cfg.get("docker_exec_containers", [])),
                   set(cfg.get("curl_allowed_hosts", [])), list(cfg.get("extra_deny_patterns", [])))


def split_commands(line: str) -> list[str]:
    """Split on && || ; | newline outside quotes; reject expansions, heredocs, bad redirects."""
    if "\x00" in line:
        raise Denied("nul byte")
    parts, buf, q, i = [], [], None, 0
    while i < len(line):
        c = line[i]
        if q == "'":
            buf.append(c)
            if c == "'":
                q = None
        elif q == '"':
            if c in "`" or (c == "$"):
                raise Denied("expansion inside double quotes")
            if c == "\\" and i + 1 < len(line):
                buf.append(c); i += 1; c = line[i]
            buf.append(c)
            if c == '"':
                q = None
        else:
            if c in "'\"":
                q = c; buf.append(c)
            elif c in "`$":
                raise Denied("command/variable expansion not allowed")
            elif c == "\\":
                raise Denied("backslash escapes not allowed outside quotes")
            elif c in "(){}":
                raise Denied("subshell/grouping not allowed")
            elif c == "<":
                raise Denied("input redirect/heredoc not allowed")
            elif c in ";\n" or c == "|" or (c == "&" and line[i:i + 2] == "&&"):
                if c == "|" and line[i:i + 2] == "||":
                    i += 1
                elif c == "&":
                    i += 1
                parts.append("".join(buf)); buf = []
            elif c == "&" and not (buf and buf[-1] in "2>"):
                raise Denied("background/& not allowed")
            else:
                buf.append(c)
        i += 1
    if q:
        raise Denied("unbalanced quote")
    parts.append("".join(buf))
    return [p.strip() for p in parts if p.strip()]


def _tokens(cmd: str) -> list[str]:
    try:
        toks = shlex.split(cmd)
    except ValueError as e:
        raise Denied(f"unparseable: {e}")
    out = []
    for t in toks:
        if SAFE_REDIRECT.match(t) or t in (">", "2>"):
            if t in (">", "2>"):
                raise Denied("redirect to file not allowed")
            continue
        if t.startswith(">") or t.startswith("2>") or t.startswith("&>"):
            if not SAFE_REDIRECT.match(t) and t.replace(" ", "") not in (">/dev/null", "2>/dev/null"):
                raise Denied("redirect to file not allowed")
            continue
        out.append(t)
    return out


def _check_paths(args: list[str]):
    for a in args:
        if SECRET_PATH.search(a):
            raise Denied(f"secret-like path: {a}")


def _check_psql(args: list[str]):
    sql = None
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-c", "--command"):
            sql = args[i + 1] if i + 1 < len(args) else None; i += 1
        elif a.startswith("--command="):
            sql = a.split("=", 1)[1]
        elif a in ("-f", "--file", "-W", "--password") or a.startswith("--file"):
            raise Denied("psql -f/password not allowed")
        i += 1
    if sql is None:
        raise Denied("psql requires -c")
    s = sql.strip().rstrip(";").strip()
    if ";" in s:
        raise Denied("multiple SQL statements")
    if s.startswith("\\"):
        if not re.match(r"^\\(d|dt|dn|l|du|di|dv|ds|conninfo)[+S]*(\s+[\w.\"]+)?$", s):
            raise Denied("psql meta-command not allowed")
        return
    if not re.match(r"^(select|with|show|explain)\b", s, re.I) or PSQL_FORBIDDEN.search(s):
        raise Denied("psql: read-only SELECT/SHOW/EXPLAIN only")
    if re.search(r"explain\s*\(?\s*analyze", s, re.I):
        raise Denied("explain analyze can execute writes")


def _check_curl(args: list[str], pol: Policy):
    urls = []
    skip = False
    for i, a in enumerate(args):
        if skip:
            skip = False; continue
        if a in ("-X", "--request"):
            if i + 1 >= len(args) or args[i + 1].upper() not in ("GET", "HEAD"):
                raise Denied("curl: only GET/HEAD")
            skip = True
        elif re.match(r"^(-[a-zA-Z]*[dFTKoOu]|--(data|data-\w+|form|upload-file|config|output|remote-name|user|json|netrc|cookie-jar|variable|next).*)$", a):
            raise Denied(f"curl option not allowed: {a}")
        elif a in ("-H", "--header", "-m", "--max-time", "--connect-timeout", "-w", "--write-out"):
            skip = True
        elif not a.startswith("-"):
            urls.append(a)
    if not urls:
        raise Denied("curl: no url")
    for u in urls:
        m = re.match(r"^https?://([^/:@]+)(:\d+)?(/|$)", u)
        if not m:
            raise Denied("curl: http(s) URL required")
        if pol.curl_allowed_hosts and m.group(1) not in pol.curl_allowed_hosts:
            raise Denied(f"curl host not allowed: {m.group(1)}")


def _check_gh(args: list[str]):
    if not args:
        raise Denied("gh: subcommand required")
    if args[0] == "api":
        rest = args[1:]
        for j, a in enumerate(rest):
            if a in ("-X", "--method"):
                if j + 1 >= len(rest) or rest[j + 1].upper() != "GET":
                    raise Denied("gh api: GET only")
            if a in ("-f", "-F", "--field", "--raw-field", "--input") or a.startswith("--input"):
                raise Denied("gh api: no body fields")
        return
    if args[0] in ("run", "pr", "issue", "repo", "workflow", "release", "auth") and len(args) > 1:
        if args[0] == "auth":
            if args[1] != "status":
                raise Denied("gh auth: status only")
            return
        if args[1] in ("view", "list", "diff", "checks", "status"):
            return
    if args[0] in ("status",):
        return
    raise Denied("gh: read-only subcommands only")


def _check_docker(args: list[str], pol: Policy):
    if not args:
        raise Denied("docker: subcommand required")
    if args[0] == "compose":
        if len(args) > 1 and args[1] in ("ps", "logs", "config", "ls"):
            return
        raise Denied("docker compose: ps/logs/config only")
    sub = args[0]
    if sub in ("ps", "logs", "inspect", "images", "top", "port", "version", "info"):
        return
    if sub == "stats":
        if "--no-stream" not in args:
            raise Denied("docker stats needs --no-stream")
        return
    if sub == "exec":
        rest = [a for a in args[1:]]
        i = 0
        while i < len(rest) and rest[i].startswith("-"):
            if rest[i] in ("-it", "-ti", "-i", "-t", "-d", "--detach", "-u", "--user", "-e", "--env", "-w", "--privileged"):
                if rest[i] in ("-d", "--detach", "-u", "--user", "-e", "--env", "--privileged", "-i", "-t", "-it", "-ti"):
                    raise Denied(f"docker exec flag not allowed: {rest[i]}")
                i += 1
            elif rest[i] in ("-w",):
                i += 2
            else:
                raise Denied(f"docker exec flag not allowed: {rest[i]}")
        if i >= len(rest):
            raise Denied("docker exec: container required")
        ctr = rest[i]
        if pol.docker_exec_containers and ctr not in pol.docker_exec_containers:
            raise Denied(f"container not allowed for exec: {ctr}")
        inner = rest[i + 1:]
        if not inner:
            raise Denied("docker exec: command required")
        _check_inner(inner)
        return
    raise Denied(f"docker {sub} not allowed")


def _check_inner(toks: list[str]):
    prog = toks[0].rsplit("/", 1)[-1]
    if prog == "psql":
        _check_psql(toks[1:])
    elif prog in SIMPLE_READ - {"echo"}:
        _check_paths(toks[1:])
    elif prog in ("wget", "curl"):
        raise Denied("curl/wget inside container not allowed")
    else:
        raise Denied(f"command not allowed inside container: {prog}")


def _check_ssh(args: list[str], pol: Policy):
    i = 0
    while i < len(args) and args[i].startswith("-"):
        if args[i] == "-o" and i + 1 < len(args) and re.match(r"^(BatchMode=yes|ConnectTimeout=\d+|StrictHostKeyChecking=(yes|accept-new))$", args[i + 1]):
            i += 2
        else:
            raise Denied(f"ssh option not allowed: {args[i]}")
    if i >= len(args):
        raise Denied("ssh: alias required")
    alias = args[i]
    if alias not in pol.ssh_aliases:
        raise Denied(f"ssh alias not allowed: {alias}")
    remote = args[i + 1:]
    if not remote:
        raise Denied("ssh: interactive shell not allowed")
    validate(" ".join(remote), pol, _remote=True)


def validate(line: str, pol: Policy, _remote: bool = False) -> None:
    """Raise Denied unless every simple command in `line` is allowed."""
    if not line or not line.strip():
        raise Denied("empty command")
    if line.strip() == "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT":
        return
    for pat in DEFAULT_DENY + pol.extra_deny:
        if re.search(pat, line, re.I):
            raise Denied(f"denylist match: {pat}")
    for part in split_commands(line):
        toks = _tokens(part)
        if not toks:
            raise Denied("empty simple command")
        prog, args = toks[0], toks[1:]
        if "=" in prog and not prog.startswith("/"):
            raise Denied("env assignment prefix not allowed")
        if prog in SIMPLE_READ:
            _check_paths(args)
            if prog == "echo" and any("COMPLETE_TASK" in a for a in args):
                raise Denied("submit command must stand alone")
        elif prog == "find":
            if any(a in ("-exec", "-execdir", "-delete", "-ok", "-fprint", "-fls") for a in args):
                raise Denied("find with action not allowed")
            _check_paths(args)
        elif prog == "ssh":
            _check_ssh(args, pol)
        elif prog == "docker":
            _check_docker(args, pol)
        elif prog == "gh":
            _check_gh(args)
        elif prog == "curl":
            _check_curl(args, pol)
        elif prog == "psql":
            _check_psql(args)
        else:
            raise Denied(f"command not in allowlist: {prog}")
