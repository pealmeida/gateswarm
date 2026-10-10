import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import pytest
from guard import Denied, Policy, validate

P = Policy(ssh_aliases={"box1"})

OK = [
    "ls -la /tmp", "cat README.md | head -20", "grep -rn foo src | wc -l", "uptime",
    "docker ps", "docker ps --format '{{.Names}}'" if False else "docker ps -a", "docker logs --tail 50 web 2>&1",
    "docker inspect web", "docker exec web ls /app", "docker exec web cat /etc/hostname",
    "docker exec db psql -U app -d app -c 'select count(*) from t'", "docker compose ps",
    "docker stats --no-stream",
    "gh run list --limit 5", "gh pr view 12", "gh api repos/o/r/pulls", "gh auth status",
    "curl -s https://example.com/health", "curl -sS -m 10 -I http://localhost:8080/",
    "psql -h localhost -c 'SELECT 1'", "psql -c '\\dt'",
    "ssh box1 uptime", "ssh -o BatchMode=yes -o ConnectTimeout=8 box1 'docker ps'",
    "ssh box1 'docker logs --tail 20 web 2>&1 | grep -i error'",
    "ssh box1 \"docker exec db psql -U u -c 'select 1'\"",
    "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT", "ls /nonexistent 2>/dev/null || echo none",
    "find /var/log -name '*.log' -maxdepth 1",
]
BAD = [
    "rm -rf /tmp/x", "rm file", "git reset --hard HEAD", "git push origin main",
    "psql -c 'drop table t'", "psql -c 'select 1; delete from t'", "psql -c 'update t set a=1'",
    "psql -c 'explain analyze select 1'", "psql -f dump.sql", "psql",
    "docker rm web", "docker stop web", "docker restart web", "docker compose up -d", "docker compose down",
    "docker run alpine sh", "docker exec -it web sh", "docker exec web sh -c 'ls'", "docker exec -u root web ls",
    "docker exec web rm /x", "docker stats",
    "gh api -X POST repos/o/r/issues", "gh api repos/o/r/issues -f title=x", "gh pr merge 1", "gh pr create",
    "gh issue close 3", "gh repo delete x",
    "curl -X POST https://e.com", "curl -d a=b https://e.com", "curl -o /tmp/x https://e.com", "curl --upload-file f https://e.com",
    "curl ftp://e.com", "curl file:///etc/passwd",
    "ssh other uptime", "ssh box1", "ssh -L 80:x:80 box1 ls", "ssh box1 'rm -rf /'", "ssh box1 'docker restart web'",
    "ssh box1 'sudo ls'", "ssh -o ProxyCommand=x box1 ls",
    "sudo ls", "ls; rm x", "ls && rm x", "ls | sh", "cat $(which ls)", "cat `x`", "echo $ZAI_KEY", "echo ${HOME}",
    "ls > out.txt", "ls >out.txt", "cat < /etc/passwd", "cat <<EOF\nx\nEOF", "ls &", "bash -c ls", "python3 -c 1",
    "cat .env", "cat /home/u/.ssh/id_ed25519", "cat key.pem", "env", "printenv", "FOO=1 ls", "find . -delete",
    "find . -exec ls {} +", "mv a b", "cp a b", "sed -i s/a/b/ f", "tee f", "chmod 777 f", "kill 1", "systemctl stop x",
    "wget http://x", "xargs rm", "", "   ", "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && ls",
    "ls \"$(id)\"", "(ls)", "docker exec web curl http://x", "docker exec web env",
]

@pytest.mark.parametrize("cmd", OK)
def test_allowed(cmd):
    validate(cmd, P)

@pytest.mark.parametrize("cmd", BAD)
def test_blocked(cmd):
    with pytest.raises(Denied):
        validate(cmd, P)

def test_container_and_host_restrictions():
    p = Policy(ssh_aliases={"b"}, docker_exec_containers={"db"}, curl_allowed_hosts={"localhost"})
    validate("docker exec db ls /", p)
    with pytest.raises(Denied):
        validate("docker exec web ls /", p)
    validate("curl -s http://localhost:80/x", p)
    with pytest.raises(Denied):
        validate("curl -s http://evil.com/x", p)

def test_extra_deny():
    with pytest.raises(Denied):
        validate("ls secretdir", Policy(extra_deny=[r"secretdir"]))

def test_redaction():
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
    from ops_agent import redact
    t = "Authorization: Bearer abcdef123456 password=hunter22222 key=MYKNOWNSECRETVALUE postgres://u:pw123@h/db ghp_abcdefghijklmnop1234"
    r = redact(t, ["MYKNOWNSECRETVALUE"])
    for s in ("abcdef123456", "hunter22222", "MYKNOWNSECRETVALUE", "pw123", "ghp_abcdefghijklmnop1234"):
        assert s not in r
