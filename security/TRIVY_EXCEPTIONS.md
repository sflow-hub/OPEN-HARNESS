# Hermes image vulnerability exceptions

Reviewed: 2026-09-25. Expires: 2026-10-09.

The release scan found 80 high/critical package occurrences representing 32 unique CVEs in the Debian 13 Hermes runtime. Trivy reported no available fixed version for any of them. The coordinator image had zero high/critical findings, and both images had zero detected secrets.

These temporary exceptions apply only to the Hermes image. They do not suppress source or coordinator findings. The release workflow still fails for any new high/critical CVE and when these entries expire.

## Boundary used for review

Hermes already gives the model same-user code execution inside its own container. The security boundary is the container: it runs as UID 10001 with `no-new-privileges`, without the host Docker socket or other agents' private directories, and with only its own private directory plus the explicitly shared workspace mounted. A library flaw that grants the privileges the agent already has does not expand that boundary. Container escape, host privilege escalation, cross-agent access, or credential disclosure remains release-blocking.

## Reviewed groups

- **Privileged mount and account utilities:** CVE-2026-76642, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410, CVE-2026-54369, and CVE-2026-16742 require mount, cgroup, systemd-homed, or privilege paths unavailable in the unprivileged container.
- **Private virtual display:** CVE-2023-5574, CVE-2026-88806, and CVE-2026-88807 are confined to Xvfb and clients inside the same agent container; there is no host display socket.
- **Absent services or code:** CVE-2022-4055 requires Thunderbird; CVE-2026-34980 requires a CUPS server queue; CVE-2026-74860 requires Debian's libxml2 Python bindings; CVE-2026-9538 requires Archive::Tar. Those components are absent.
- **Secondary Debian Python:** CVE-2026-15308, CVE-2026-7210, and CVE-2026-82049 apply to Debian Python 3.13 retained by Node/Openbox packaging. Hermes runs `/usr/local` Python 3.12. Executing the secondary interpreter would still have only the agent's existing UID and mounts.
- **Content parsers and terminal libraries:** CVE-2025-69720, CVE-2026-36849, CVE-2026-37555, CVE-2026-52490, CVE-2026-66046, CVE-2026-6653, CVE-2026-76956, CVE-2026-76957, CVE-2026-86138, CVE-2026-86139, CVE-2026-86140, CVE-2026-86142, CVE-2026-86143, CVE-2026-86144, CVE-2026-93990, and CVE-2026-96889 can at most compromise or stop the already code-executing agent process inside its container. The [Debian security tracker](https://security-tracker.debian.org/tracker/CVE-2026-6653) classifies CVE-2026-6653 as a minor issue with no security update planned for Trixie at review time, despite Trivy inheriting a critical rating.

Review every exception again when Debian publishes a fixed package, when the container capability or mount model changes, or by 2026-10-09, whichever comes first. The machine-readable list is `security/trivy-exceptions.yaml`.
