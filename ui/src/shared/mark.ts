// The app's mark: a prompter's box, a dome over the stage line, and above it an apricot tally light (on air).
// One geometry for every size: rasterized here for the tray, the window icons and build/icon.ico,
// and drawn as SVG in the window headers. Units: the mark is a 100 x 100 square, y grows down.

const TILE_R = 22;
/** The dome: a half ring standing on the stage line. */
const ARCH = { cx: 50, cy: 68, r: 25, w: 11 };
const STAGE = { x: 15, y: 70, w: 70, h: 9, r: 2.5 };
const TALLY = { cx: 50, cy: 25, r: 7.5 };

/** sRGB of the Dusk tokens (tokens.css): the icon lives outside the themes. */
const COLORS = { tile: [0x23, 0x26, 0x31], arch: [0xa9, 0xb4, 0xf0], stage: [0xf4, 0xf1, 0xec], tally: [0xf2, 0xc0, 0x8f] } as const;

const box = (x: number, y: number, bx: number, by: number, bw: number, bh: number, r: number) => {
  const qx = Math.abs(x - (bx + bw / 2)) - bw / 2 + r;
  const qy = Math.abs(y - (by + bh / 2)) - bh / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

/** Signed distances (mark units) to each part, negative inside. */
function parts(x: number, y: number, tile: boolean): [readonly number[], number][] {
  const ring = Math.abs(Math.hypot(x - ARCH.cx, y - ARCH.cy) - ARCH.r) - ARCH.w / 2;
  const out: [readonly number[], number][] = [
    [COLORS.arch, Math.max(ring, y - ARCH.cy)],
    [COLORS.stage, box(x, y, STAGE.x, STAGE.y, STAGE.w, STAGE.h, STAGE.r)],
    [COLORS.tally, Math.hypot(x - TALLY.cx, y - TALLY.cy) - TALLY.r],
  ];
  return tile ? [[COLORS.tile, box(x, y, 0, 0, 100, 100, TILE_R)], ...out] : out;
}

/** The mark as straight RGBA pixels, `size` x `size`, antialiased over one pixel. */
export function rasterize(size: number, tile = true): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const unit = 100 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) * unit;
      const y = (j + 0.5) * unit;
      let [r, g, b, a] = [0, 0, 0, 0];
      for (const [c, d] of parts(x, y, tile)) {
        const k = Math.max(0, Math.min(1, 0.5 - d / unit));
        if (!k) continue;
        // "Over" in premultiplied terms, kept straight in the buffer.
        const na = k + a * (1 - k);
        r = (c[0] * k + r * a * (1 - k)) / na;
        g = (c[1] * k + g * a * (1 - k)) / na;
        b = (c[2] * k + b * a * (1 - k)) / na;
        a = na;
      }
      const o = (j * size + i) * 4;
      px.set([Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)], o);
    }
  }
  return px;
}

/** The mark as SVG for the pages; its colors come from the theme through the classes in base.css. */
export const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="mark" aria-hidden="true">
<rect class="mark-tile" width="100" height="100" rx="${TILE_R}"/>
<path class="mark-arch" fill="none" stroke-width="${ARCH.w}" d="M${ARCH.cx - ARCH.r} ${ARCH.cy}A${ARCH.r} ${ARCH.r} 0 0 1 ${ARCH.cx + ARCH.r} ${ARCH.cy}"/>
<rect class="mark-stage" x="${STAGE.x}" y="${STAGE.y}" width="${STAGE.w}" height="${STAGE.h}" rx="${STAGE.r}"/>
<circle class="mark-tally" cx="${TALLY.cx}" cy="${TALLY.cy}" r="${TALLY.r}"/>
</svg>`;
