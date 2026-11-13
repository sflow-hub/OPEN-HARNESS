"""Corroborating sandbox observations; host-side Docker inspect is authoritative."""
import errno
import json
import os
from pathlib import Path
import socket
import sys
import uuid


def result(ok, detail):
    return {"ok": ok, "detail": detail}


def write_checks(root):
    checks = {}
    for directory in ("/", "/etc", "/usr", "/tmp"):
        path = root / directory.lstrip("/") / (".sandbox-selftest-" + uuid.uuid4().hex)
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            path.unlink()
            checks[directory] = result(False, "write succeeded; temporary file removed")
        except OSError as error:
            checks[directory] = result(error.errno in (errno.EROFS, errno.EACCES, errno.EPERM), errno.errorcode.get(error.errno, str(error)))
    return result(all(c["ok"] for c in checks.values()), json.dumps(checks, sort_keys=True))


def privilege_check(root):
    try:
        fields = dict(line.split(":", 1) for line in (root / "proc/self/status").read_text().splitlines() if ":" in line)
        nnp, caps, seccomp = int(fields["NoNewPrivs"]), int(fields["CapEff"], 16), int(fields["Seccomp"])
        return result(nnp == 1 and caps == 0 and seccomp == 2, f"NoNewPrivs={nnp}; CapEff={caps}; Seccomp={seccomp}")
    except (OSError, KeyError, ValueError) as error:
        return result(None, "status unavailable: " + str(error))


def limits_check(root):
    values = {}
    try:
        # Resolve the process's actual cgroup, also handling cgroup namespaces (0::/).
        group = next(line[3:] for line in (root / "proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
        base = root / "sys/fs/cgroup" / group.lstrip("/")
        if ".." in Path(group).parts:
            return result(None, "cgroup path outside visible namespace")
        for name in ("pids.max", "memory.max", "cpu.max"):
            values[name] = (base / name).read_text().strip()
        quota, period = values["cpu.max"].split()
        limited = all(values[n] != "max" and int(values[n]) > 0 for n in ("pids.max", "memory.max")) and quota != "max" and int(quota) > 0 and int(period) > 0
        return result(limited, json.dumps(values, sort_keys=True))
    except (OSError, ValueError, StopIteration) as error:
        return result(None, "cgroup v2 limits unavailable: " + str(error))


def egress_check(targets):
    observations = []
    for target in targets[:20]:
        host, port, expect = target["host"], target["port"], target["expect"]
        if not isinstance(host, str) or not isinstance(port, int) or not 1 <= port <= 65535 or expect not in ("open", "refused"):
            raise ValueError("Invalid egress target")
        try:
            with socket.create_connection((host, port), timeout=3):
                opened = True
            detail = "connected; no data sent"
        except ConnectionRefusedError:
            opened, detail = False, "connection refused"
        except OSError as error:
            observations.append(result(None, f"{host}:{port}: inconclusive ({type(error).__name__})"))
            continue
        observations.append(result(opened == (expect == "open"), f"{host}:{port}: {detail}"))
    ok = False if any(o["ok"] is False for o in observations) else None if not observations or any(o["ok"] is None for o in observations) else True
    return result(ok, json.dumps(observations))


def probe(options=None, *, root_dir=None):
    # root_dir is a Python test seam only; the executable accepts no root override.
    root = Path(root_dir) if root_dir is not None else Path("/")
    checks = {
        "writes_outside_writable_mounts_denied": write_checks(root),
        "docker_socket_absent": result(not any((root / p).exists() for p in ("var/run/docker.sock", "run/docker.sock")), "checked /var/run/docker.sock and /run/docker.sock"),
        "host_home_absent": result(not (root / "host").exists(), "checked /host; mount-source attestation required for host homes"),
        "no_privilege_escalation": privilege_check(root),
        "cpu_mem_pids_limited": limits_check(root),
    }
    if options and "egress" in options:
        checks["egress"] = egress_check(options["egress"]["targets"])
    return {"probe": "sandbox-selftest/v1", "runnerKind": "container", "checks": checks}


def main():
    if len(sys.argv) != 1:
        raise ValueError("No command-line arguments supported")
    raw = sys.stdin.read(65537)
    if len(raw) > 65536:
        raise ValueError("Input too large")
    print(json.dumps(probe(json.loads(raw) if raw.strip() else {})))


if __name__ == "__main__":
    main()
