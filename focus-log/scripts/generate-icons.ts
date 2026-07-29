/**
 * Renders the PWA icon set from one SVG source.
 *
 * The mark is the same filament used in the app shell: a thin ring with a
 * glowing ember core on the warm-black ground.
 *
 * Uses sharp, which Next already depends on, rather than adding an image
 * toolchain. Run with: npm run icons
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

const INK = "#0b0a09";
const EMBER = "#ff7a18";

/**
 * @param safeArea fraction of the canvas the mark occupies. Maskable icons need
 *   the mark inside the middle 80% so platform masks cannot crop it.
 */
function markSvg(size: number, safeArea: number, rounded: boolean): string {
  const c = size / 2;
  const ringR = (size * safeArea) / 2;
  const coreR = ringR * 0.3;
  const stroke = Math.max(1, ringR * 0.075);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="glow">
      <stop offset="0%" stop-color="${EMBER}" stop-opacity="0.85"/>
      <stop offset="55%" stop-color="${EMBER}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${EMBER}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="${INK}"${rounded ? ` rx="${size * 0.22}"` : ""}/>
  <circle cx="${c}" cy="${c}" r="${ringR * 1.35}" fill="url(#glow)"/>
  <circle cx="${c}" cy="${c}" r="${ringR}" fill="none" stroke="${EMBER}" stroke-opacity="0.5" stroke-width="${stroke}"/>
  <circle cx="${c}" cy="${c}" r="${coreR}" fill="${EMBER}"/>
</svg>`;
}

interface IconSpec {
  file: string;
  size: number;
  safeArea: number;
  rounded: boolean;
}

const ICONS: IconSpec[] = [
  { file: "icon-192.png", size: 192, safeArea: 0.52, rounded: true },
  { file: "icon-512.png", size: 512, safeArea: 0.52, rounded: true },
  // Maskable: mark kept well inside the safe zone, full-bleed background.
  { file: "icon-maskable-192.png", size: 192, safeArea: 0.36, rounded: false },
  { file: "icon-maskable-512.png", size: 512, safeArea: 0.36, rounded: false },
  { file: "apple-touch-icon.png", size: 180, safeArea: 0.52, rounded: false },
];

async function main(): Promise<void> {
  mkdirSync(publicDir, { recursive: true });

  for (const icon of ICONS) {
    const svg = markSvg(icon.size, icon.safeArea, icon.rounded);
    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    writeFileSync(join(publicDir, icon.file), png);
    process.stdout.write(`wrote public/${icon.file} (${icon.size}px)\n`);
  }

  // Favicon as SVG: crisp at any size and smaller than a multi-res .ico.
  writeFileSync(join(publicDir, "icon.svg"), markSvg(64, 0.52, false));
  process.stdout.write("wrote public/icon.svg\n");
}

await main();
