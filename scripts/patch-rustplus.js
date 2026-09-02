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
