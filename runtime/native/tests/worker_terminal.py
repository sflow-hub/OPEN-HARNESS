#!/usr/bin/env python3
"""Drive the real coordinator, worker and CLI across two OS PTYs; only Docker is simulated."""
import contextlib
import http.client
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

CONTAINER = "d" * 64


def until(check, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {check}")


def provider(root):
    # Only this process knows the private value remembered by the first terminal.
    value = b""
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(str(root / "provider.sock"))
        server.listen()
        while True:
            client, _ = server.accept()
            with client, client.makefile("rb") as lines:
                client.sendall(f"provider-pid={os.getpid()}\n".encode())
                for line in lines:
                    if line.startswith(b"remember "):
                        value = line.split(maxsplit=1)[1].strip()
                        client.sendall(b"remembered\n")
                    elif line.strip() == b"recall":
                        client.sendall(b"remembered-value=" + value + b"\n")


def docker(root, op, args):
    if op == "info":
        print("28.0.0")
    elif op == "image":
        print("sha256:" + CONTAINER)
    elif op == "ps":
        pass
    elif op == "create":
        assert "--tty" in args and "--interactive" in args and "--env-file" not in args
        labels = dict(args[i+1].split("=", 1) for i, arg in enumerate(args) if arg == "--label")
        with (root / "labels").open("x") as file:  # A second create is a duplicate run.
            json.dump(labels, file)
        print(CONTAINER)
    elif op == "start":
        assert args == [CONTAINER]
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--provider"],
                                   start_new_session=True, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (root / "provider.pid").write_text(str(process.pid))
        until(lambda: (root / "provider.sock").exists())
    elif op == "inspect":
        assert args[-1] == CONTAINER
        print(CONTAINER, "true true true", (root / "labels").read_text())
    elif op == "attach":
        assert args == ["--sig-proxy=false", CONTAINER] and os.isatty(0)
        with socket.socket(socket.AF_UNIX) as stream:
            stream.connect(str(root / "provider.sock"))
            while True:
                ready, _, _ = select.select([0, stream], [], [])
                if 0 in ready:
                    data = os.read(0, 4096)
                    if not data:
                        return
                    stream.sendall(data)
                if stream in ready:
                    data = stream.recv(4096)
                    if not data:
                        return
                    os.write(1, data)
    elif op == "wait":
        assert args == [CONTAINER]
        until(lambda: (root / "removed").exists(), 60)
        print(0)
    elif op == "rm":
        pidfile = root / "provider.pid"
        if pidfile.exists():
            with contextlib.suppress(ProcessLookupError):
                os.kill(int(pidfile.read_text()), signal.SIGTERM)
        (root / "removed").touch()
    else:
        raise AssertionError(f"unexpected Docker command {op}")


def disconnected(process, master):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGHUP)
    process.wait(timeout=5)
    os.close(master)


def terminal(binary, state, env):
    master, slave = pty.openpty()
    try:
        cli = subprocess.Popen([binary, "--state-dir", str(state), "worker", "terminal", "--agent", "editor"],
                               stdin=slave, stdout=slave, stderr=slave, start_new_session=True, env=env)
    finally:
        os.close(slave)
    return cli, master


def expect(master, marker):
    output = bytearray()
    deadline = time.monotonic() + 25
    while marker not in output and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 4096)
            except OSError:
                break
            if not data:
                break
            output.extend(data)
    assert marker in output, f"terminal did not show {marker!r}: {output[-1000:]!r}"


