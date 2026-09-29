import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve("dist/firefox/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

manifest.browser_specific_settings = {
  gecko: {
    id: "@openproject-board-widgets",
    strict_min_version: "140.0",
    data_collection_permissions: {
      // API token + OpenProject REST; content scripts read board DOM.
      required: ["authenticationInfo", "websiteContent"],
    },
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
