#!/usr/bin/env node
/**
 * Generates PWA icons (PNG @ 192 / 512 px, plus 192 maskable + 512 maskable)
 * from `public/favicon.svg`. The maskable variants add a safe-area padding
 * (~10%) so the icon stays inside the platform mask shape.
 *
 * Usage: node scripts/generate-pwa-icons.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const publicDir = join(root, "public");
const svgPath = join(publicDir, "favicon.svg");

const baseSvg = readFileSync(svgPath, "utf8");

/** Render the source SVG at `size` px, filling the canvas (purpose=any). */
async function renderAny(size) {
  const buf = Buffer.from(baseSvg, "utf8");
  return sharp(buf, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Render with ~10% padding around to stay inside maskable safe area. */
async function renderMaskable(size) {
  const inner = Math.round(size * 0.78);
  const innerPng = await sharp(Buffer.from(baseSvg, "utf8"), { density: 384 })
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Solid background matching the rounded-rect fill in the SVG (#1a1a1e)
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 26, g: 26, b: 30, alpha: 1 },
    },
  })
    .composite([{ input: innerPng, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  const targets = [
    { name: "icon-192.png", buf: await renderAny(192) },
    { name: "icon-512.png", buf: await renderAny(512) },
    { name: "icon-192-maskable.png", buf: await renderMaskable(192) },
    { name: "icon-512-maskable.png", buf: await renderMaskable(512) },
    { name: "apple-touch-icon.png", buf: await renderMaskable(180) },
  ];
  for (const t of targets) {
    writeFileSync(join(publicDir, t.name), t.buf);
    process.stdout.write(`✓ ${t.name} (${t.buf.length} bytes)\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