def exercise(binary, root, paired):
    state = root / "worker"
    state.mkdir(mode=0o700)
    bindir = root / "bin"
    bindir.mkdir()
    shim = bindir / "docker"
    shutil.copyfile(__file__, shim)
    shim.chmod(0o700)
    env = dict(os.environ, PATH=str(bindir) + os.pathsep + os.environ["PATH"],
               OH_TTY_FIXTURE=str(root), OPEN_HARNESS_MOCK="0", OPEN_HARNESS_DISABLE_OS_VAULT="1")
    with (root / "service.log").open("w") as log, contextlib.ExitStack() as cleanup:
        server = subprocess.Popen([binary,"serve","--state-dir",str(state),"--port","0"],
                                  stdin=subprocess.DEVNULL,stdout=log,stderr=log,env=env)
        def stop_server():
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
            # The child may outlive a failed test before worker-side cleanup.
            path = root / "provider.pid"
            if path.exists() and not (root / "removed").exists():
                with contextlib.suppress(ProcessLookupError):
                    os.kill(int(path.read_text()), signal.SIGTERM)
        cleanup.callback(stop_server)
        def listening():
            output = (root / "service.log").read_text()
            assert server.poll() is None, output
            return re.search(r"serving http://127.0.0.1:(\d+)", output)
        port = int(until(listening).group(1))
        token = ""
        def api(method, path, body=None):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=4)
            try:
                conn.request(method, path, body=json.dumps(body) if body is not None else None,
                             headers={"Authorization": "Bearer " + token, "Content-Type":"application/json"})
                response = conn.getresponse()
                data = json.load(response)
                assert 200 <= response.status < 300, (path, response.status, data)
                return data
            finally:
                conn.close()
        token = api("GET","/v1/bootstrap")["token"]
        until(lambda: (state / "worker.sock").exists())
        profile = {"id":"editor","name":"Editor","harness":"claude-code","workerLaunch":True,
                   "model":{"inherit":False,"model":"test-model","provider":"anthropic",
                            "credentialRef":"","baseUrl":""}}
        machine = "local"
        if paired:
            code = api("POST","/v1/machines",{"name":"Terminal worker","platform":"linux"})["code"]
            state = root / "paired"
            state.mkdir(mode=0o700)
            remote = subprocess.Popen([binary,"runner","--state-dir",str(state),"--coordinator",
                                       f"http://127.0.0.1:{port}","--pairing-code",code],
                                      stdin=subprocess.DEVNULL,stdout=log,stderr=log,env=env)
            def stop_remote():
                if remote.poll() is None:
                    remote.terminate()
                    try:
                        remote.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        remote.kill()
                        remote.wait()
            cleanup.callback(stop_remote)
            def paired_machine():
                assert remote.poll() is None, "The paired worker exited during startup"
                return next((m["id"] for m in api("GET", "/v1/machines")["machines"]
                             if not m["local"] and m["status"] == "online"), None)
            machine = until(paired_machine)
            profile["machineId"] = machine
        api("POST","/v1/agents",profile)
        secret = b"worker-only-marker"
        with contextlib.ExitStack() as first:
            cli, master = terminal(binary, state, env)
            first.callback(disconnected, cli, master)
            expect(master,b"provider-pid=")
            os.write(master,b"remember "+secret+b"\n")
            expect(master,b"remembered")
        pid = (root / "provider.pid").read_text()
        runs = api("GET", "/v1/runs")["runs"]
        running = [r for r in runs if r["agent_id"] == "editor"]
        assert len(running) == 1 and running[0]["state"] == "running", running
        assert running[0]["machine_id"] == machine, running[0]["machine_id"]
        run = running[0]["id"]
        with contextlib.ExitStack() as second:
            cli, master = terminal(binary, state, env)
            second.callback(disconnected, cli, master)
            expect(master,b"provider-pid="+pid.encode())
            os.write(master,b"recall\n")
            expect(master,b"remembered-value="+secret)
        assert (root / "provider.pid").read_text() == pid
        api("POST",f"/v1/runs/{run}/stop",{})
        until(lambda: api("GET",f"/v1/runs/{run}")["state"] == "cancelled")
        until(lambda: (root / "removed").exists())
        events = api("GET",f"/v1/runs/{run}/events")
        assert secret.decode() not in json.dumps(events)
        assert secret.decode() not in (root / "service.log").read_text()


if __name__ == "__main__":
    if sys.argv[1:] == ["--provider"]:
        provider(Path(os.environ["OH_TTY_FIXTURE"]))
    elif Path(sys.argv[0]).name == "docker":
        docker(Path(os.environ["OH_TTY_FIXTURE"]), sys.argv[1], sys.argv[2:])
    else:
        # A short path is necessary for the fixture's own Unix stream socket.
        with tempfile.TemporaryDirectory(prefix="oh-tty-", dir="/tmp") as temporary:
            exercise(sys.argv[1], Path(temporary), sys.argv[2:] == ["paired"])
