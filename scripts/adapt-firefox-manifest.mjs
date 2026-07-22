import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve("dist/firefox/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

manifest.browser_specific_settings = {
  gecko: {
    id: "op-board-widgets@stepanovplaton",
    strict_min_version: "128.0",
  },
};

if (manifest.background?.service_worker) {
  const worker = manifest.background.service_worker;
  manifest.background = {
    scripts: [worker],
    type: "module",
  };
}

if (Array.isArray(manifest.web_accessible_resources)) {
  for (const entry of manifest.web_accessible_resources) {
    if ("use_dynamic_url" in entry) {
      delete entry.use_dynamic_url;
    }
  }
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log("Firefox manifest adapted:", manifestPath);
