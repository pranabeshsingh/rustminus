#!/usr/bin/env node
/**
 * Automatically applies modern Protobuf and async/await patches
 * to @liamcottle/rustplus.js after npm install.
 */
const fs = require("fs");
const path = require("path");

const targetDir = path.join(__dirname, "..", "node_modules", "@liamcottle", "rustplus.js");
const patchDir = path.join(__dirname, "..", "patches", "rustplus.js");

if (!fs.existsSync(targetDir)) {
  console.log("[Patch] @liamcottle/rustplus.js is not installed in node_modules yet, skipping.");
  process.exit(0);
}

try {
  const jsSource = path.join(patchDir, "rustplus.js");
  const jsDest = path.join(targetDir, "rustplus.js");
  if (fs.existsSync(jsSource)) {
    fs.copyFileSync(jsSource, jsDest);
    console.log("[Patch] Successfully updated @liamcottle/rustplus.js with async/await & connection state checks.");
  }

  const protoSource = path.join(patchDir, "rustplus.proto");
  const protoDest = path.join(targetDir, "rustplus.proto");
  if (fs.existsSync(protoSource)) {
    fs.copyFileSync(protoSource, protoDest);
    console.log("[Patch] Successfully updated @liamcottle/rustplus.js with modern Facepunch protobuf schema.");
  }
} catch (err) {
  console.error("[Patch] Failed to patch @liamcottle/rustplus.js:", err.message);
}

// Ensure uuid backwards-compatibility shims for legacy modules requiring 'uuid/v4' or 'uuid/v1'
function patchUuidInDir(dir) {
  if (!fs.existsSync(dir)) return;
  const pkgJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    if (pkg.name !== "uuid") return;

    // Create v4.cjs and v1.cjs shims for CommonJS compatibility
    const v4CjsPath = path.join(dir, "v4.cjs");
    const v1CjsPath = path.join(dir, "v1.cjs");
    const cjsV4 = fs.existsSync(path.join(dir, "dist", "cjs", "v4.js"))
      ? "const fn = require('./dist/cjs/v4.js'); module.exports = fn.default || fn;\n"
      : "const uuid = require('./'); module.exports = typeof uuid.v4 === 'function' ? uuid.v4 : uuid;\n";
    const cjsV1 = fs.existsSync(path.join(dir, "dist", "cjs", "v1.js"))
      ? "const fn = require('./dist/cjs/v1.js'); module.exports = fn.default || fn;\n"
      : "const uuid = require('./'); module.exports = typeof uuid.v1 === 'function' ? uuid.v1 : uuid;\n";
    fs.writeFileSync(v4CjsPath, cjsV4);
    fs.writeFileSync(v1CjsPath, cjsV1);

    if (pkg.exports && typeof pkg.exports === "object") {
      let changed = false;
      const v4Export = {
        require: "./v4.cjs",
        import: fs.existsSync(path.join(dir, "dist", "esm", "v4.js")) ? "./dist/esm/v4.js" : "./v4.cjs",
        default: "./v4.cjs"
      };
      const v1Export = {
        require: "./v1.cjs",
        import: fs.existsSync(path.join(dir, "dist", "esm", "v1.js")) ? "./dist/esm/v1.js" : "./v1.cjs",
        default: "./v1.cjs"
      };
      if (JSON.stringify(pkg.exports["./v4"]) !== JSON.stringify(v4Export)) {
        pkg.exports["./v4"] = v4Export;
        changed = true;
      }
      if (JSON.stringify(pkg.exports["./v1"]) !== JSON.stringify(v1Export)) {
        pkg.exports["./v1"] = v1Export;
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
      }
    }
    console.log(`[Patch] Ensured legacy compatibility shims in ${dir}`);
  } catch (err) {
    console.error(`[Patch] Failed to patch uuid at ${dir}:`, err.message);
  }
}

const rootUuidDir = path.join(__dirname, "..", "node_modules", "uuid");
patchUuidInDir(rootUuidDir);
const pushReceiverUuidDir = path.join(__dirname, "..", "node_modules", "@liamcottle", "push-receiver", "node_modules", "uuid");
patchUuidInDir(pushReceiverUuidDir);
const requestUuidDir = path.join(__dirname, "..", "node_modules", "request", "node_modules", "uuid");
patchUuidInDir(requestUuidDir);

