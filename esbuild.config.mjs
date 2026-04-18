import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";
// 调试模式：生产构建也保留源码 + sourcemap，便于在 Obsidian 控制台定位问题
// 用 `npm run build -- --debug` 或设置 MECE_DEBUG=1 开启
const debug = process.argv.includes("--debug") || process.env.MECE_DEBUG === "1";

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
  // 非生产 或 debug 模式：带 sourcemap
  // debug 模式用 linked（生成独立 main.js.map），Obsidian DevTools Sources 面板会自动加载
  // dev 模式用 inline，便于热重载
  sourcemap: debug ? "linked" : (!prod ? "inline" : false),
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
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
