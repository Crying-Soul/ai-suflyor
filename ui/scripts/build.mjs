import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
const common = { bundle: true, sourcemap: true, logLevel: "info" };

await Promise.all([
  build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main.js", platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/main/preload.ts"], outfile: "dist/preload.js", platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/renderer/app.ts"], outfile: "dist/renderer.js", platform: "browser", format: "iife" }),
  build({ ...common, entryPoints: ["src/renderer/settings.ts"], outfile: "dist/settings.js", platform: "browser", format: "iife" }),
]);
cpSync("static", "dist", { recursive: true });
