import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const sourceTests = (await readdir("tests"))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `.test-dist/tests/${name.slice(0, -3)}.js`);
const browserTests = [
  "tests/auth-ui.test.mjs",
  "tests/invitation-edge.test.mjs",
  "tests/task-photos-ui.test.mjs",
];
const result = spawnSync(process.execPath, ["--test", ...sourceTests, ...browserTests], { stdio: "inherit" });
process.exit(result.status ?? 1);
