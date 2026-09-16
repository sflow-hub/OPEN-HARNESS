import { createWriteStream } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";

const version = process.env.OPEN_HARNESS_NODE_VERSION || "22.23.2";
const target = process.env.TAURI_TARGET || process.argv[2];
if (!target) throw new Error("Pass the Rust target triple, for example x86_64-unknown-linux-gnu.");
const mapping = {
  "x86_64-unknown-linux-gnu": ["linux-x64", "tar.xz", "bin/node"],
  "aarch64-unknown-linux-gnu": ["linux-arm64", "tar.xz", "bin/node"],
  "x86_64-apple-darwin": ["darwin-x64", "tar.gz", "bin/node"],
  "aarch64-apple-darwin": ["darwin-arm64", "tar.gz", "bin/node"],
  "x86_64-pc-windows-msvc": ["win-x64", "zip", "node.exe"],
  "aarch64-pc-windows-msvc": ["win-arm64", "zip", "node.exe"],
};
const spec = mapping[target];
if (!spec) throw new Error(`Unsupported desktop target: ${target}`);
const [archiveTarget, extension, relativeBinary] = spec;
const archiveName = `node-v${version}-${archiveTarget}.${extension}`;
const url = `https://nodejs.org/dist/v${version}/${archiveName}`;
const temp = await mkdtemp(join(tmpdir(), "open-harness-node-"));
const archive = join(temp, archiveName);
const response = await fetch(url);
if (!response.ok || !response.body) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
function run(program, args) { return new Promise((ok, fail) => { const child = spawn(program, args, { cwd: temp, stdio: "inherit" }); child.once("error", fail); child.once("exit", code => code === 0 ? ok() : fail(new Error(`${program} exited with ${code}`))); }); }
if (extension === "zip") await run("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${temp.replaceAll("'", "''")}' -Force`]);
else await run("tar", [extension === "tar.xz" ? "-xJf" : "-xzf", archive]);
const extracted = join(temp, archiveName.slice(0, -(extension.length + 1)), relativeBinary);
const binaries = resolve(import.meta.dirname, "..", "src-tauri", "binaries");
await mkdir(binaries, { recursive: true });
const destination = join(binaries, `node-${target}${target.includes("windows") ? ".exe" : ""}`);
await cp(extracted, `${destination}.new`); await chmod(`${destination}.new`, 0o755); await rename(`${destination}.new`, destination);
await rm(temp, { recursive: true, force: true });
console.log(`Prepared ${basename(destination)}`);
