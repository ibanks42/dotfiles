import assert from "node:assert/strict";
import { test } from "node:test";
import { accessSync, constants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { target } from "./target.mjs";

const requireFromBridge = createRequire(join(target("pi-claude-bridge"), "package.json"));
const sdkRoot = dirname(requireFromBridge.resolve("@anthropic-ai/claude-agent-sdk"));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function atLeast(actual, minimum) {
  const parts = actual.split(".").map(Number);
  return minimum.some((part, index) => parts.slice(0, index).every((v, i) => v === minimum[i]) && parts[index] > part)
    || minimum.every((part, index) => parts[index] === part);
}

test("installed SDK preserves the former bridge SDK requirement", () => {
  const sdk = readJson(join(sdkRoot, "package.json"));
  assert.ok(atLeast(sdk.version, [0, 3, 284]), `SDK ${sdk.version} is older than 0.3.284`);
  const manifest = readJson(join(sdkRoot, "manifest.json"));
  assert.ok(atLeast(manifest.version, [2, 1, 284]), `Claude CLI ${manifest.version} is older than 2.1.284`);
});

test("the SDK native CLI is present and executable on this Linux host", { skip: process.platform !== "linux" || process.arch !== "x64" }, () => {
  const fromSdk = createRequire(join(sdkRoot, "package.json"));
  const native = fromSdk.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json");
  accessSync(join(dirname(native), "claude"), constants.X_OK);
});
