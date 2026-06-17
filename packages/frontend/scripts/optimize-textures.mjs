/**
 * optimize-textures.mjs — Earth texture → KTX2 / Basis encoder (build-time, pure-WASM).
 *
 * Reads the high-res source maps from `texture-src/` (OUTSIDE `public/`, so Vite never
 * ships them) and emits GPU-compressed `.ktx2` into `public/textures/`, plus copies the
 * three.js Basis *transcoder* into `public/basis/` (needed by KTX2Loader at runtime).
 *
 * Encoder: `ktx2-encoder` (Basis Universal compiled to WASM). It cannot decode JPEG/PNG
 * itself, so `sharp` is supplied as the required `imageDecoder` — and is also where we do
 * grayscale conversion (R-only maps) and the bump/clouds 8K→4K downscale. The encoder has
 * a fixed ~10 MB internal output buffer, which is why bump/clouds MUST downscale.
 *
 * Run: `npm run textures:optimize`  (only needed when source textures change; the committed
 * `.ktx2` mean normal dev/build/CI never touch this script or its devDependencies).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { encodeToKTX2 } from 'ktx2-encoder';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(__dirname, '..');
const SRC_DIR = path.join(FRONTEND, 'texture-src');
const OUT_DIR = path.join(FRONTEND, 'public', 'textures');
const BASIS_OUT = path.join(FRONTEND, 'public', 'basis');
const MANIFEST_OUT = path.join(FRONTEND, 'src', 'engine', 'textures', 'texture-manifest.ts');

// Shared across every texture. isYFlip bakes the vertical flip at encode time because
// compressed textures can't be flipped on upload — this matches three's historic
// flipY=true on the source JPEGs. If the globe renders upside-down, flip this to false.
const COMMON = { isKTX2File: true, generateMipmap: true, isYFlip: true };
// compressionLevel is ETC1S encode *effort* (0–6); 5 takes minutes on an 8K image, so use
// the default 2. qualityLevel (codebook size) drives quality/size, kept high at 192.
const ETC1S = { isUASTC: false, qualityLevel: 192, compressionLevel: 2 };
const UASTC = { isUASTC: true, needSupercompression: true, isNormalMap: false };

// Optional CLI filter: `node scripts/optimize-textures.mjs bump specular` encodes only
// the named textures (substring match) — handy for iterating without the slow 8K runs.
const FILTER = process.argv.slice(2);

/**
 * @type {{ name:string, src:string, redMask:boolean, resize:{w:number,h:number}|null, opts:object }[]}
 */
const TEXTURES = [
  // color maps — sRGB, perceptual, ETC1S keeps 8K within the encoder's 10 MB cap
  { name: 'earth-diffuse-8k', src: 'earth-diffuse-8k.jpg', redMask: false, resize: null,
    opts: { ...ETC1S, isSetKTX2SRGBTransferFunc: true, isPerceptual: true } },
  { name: 'earth-night-4k', src: 'earth-night-4k.jpg', redMask: false, resize: null,
    opts: { ...ETC1S, isSetKTX2SRGBTransferFunc: true, isPerceptual: true } },

  // data maps — linear, non-perceptual; shader reads `.r`, so extract the source RED
  // channel into R=G=B (see makeDecoder — luminance grayscale would corrupt the bump map)
  { name: 'earth-bump-4k', src: 'earth-bump-4k.jpg', redMask: true, resize: { w: 4096, h: 2048 },
    opts: { ...UASTC, isSetKTX2SRGBTransferFunc: false, isPerceptual: false } },
  { name: 'earth-specular-4k', src: 'earth-specular-4k.jpg', redMask: true, resize: null,
    opts: { ...UASTC, isSetKTX2SRGBTransferFunc: false, isPerceptual: false } },
  { name: 'earth-clouds-4k', src: 'earth-clouds-4k.png', redMask: true, resize: { w: 4096, h: 2048 },
    opts: { ...ETC1S, isSetKTX2SRGBTransferFunc: false, isPerceptual: false } },
];

/** Expand any 1/2/3/4-channel raw buffer to RGBA (encoder needs width*height*4). */
function toRGBA(data, w, h, ch) {
  if (ch === 4) return data;
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++) {
    if (ch === 1) {            // grayscale → R=G=B, opaque
      const g = data[i]; out[j++] = g; out[j++] = g; out[j++] = g; out[j++] = 255;
    } else if (ch === 2) {     // gray + alpha
      const g = data[i * 2]; out[j++] = g; out[j++] = g; out[j++] = g; out[j++] = data[i * 2 + 1];
    } else {                   // ch === 3, RGB → opaque
      out[j++] = data[i * 3]; out[j++] = data[i * 3 + 1]; out[j++] = data[i * 3 + 2]; out[j++] = 255;
    }
  }
  return out;
}

/** sharp-backed decoder: applies resize + red-channel extraction, returns RGBA.
 *  For R-mask maps the shaders sample `.r`, so we extract the source RED channel
 *  (NOT luminance grayscale) — the bump source is R=128,G=128,B=255, so luminance
 *  would corrupt the height values. extractChannel(0) preserves `.r` exactly. */
