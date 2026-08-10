import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "public", "runtime");
const mode = process.argv[2];

const assets = [
  {
    file: "kernel.js",
    url: "https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/dist/index.js",
    sha256: "dB7xCrnqOzpPGURbg3VH9cYM0DbKDO77BJtrgZ0211k=",
  },
  {
    file: "processor.js",
    url: "https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/dist/rnnoise/workletProcessor.js",
    sha256: "fpXxOP9pAaaiRt0p5r5KHo5K2iuvC8wE2uBldFtR/z0=",
  },
  {
    file: "core.wasm",
    url: "https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/dist/rnnoise.wasm",
    sha256: "i2Ciq4j9ri0an5QCSdDrBy8ouo55b3MENHtOB4OciFM=",
  },
  {
    file: "core-simd.wasm",
    url: "https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/dist/rnnoise_simd.wasm",
    sha256: "i2Ciq4j9ri0an5QCSdDrBy8ouo55b3MENHtOB4OciFM=",
  },
  {
    file: "ml-kernel-v3.js",
    url: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js",
    sha256: "E3Rq6IaVti5DH8Xr476xCggNIIFAYEdnBjnOjBCpuiU=",
  },
  {
    file: "ort-wasm-simd-threaded.jsep.mjs",
    url: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/ort-wasm-simd-threaded.jsep.mjs",
    sha256: "CPuG7EM8eL+wMsXYSmi46OWo2BJo+jniQxQXmldnpbk=",
  },
  {
    file: "ort-wasm-simd-threaded.jsep.wasm",
    url: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/ort-wasm-simd-threaded.jsep.wasm",
    sha256: "xGZV6KlK/EUzjUyyuEBHX4jlAS1SRQmRblBQecAL+jk=",
  },
  {
    file: "LICENSE.rnnoise.txt",
    url: "https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/LICENSE",
    sha256: "2Rpyf89xFeZsFP10MLkguqosSfmQjQ30c+fZca/88ho=",
  },
  {
    file: "LICENSE.transformers.txt",
    url: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/LICENSE",
    sha256: "z8d0m5b2O9McPEK1xHG/dWgUBT6EfBDz6wA0F7xSPTA=",
  },
];

function digest(data) {
  return createHash("sha256").update(data).digest("base64");
}

async function verifyAsset(asset) {
  const data = await readFile(join(destination, asset.file));
  const actual = digest(data);
  if (actual !== asset.sha256) {
    throw new Error(`${asset.file}: SHA-256 mismatch (expected ${asset.sha256}, received ${actual})`);
  }
}

async function downloadAsset(asset) {
  try {
    await verifyAsset(asset);
    return;
  } catch {
    // Missing or changed files are replaced only after the downloaded bytes pass the pinned hash.
  }
  const response = await fetch(asset.url, {
    redirect: "follow",
    headers: { "User-Agent": "VoiceScope-runtime-vendor/1.0" },
  });
  if (!response.ok) throw new Error(`${asset.file}: download failed with HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = digest(data);
  if (actual !== asset.sha256) {
    throw new Error(`${asset.file}: rejected untrusted bytes (expected ${asset.sha256}, received ${actual})`);
  }
  const target = join(destination, asset.file);
  const temporary = `${target}.verified-download`;
  await writeFile(temporary, data, { mode: 0o644 });
  await rename(temporary, target);
}

if (mode !== "--write" && mode !== "--verify") {
  throw new Error("Use --write to download verified assets or --verify to check committed assets.");
}

await mkdir(destination, { recursive: true });
try {
  if (mode === "--write") {
    for (const asset of assets) await downloadAsset(asset);
  }
  await Promise.all(assets.map(verifyAsset));
  console.log(`Verified ${assets.length} immutable runtime assets.`);
} catch (error) {
  for (const asset of assets) await rm(join(destination, `${asset.file}.verified-download`), { force: true });
  throw error;
}
