import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const bundle = resolve(root, "src-tauri", "resources", "bundle");

function command(program, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolvePromise() : reject(new Error(`${program} exited with ${code}`)));
  });
}

await command(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);
await command(process.execPath, ["desktop/build-runner.mjs"]);
await rm(bundle, { recursive: true, force: true });
await mkdir(resolve(bundle, "runtime"), { recursive: true });
await cp(resolve(root, "dist", "standalone"), resolve(bundle, "app"), { recursive: true });
await cp(resolve(root, "runtime", "hermes"), resolve(bundle, "runtime", "hermes"), { recursive: true });
await cp(resolve(root, "runtime", "installers"), resolve(bundle, "runtime", "installers"), { recursive: true });
for (const entry of ["service", "runner"]) {
  await build({ entryPoints: [resolve(root, "runtime", `${entry}.ts`)], outfile: resolve(bundle, "runtime", `${entry}.mjs`), bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", sourcemap: false, banner: { js: "import { createRequire as __openHarnessCreateRequire } from 'node:module'; const require = __openHarnessCreateRequire(import.meta.url);" } });
}
await writeFile(resolve(bundle, "package.json"), JSON.stringify({ type: "module", private: true }));
console.log(`Desktop runtime prepared in ${bundle}`);
