import { build } from "esbuild";
import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { resolve,basename } from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from 'node:child_process';
import { validateImageLock } from '../scripts/release-images.mjs';

const root = resolve(import.meta.dirname, "..");
const bundle = resolve(root, "src-tauri", "resources", "bundle");
const config=JSON.parse(await readFile(resolve(root,'src-tauri','tauri.conf.json'),'utf8'));
let releaseImage;
if(config.bundle.createUpdaterArtifacts){
  if(!process.env.OPEN_HARNESS_RELEASE_IMAGE_LOCK)throw new Error('Signed desktop builds require the accepted release image-lock.json; source builds are not used on first launch.');
  const manifest=JSON.parse(await readFile(resolve(process.env.OPEN_HARNESS_RELEASE_IMAGE_LOCK),'utf8')),version=JSON.parse(await readFile(resolve(root,'package.json'),'utf8')).version,revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();validateImageLock(manifest,version,revision);releaseImage={ref:manifest.images.hermes.ref,contract:10,version,revision};
}

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
if(releaseImage)await writeFile(resolve(bundle,'runtime','release-image.json'),JSON.stringify(releaseImage)+'\n');
await cp(resolve(root, "dist", "standalone"), resolve(bundle, "app"), { recursive: true });
await cp(resolve(root, "runtime", "hermes"), resolve(bundle, "runtime", "hermes"), { recursive: true,filter:path=>!/ \d+(?:\.|$)|__pycache__|\.pyc$/.test(basename(path)) });
await cp(resolve(root, "runtime", "ubuntu"), resolve(bundle, "runtime", "ubuntu"), { recursive: true });
await cp(resolve(root, "runtime", "installers"), resolve(bundle, "runtime", "installers"), { recursive: true });
for (const entry of ["service", "runner"]) {
  await build({ entryPoints: [resolve(root, "runtime", `${entry}.ts`)], outfile: resolve(bundle, "runtime", `${entry}.mjs`), bundle: true, platform: "node", format: "esm", target: "node22", packages: "bundle", sourcemap: false, banner: { js: "import { createRequire as __openHarnessCreateRequire } from 'node:module'; const require = __openHarnessCreateRequire(import.meta.url);" } });
}
await writeFile(resolve(bundle, "package.json"), JSON.stringify({ type: "module", private: true }));
console.log(`Desktop runtime prepared in ${bundle}`);
