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
  // Compress-Archive writes backslashes in entry names; AMO rejects those paths.
  const psScript = [
    "Add-Type -AssemblyName System.IO.Compression",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$sourceDir = '${sourceDir.replace(/'/g, "''")}'`,
    `$outFile = '${outFile.replace(/'/g, "''")}'`,
    "if (Test-Path -LiteralPath $outFile) { Remove-Item -LiteralPath $outFile -Force }",
    "$zip = [System.IO.Compression.ZipFile]::Open($outFile, [System.IO.Compression.ZipArchiveMode]::Create)",
    "Get-ChildItem -LiteralPath $sourceDir -Recurse -File | ForEach-Object {",
    "  $rel = $_.FullName.Substring($sourceDir.Length + 1).Replace([char]92, [char]47)",
    "  [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel)",
    "}",
    "$zip.Dispose()",
  ].join("; ");
  result = spawnSync("powershell", ["-NoProfile", "-Command", psScript], {
    stdio: "inherit",
  });
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