const makeDecoder = ({ redMask, resize }) => async (buf) => {
  let img = sharp(buf, { limitInputPixels: false });
  if (resize) img = img.resize(resize.w, resize.h, { fit: 'fill' });
  if (redMask) img = img.extractChannel(0);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: toRGBA(data, info.width, info.height, info.channels) };
};

const fmtMB = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB';

/** Locate a package's root dir by walking up from its resolved entry (exports may hide
 *  package.json, so we can't resolve it directly). Hoist-agnostic. */
function resolvePkgDir(name) {
  let dir = path.dirname(require.resolve(name));
  while (dir !== path.dirname(dir)) {
    try {
      if (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name === name) return dir;
    } catch { /* keep walking */ }
    dir = path.dirname(dir);
  }
  throw new Error(`cannot locate package dir for "${name}"`);
}

async function copyBasisTranscoder() {
  // Resolve three from wherever it's hoisted (workspace root here) — never hardcode a path.
  const threeDir = resolvePkgDir('three');
  const basisSrc = path.join(threeDir, 'examples', 'jsm', 'libs', 'basis');
  await fs.mkdir(BASIS_OUT, { recursive: true });
  for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
    await fs.copyFile(path.join(basisSrc, f), path.join(BASIS_OUT, f));
  }
  console.log(`  basis transcoder → public/basis/ (from ${path.relative(FRONTEND, basisSrc)})`);
}

/** Keep only the current hashed `.ktx2` files in public/textures — removes old content
 *  hashes (so they don't accumulate) AND stray files like macOS `.DS_Store`. */
async function pruneOutDir(keep) {
  for (const entry of await fs.readdir(OUT_DIR)) {
    if (!keep.has(entry)) {
      await fs.rm(path.join(OUT_DIR, entry), { force: true });
      console.log(`  pruned: textures/${entry}`);
    }
  }
}

/** Write the typed name→hashed-URL map the renderers import (content-hashed filenames
 *  let us serve textures with `Cache-Control: immutable`). */
async function writeManifest(manifest) {
  const entries = Object.entries(manifest)
    .map(([name, url]) => `  '${name}': '${url}',`)
    .join('\n');
  const ts =
    `// AUTO-GENERATED by scripts/optimize-textures.mjs — do not edit by hand.\n` +
    `// Content-hashed KTX2 texture URLs. Regenerate with: npm run textures:optimize\n` +
    `export const TEXTURE_URLS = {\n${entries}\n} as const;\n\n` +
    `export type TextureName = keyof typeof TEXTURE_URLS;\n`;
  await fs.writeFile(MANIFEST_OUT, ts);
  console.log(`  manifest → src/engine/textures/texture-manifest.ts (${Object.keys(manifest).length} textures)`);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const queue = FILTER.length
    ? TEXTURES.filter((t) => FILTER.some((f) => t.name.includes(f)))
    : TEXTURES;
  console.log(`Encoding ${queue.length} texture(s): ${SRC_DIR} → ${OUT_DIR}\n`);

  let totalIn = 0, totalOut = 0;
  const failures = [];
  const manifest = {};

  for (const tex of queue) {
    const srcPath = path.join(SRC_DIR, tex.src);
    const mode = tex.opts.isUASTC ? 'UASTC+Zstd' : 'ETC1S';
    const res = tex.resize ? `${tex.resize.w}×${tex.resize.h}` : 'native';
    try {
      const srcBuf = await fs.readFile(srcPath);
      const ktx2 = await encodeToKTX2(srcBuf, {
        ...COMMON, ...tex.opts, imageDecoder: makeDecoder(tex),
      });
      // Content hash in the filename → safe to serve with Cache-Control: immutable.
      const hash = createHash('sha256').update(ktx2).digest('hex').slice(0, 8);
      const outName = `${tex.name}.${hash}.ktx2`;
      await fs.writeFile(path.join(OUT_DIR, outName), ktx2);
      manifest[tex.name] = `/textures/${outName}`;
      totalIn += srcBuf.length;
      totalOut += ktx2.length;
      console.log(
        `✓ ${tex.name.padEnd(20)} ${mode.padEnd(11)} ${res.padEnd(11)} ` +
        `${fmtMB(srcBuf.length).padStart(9)} → ${fmtMB(ktx2.length).padStart(9)}  ${outName}`,
      );
    } catch (err) {
      failures.push(tex.name);
      console.error(`✗ ${tex.name}: ${err?.message ?? err}`);
      if (String(err?.message ?? err).includes('Encode failed')) {
        console.error(`  ↳ likely exceeded the encoder's 10 MB output buffer — lower ` +
          `qualityLevel or downscale this texture.`);
      }
    }
  }

  console.log();
  await copyBasisTranscoder();

  // The manifest must describe ALL textures, and pruning removes old hashes — both are
  // only valid after a FULL run. A filtered run is for iterating on one texture's output.
  if (FILTER.length) {
    console.warn('  ⚠ filtered run — manifest NOT regenerated and old hashes NOT pruned.\n' +
      '    Run `npm run textures:optimize` (no args) to update texture-manifest.ts.');
  } else if (!failures.length) {
    await writeManifest(manifest);
    await pruneOutDir(new Set(Object.values(manifest).map((u) => path.basename(u))));
  }

  console.log(`\nTotal: ${fmtMB(totalIn)} → ${fmtMB(totalOut)}`);

  if (failures.length) {
    console.error(`\n${failures.length} texture(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
