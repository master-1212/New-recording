import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFile(join(root, path), "utf8");

test("dependency manifests use exact versions and a pinned package manager", async () => {
  const manifest = JSON.parse(await read("package.json")) as { packageManager?: string; dependencies: Record<string, string>; devDependencies: Record<string, string> };
  assert.match(manifest.packageManager ?? "", /^pnpm@\d+\.\d+\.\d+$/);
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    assert.match(version, /^\d+\.\d+\.\d+/, `${name} is not exact: ${version}`);
  }
});

test("CI actions are immutable and run with read-only repository permission", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  assert.match(workflow, /permissions:\s+contents: read/);
  const uses = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(uses.length >= 2);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/);
  assert.match(workflow, /persist-credentials: false/);
});

test("dependency build scripts are denied unless explicitly reviewed", async () => {
  const workspace = await read("pnpm-workspace.yaml");
  const workflow = await read(".github/workflows/ci.yml");
  assert.match(workspace, /allowBuilds:\s+unrs-resolver: true/);
  assert.match(workspace, /strictDepBuilds: true/);
  assert.match(workspace, /overrides:\n\s+nanoid: 3\.3\.18/, "patched nanoid override is missing");
  assert.doesNotMatch(workspace, /dangerouslyAllowAllBuilds: true/);
  assert.doesNotMatch(workspace, /onlyBuiltDependencies:/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(workflow, /pnpm install[^\n]*--ignore-scripts/);
});

test("runtime code is hash-verified during the build and no mutable proxy route remains", async () => {
  assert.equal(existsSync(join(root, "src/app/runtime/[asset]/route.ts")), false);
  for (const file of ["kernel.js", "processor.js", "core.wasm", "core-simd.wasm", "ml-kernel-v3.js", "ort-wasm-simd-threaded.jsep.wasm"]) {
    assert.equal(existsSync(join(root, "public/runtime", file)), true, `${file} is missing`);
  }
  const worker = await read("src/workers/transcribe.worker.ts");
  const manifest = await read("package.json");
  const vendor = await read("scripts/vendor-runtime.mjs");
  const ignore = await read(".gitignore");
  assert.match(manifest, /"prebuild": "pnpm vendor:runtime"/);
  assert.match(vendor, /sha256:/);
  assert.match(vendor, /rejected untrusted bytes/);
  assert.match(ignore, /public\/runtime\//);
  assert.match(worker, /revision: "[0-9a-f]{40}"/);
  assert.match(worker, /wasmPaths = "\/runtime\/"/);
  assert.equal(existsSync(join(root, "public/worklets/spectral-denoise.js")), true, "same-origin spectral worklet is missing");
});

test("security headers isolate the app and block framing", async () => {
  const config = await read("next.config.ts");
  for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "worker-src 'self' blob:"]) {
    assert.ok(config.includes(directive), `${directive} is missing`);
  }
  assert.match(config, /X-Frame-Options[\s\S]*DENY/);
  assert.match(config, /Strict-Transport-Security/);
});

test("recording recovery never stores a plaintext Blob", async () => {
  const session = await read("src/lib/audioSession.ts");
  assert.match(session, /AES-GCM/);
  assert.match(session, /PBKDF2/);
  assert.match(session, /600_000/);
  assert.doesNotMatch(session, /blob:\s*file/);
});
