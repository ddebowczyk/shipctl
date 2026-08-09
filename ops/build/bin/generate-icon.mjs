import sharp from "sharp";
import { readFile } from "node:fs/promises";

const SIZE = 1024;
const PADDING = 180; // breathing room around the logo
const CORNER_RADIUS = 220;
const LOGO_PATH = new URL("../../../assets/shipctl-color.svg", import.meta.url);
const OUTPUT_PATH = new URL("../../../assets/icon-1024.png", import.meta.url).pathname;

function extractViewBox(svg) {
  const match = svg.match(/viewBox="([^"]+)"/i);
  if (!match) {
    throw new Error("Logo SVG is missing a viewBox");
  }

  const [, viewBox] = match;
  const [, , width, height] = viewBox
    .trim()
    .split(/\s+/)
    .map(Number);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid SVG viewBox: ${viewBox}`);
  }

  return { width, height };
}

function extractInnerSvg(svg) {
  const match = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
  if (!match) {
    throw new Error("Failed to extract SVG contents");
  }
  return match[1];
}

// The contents are re-wrapped in a fresh <svg> below, so any namespace the
// source declared has to come along. Editor exports (Inkscape) carry
// `sodipodi:`/`inkscape:` markup, and an undeclared prefix is a hard XML parse
// error in librsvg — not something it skips.
function extractNamespaceDeclarations(svg) {
  const match = svg.match(/<svg([^>]*)>/i);
  if (!match) {
    throw new Error("Failed to read the SVG root element");
  }

  const declarations = match[1].match(/xmlns:[\w.-]+="[^"]*"/g) ?? [];
  return declarations.length > 0 ? ` ${declarations.join(" ")}` : "";
}

const logoSvg = await readFile(LOGO_PATH, "utf8");
const { width: logoWidth, height: logoHeight } = extractViewBox(logoSvg);
const logoMarkup = extractInnerSvg(logoSvg);
const logoNamespaces = extractNamespaceDeclarations(logoSvg);

const availableSize = SIZE - PADDING * 2;

// Render the logo alone, then trim the transparent margin. A logo's artwork
// need not fill its own viewBox — scaling by the viewBox alone leaves the mark
// floating small and off-centre. Trimming measures the drawn pixels instead, so
// the mark always fills the padded area regardless of how the SVG is framed.
const logoLayer = await sharp(
  Buffer.from(
    `<svg width="${logoWidth}" height="${logoHeight}" viewBox="0 0 ${logoWidth} ${logoHeight}" xmlns="http://www.w3.org/2000/svg"${logoNamespaces}>${logoMarkup}</svg>`,
  ),
  { density: 72 },
)
  .resize(availableSize, availableSize, { fit: "inside" })
  .trim()
  .png()
  .toBuffer();

const logo = await sharp(logoLayer)
  .resize(availableSize, availableSize, {
    fit: "inside",
    kernel: "nearest",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();
const { width: logoW, height: logoH } = await sharp(logo).metadata();

const background = `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="rounded">
      <rect width="${SIZE}" height="${SIZE}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}"/>
    </clipPath>
  </defs>

  <g clip-path="url(#rounded)">
    <rect width="${SIZE}" height="${SIZE}" fill="#181825"/>
  </g>
</svg>`;

await sharp(Buffer.from(background), { density: 72 })
  .resize(SIZE, SIZE, { kernel: "nearest" })
  .composite([
    {
      input: logo,
      left: Math.round((SIZE - logoW) / 2),
      top: Math.round((SIZE - logoH) / 2),
    },
  ])
  .png()
  .toFile(OUTPUT_PATH);

console.log(`Icon generated: ${OUTPUT_PATH}`);
