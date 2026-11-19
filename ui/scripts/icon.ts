// Writes build/icon.ico (the exe, installer and taskbar icon) and build/icon.png from src/shared/mark.ts.
// Run: npm run icon. The files are committed: a packaged build does not need to run this.
import fs from "node:fs";
import path from "node:path";
import { rasterize } from "../src/shared/mark.ts";
import { ico, png } from "../src/shared/png.ts";

const dir = path.resolve(import.meta.dirname, "../build");
fs.mkdirSync(dir, { recursive: true });
const images = [16, 20, 24, 32, 40, 48, 64, 128, 256].map((size) => ({ size, png: png(rasterize(size), size) }));
fs.writeFileSync(path.join(dir, "icon.ico"), ico(images));
fs.writeFileSync(path.join(dir, "icon.png"), images.at(-1)!.png);
console.log(`build/icon.ico: ${images.map((i) => i.size).join(", ")} px`);
