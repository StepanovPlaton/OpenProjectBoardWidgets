import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const browser = process.argv[2];
if (browser !== "chrome" && browser !== "firefox") {
  console.error("Usage: node scripts/pack-extension.mjs <chrome|firefox>");
  process.exit(1);
}

const sourceDir = resolve(`dist/${browser}`);
const outFile = resolve(`dist/${browser}.zip`);

if (!existsSync(sourceDir)) {
  console.error(`Build folder not found: ${sourceDir}`);
  process.exit(1);
}

const isWin = process.platform === "win32";
let result;

if (isWin) {
  result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `if (Test-Path -LiteralPath '${outFile}') { Remove-Item -LiteralPath '${outFile}' -Force }; Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${outFile}'`,
    ],
    { stdio: "inherit" },
  );
} else {
  result = spawnSync("zip", ["-r", "-q", outFile, "."], {
    cwd: sourceDir,
    stdio: "inherit",
  });
}

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Packed → ${outFile}`);
