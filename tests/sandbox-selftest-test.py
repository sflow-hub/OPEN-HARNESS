import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sandbox_selftest", Path(__file__).resolve().parents[1] / "runtime/hermes/sandbox_selftest.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class SandboxProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("etc", "usr", "tmp", "proc/self", "sys/fs/cgroup", "var/run"):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        (self.root / "proc/self/status").write_text("NoNewPrivs:\t1\nCapEff:\t00000000\nSeccomp:\t2\n")
        (self.root / "proc/self/cgroup").write_text("0::/\n")
        for name, value in {"pids.max": "512", "memory.max": "4294967296", "cpu.max": "200000 100000"}.items():
            (self.root / "sys/fs/cgroup" / name).write_text(value)

    def test_default_does_not_connect_and_removes_writes(self):
        with patch.object(probe.socket, "create_connection", side_effect=AssertionError("network forbidden")):
            value = probe.probe(root_dir=self.root)
        self.assertEqual(value["probe"], "sandbox-selftest/v1")
        checks = value["checks"]
        self.assertFalse(checks["writes_outside_writable_mounts_denied"]["ok"])
        self.assertEqual(set(json.loads(checks["writes_outside_writable_mounts_denied"]["detail"])), {"/", "/etc", "/usr", "/tmp"})
        self.assertEqual(list(self.root.rglob(".sandbox-selftest-*")), [])
        self.assertTrue(checks["no_privilege_escalation"]["ok"])
        self.assertTrue(checks["cpu_mem_pids_limited"]["ok"])
        self.assertNotIn("egress", checks)

    def test_denied_and_missing_paths(self):
        with patch.object(probe.os, "open", side_effect=PermissionError(13, "denied")):
            self.assertTrue(probe.write_checks(self.root)["ok"])
        (self.root / "etc").rmdir()
        self.assertFalse(probe.write_checks(self.root)["ok"])

    def test_visible_socket_home_and_unlimited_resources(self):
        (self.root / "var/run/docker.sock").touch()
        (self.root / "host").mkdir()
        (self.root / "sys/fs/cgroup/pids.max").write_text("max")
        (self.root / "proc/self/status").write_text("NoNewPrivs: 0\nCapEff: ff\nSeccomp: 0\n")
        checks = probe.probe(root_dir=self.root)["checks"]
        for name in ("docker_socket_absent", "host_home_absent", "no_privilege_escalation", "cpu_mem_pids_limited"):
            self.assertFalse(checks[name]["ok"])
        (self.root / "proc/self/status").unlink()
        self.assertIsNone(probe.privilege_check(self.root)["ok"])

    def test_opt_in_connections_send_no_data(self):
        target = {"host": "fixture.invalid", "port": 443, "expect": "open"}
        with patch.object(probe.socket, "create_connection") as connect:
            self.assertTrue(probe.egress_check([target])["ok"])
            connect.assert_called_once_with(("fixture.invalid", 443), timeout=3)
            connect.return_value.__enter__.return_value.send.assert_not_called()
        target["expect"] = "refused"
        with patch.object(probe.socket, "create_connection", side_effect=ConnectionRefusedError):
            self.assertTrue(probe.egress_check([target])["ok"])
        with patch.object(probe.socket, "create_connection", side_effect=TimeoutError):
            self.assertIsNone(probe.egress_check([target])["ok"])


if __name__ == "__main__":
    unittest.main()
