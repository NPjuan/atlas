import esbuild from "esbuild";
import process from "process";
import { copyFile, stat, mkdir } from "fs/promises";
import { watch as fsWatch } from "fs";
import path from "path";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";
// 调试模式：生产构建也保留源码 + sourcemap，便于在 Obsidian 控制台定位问题
const debug = process.argv.includes("--debug") || process.env.MECE_DEBUG === "1";

// test-vault 里的插件目录，dev 模式下自动同步产物
// 注意：目录名必须和 manifest.json 里的 id 一致（Obsidian 按目录名加载插件）
const PLUGIN_TARGET = path.resolve("test-vault/.obsidian/plugins/atlas-knowledge");

async function syncToPlugin() {
  try {
    await stat(PLUGIN_TARGET);
  } catch {
    await mkdir(PLUGIN_TARGET, { recursive: true });
  }
  const files = ["main.js", "main.js.map", "styles.css", "manifest.json"];
  let synced = 0;
  for (const f of files) {
    try {
      await copyFile(f, path.join(PLUGIN_TARGET, f));
      synced++;
    } catch (e) {
      if (f !== "main.js.map") {
        console.warn(`[sync] skip ${f}: ${e.message}`);
      }
    }
  }
  console.log(`[sync] ${synced} files → ${PLUGIN_TARGET}`);
}

/** esbuild 插件：每次编译完把产物同步到 Obsidian 插件目录 */
const syncToPluginPlugin = {
  name: "mece-sync-to-plugin",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      await syncToPlugin();
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  // dev / debug 都用 linked sourcemap：生成独立 main.js.map
  sourcemap: prod && !debug ? false : "linked",
  treeShaking: true,
  outfile: "main.js",
  // 只有在真正的 release 生产构建下才压缩
  minify: prod && !debug,
  // 即使压缩，也保留变量/函数名，方便栈追踪定位
  keepNames: true,
  jsx: "automatic",
  jsxImportSource: "react",
  loader: {
    ".ts": "ts",
    ".tsx": "tsx",
  },
  // 只在非 production 模式下自动同步到插件目录
  plugins: prod ? [] : [syncToPluginPlugin],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
  console.log("[esbuild] watching src/… (Ctrl+C to stop)");

  // 额外监听 styles.css / manifest.json —— esbuild 不会监听它们，单独起 fs.watch
  let syncTimer = null;
  const debouncedSync = () => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      await syncToPlugin();
    }, 100);
  };
  for (const f of ["styles.css", "manifest.json"]) {
    try {
      fsWatch(f, () => debouncedSync());
    } catch (e) {
      console.warn(`[watch] cannot watch ${f}: ${e.message}`);
    }
  }
  console.log("[esbuild] also watching styles.css / manifest.json");
}
