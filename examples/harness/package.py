"""Build a working echo harness package from an existing managed-runtime image.

Run from the project checkout:
  python3 examples/harness/package.py --image open-harness-hermes:2026.9.11 --output /tmp/echo-harness.zip
Docker is used to save the image, never to run a host install script.
"""
import argparse
import hashlib
import json
import io
import tarfile
from pathlib import Path
import subprocess
import tempfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument("--image", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
details = json.loads(subprocess.check_output(["docker", "image", "inspect", args.image]))[0]
arch = {"amd64": "x64", "arm64": "arm64"}[details["Architecture"]]
with tempfile.TemporaryDirectory() as directory:
    archive = Path(directory) / "image.tar"
    subprocess.run(["docker", "save", "-o", str(archive), args.image], check=True)
    # Importing this package must never replace an existing repository tag.
    untagged = Path(directory) / "untagged.tar"
    with tarfile.open(archive, "r:") as source, tarfile.open(untagged, "w", format=tarfile.USTAR_FORMAT) as target:
        for member in source:
            data = source.extractfile(member) if member.isfile() else None
            if member.name in ("manifest.json", "index.json", "repositories"):
                value = json.load(data)
                if member.name == "manifest.json":
                    for item in value:
                        item["RepoTags"] = []
                elif member.name == "index.json":
                    for item in [value, *value.get("manifests", [])]:
                        item.pop("annotations", None)
                else:
                    value = {}
                content = json.dumps(value).encode()
                member.size = len(content)
                data = io.BytesIO(content)
            target.addfile(member, data)
    untagged.replace(archive)
    adapter = Path(__file__).with_name("adapter.mjs")
    def digest(path):
        h = hashlib.sha256()
        with path.open("rb") as file:
            for chunk in iter(lambda: file.read(1048576), b""):
                h.update(chunk)
        return h.hexdigest()
    manifest = {
        "schemaVersion": 1, "id": "echo", "name": "Echo example", "version": "1.0.0", "license": "MIT",
        "architecture": [arch], "image": details["Id"], "imageArchive": "image.tar",
        "command": ["node", "/opt/open-harness/package/adapter.mjs"], "protocol": "open-harness-runtime/v1",
        "features": {"memory": False, "skills": False, "sessionRecall": False, "scheduling": True, "desktop": False,
                     "mcp": False, "approvals": True, "steer": False, "clarify": False},
        "providers": [], "configuration": [], "files": {"adapter.mjs": digest(adapter), "image.tar": digest(archive)}
    }
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as package:
        package.writestr("harness.json", json.dumps(manifest))
        package.write(adapter, "adapter.mjs")
        package.write(archive, "image.tar")
print(args.output)
