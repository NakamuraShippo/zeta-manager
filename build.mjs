import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: false,
  logLevel: "info",
  loader: { ".css": "text" },
};

const extensionEntries = [
  { entryPoints: ["src/content/content.ts"], outfile: "dist/content.js" },
  { entryPoints: ["src/background/service-worker.ts"], outfile: "dist/service-worker.js" },
  { entryPoints: ["src/options/options.ts"], outfile: "dist/options.js" },
];

const userscriptBanner = `// ==UserScript==
// @name         Zeta Log Companion Mobile
// @namespace    zeta-log-companion
// @version      ${manifest.version}
// @description  Zeta の会話ログを取得・自動保存し、統合テキストをコピーできる浮動パネル（モバイル向け）
// @match        https://zeta-ai.io/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
`;

const mobileUserscript = {
  entryPoints: ["src/mobile/mobile-main.ts"],
  outfile: "dist-mobile/zeta-log-companion.user.js",
  target: "safari16",
  banner: { js: userscriptBanner },
};

function copyStatic() {
  mkdirSync("dist", { recursive: true });
  mkdirSync("dist-mobile", { recursive: true });
  cpSync("manifest.json", "dist/manifest.json");
  cpSync("src/options/options.html", "dist/options.html");
}

async function buildBookmarklet() {
  const result = await esbuild.build({
    ...common,
    entryPoints: ["src/mobile/mobile-main.ts"],
    target: "safari16",
    minify: true,
    write: false,
    outfile: "bookmarklet.js",
  });
  const code = result.outputFiles[0].text.trim();
  writeFileSync(
    "dist-mobile/bookmarklet.txt",
    "javascript:" + encodeURIComponent(code),
  );
  console.log(
    `bookmarklet: dist-mobile/bookmarklet.txt (${(code.length / 1024).toFixed(1)}kb)`,
  );
}

copyStatic();

if (watch) {
  const contexts = await Promise.all(
    [...extensionEntries, mobileUserscript].map((e) =>
      esbuild.context({ ...common, ...e }),
    ),
  );
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("watching...");
} else {
  await Promise.all(
    [...extensionEntries, mobileUserscript].map((e) =>
      esbuild.build({ ...common, ...e }),
    ),
  );
  await buildBookmarklet();
  console.log("build complete: dist/ , dist-mobile/");
}
