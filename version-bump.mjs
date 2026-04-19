/**
 * 一键升版本：同步 manifest.json / package.json / versions.json
 *
 * 用法：node version-bump.mjs <new-version>
 *   如：node version-bump.mjs 0.2.0
 *
 * - manifest.json 的 version 改为新版本
 * - package.json 的 version 改为新版本
 * - versions.json 追加 { [新版本]: manifest.minAppVersion }
 */
import fs from "fs";

const target = process.argv[2];
if (!target || !/^\d+\.\d+\.\d+/.test(target)) {
  console.error("用法: node version-bump.mjs <version>   (如 0.2.0)");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf-8"));
const oldVersion = manifest.version;
const minApp = manifest.minAppVersion;
manifest.version = target;
fs.writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
pkg.version = target;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

const versions = JSON.parse(fs.readFileSync("versions.json", "utf-8"));
versions[target] = minApp;
fs.writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`✅ bumped ${oldVersion} → ${target} (minAppVersion: ${minApp})`);
console.log("");
console.log("后续步骤：");
console.log("  1. npm run build");
console.log(`  2. git commit -am 'Release ${target}'`);
console.log(`  3. git tag ${target}`);
console.log(`  4. git push && git push --tags`);
console.log("  5. 在 GitHub Release 页面上传 main.js / manifest.json / styles.css");
