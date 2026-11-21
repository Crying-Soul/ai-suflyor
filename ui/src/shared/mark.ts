// The app's mark, «Опережение» (docs/brand/v2): a disc and a ring that steps out of it, one beat ahead.
// One geometry for every size: rasterized here for the tray, the window icons and build/icon.ico,
// and drawn as SVG in the window headers. Units: the mark is a 100 x 100 square, y grows down.

const TILE_R = 23;
/** The disc, with a gap cut around the ring so the two never touch. */
const DISC = { cx: 36, cy: 50, r: 24 };
const GAP = { cx: 62, cy: 50, r: 33 };
/** The ring: centre-line radius and stroke width. */
const RING = { cx: 62, cy: 50, r: 22, w: 9 };

/** Brand colours, outside the themes: ink tile, paper disc, cinnabar ring. */
const COLORS = { tile: [0x11, 0x11, 0x13], disc: [0xf1, 0xef, 0xea], ring: [0xe5, 0x48, 0x2b] } as const;

const box = (x: number, y: number, bx: number, by: number, bw: number, bh: number, r: number) => {
  const qx = Math.abs(x - (bx + bw / 2)) - bw / 2 + r;
  const qy = Math.abs(y - (by + bh / 2)) - bh / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

/** Signed distances (mark units) to each part, negative inside. */
function parts(x: number, y: number, tile: boolean): [readonly number[], number][] {
  const disc = Math.max(Math.hypot(x - DISC.cx, y - DISC.cy) - DISC.r, GAP.r - Math.hypot(x - GAP.cx, y - GAP.cy));
  const ring = Math.abs(Math.hypot(x - RING.cx, y - RING.cy) - RING.r) - RING.w / 2;
  const out: [readonly number[], number][] = [[COLORS.disc, disc], [COLORS.ring, ring]];
  return tile ? [[COLORS.tile, box(x, y, 0, 0, 100, 100, TILE_R)], ...out] : out;
}

/** Where the disc's outline meets the gap circle: the two tips of the crescent. */
const TIP = (() => {
  const d = GAP.cx - DISC.cx;
  const x = (d * d + DISC.r * DISC.r - GAP.r * GAP.r) / (2 * d);
  return { x: +(DISC.cx + x).toFixed(2), dy: +Math.sqrt(DISC.r * DISC.r - x * x).toFixed(2) };
})();

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

/** The mark as SVG for the pages: no tile, one colour, the theme's text colour (currentColor). */
export const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" class="mark" aria-hidden="true">
<path fill="currentColor" d="M${TIP.x} ${DISC.cy - TIP.dy}A${DISC.r} ${DISC.r} 0 1 0 ${TIP.x} ${DISC.cy + TIP.dy}A${GAP.r} ${GAP.r} 0 0 1 ${TIP.x} ${DISC.cy - TIP.dy}Z"/>
<circle fill="none" stroke="currentColor" stroke-width="${RING.w}" cx="${RING.cx}" cy="${RING.cy}" r="${RING.r}"/>
</svg>`;
