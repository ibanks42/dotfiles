// Child process for the multi-process test: creates/loads the shared key and
// appends records through the real store. Prints the key fingerprint only.
import { createHash } from "node:crypto";
import { appendRecord, loadKey } from "../store.ts";

const key = loadKey(true);
for (let i = 0; i < 60; i++) appendRecord({ v: 1, kind: "marker", at: i, marker: "compaction", seq: i, pad: "0".repeat(64) });
console.log(createHash("sha256").update(key!).digest("hex"));
