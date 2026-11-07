import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

// Start clean so files of removed pages do not linger in dist.
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
// --dist (the installer): minified, no source maps.
const dist = process.argv.includes("--dist");
const common = { bundle: true, sourcemap: !dist, minify: dist, logLevel: "info" };

await Promise.all([
  build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main.js", platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/main/preload.ts"], outfile: "dist/preload.js", platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/renderer/transcript.ts"], outfile: "dist/transcript.js", platform: "browser", format: "iife" }),
  build({ ...common, entryPoints: ["src/renderer/hints.ts"], outfile: "dist/hints.js", platform: "browser", format: "iife" }),
  build({ ...common, entryPoints: ["src/renderer/settings.ts"], outfile: "dist/settings.js", platform: "browser", format: "iife" }),
  build({ ...common, entryPoints: ["src/renderer/calls.ts"], outfile: "dist/calls.js", platform: "browser", format: "iife" }),
  build({ ...common, entryPoints: ["src/renderer/ready.ts"], outfile: "dist/ready.js", platform: "browser", format: "iife" }),
]);
cpSync("static", "dist", { recursive: true });
