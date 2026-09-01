// lib/identicon.ts — GitHub-style identicons as SVG data URIs.

/** Simple deterministic string hash (djb2). */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * 5x5 vertically-symmetric pixel grid, colored from the hash.
 * Returns a data: URI usable directly in <img src>.
 */
export function identicon(seed: string, size = 64): string {
  const h = hash(seed);
  // background: very dark gray; foreground: hue derived from hash
  const hue = h % 360;
  const fg = `hsl(${hue} 55% 55%)`;
  const bg = "rgba(0,0,0,0)";
  const cells: string[] = [];
  // 5x5 grid, mirror left 3 columns to the right
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const bit = (hash(`${seed}:${x}:${y}`) >>> 1) & 1;
      if (bit) {
        cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
        if (x < 4 - x) cells.push(`<rect x="${4 - x}" y="${y}" width="1" height="1"/>`);
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" width="${size}" height="${size}"><rect width="5" height="5" fill="${bg}"/><g fill="${fg}">${cells.join("")}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
