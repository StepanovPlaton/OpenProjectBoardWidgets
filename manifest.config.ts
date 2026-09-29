import { defineManifest } from "@crxjs/vite-plugin";

const isFirefox = process.env.BROWSER === "firefox";

export default defineManifest({
  manifest_version: 3,
  name: "OpenProject Board Widgets",
  description: "Adds informative widgets to OpenProject board cards via the REST API.",
  version: "0.1.3",
  action: {
    default_popup: "src/popup/index.html",
    default_title: "OpenProject Board Widgets",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  permissions: ["storage"],
  host_permissions: ["http://*/*", "https://*/*"],
  content_scripts: [
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["src/content/index.ts"],
      css: ["src/content/styles.css"],
      run_at: "document_idle",
    },
  ],
  ...(isFirefox
    ? {
        browser_specific_settings: {
          gecko: {
            id: "@openproject-board-widgets",
            strict_min_version: "140.0",
            data_collection_permissions: {
              // API token + OpenProject REST; content scripts read board DOM.
              required: ["authenticationInfo", "websiteContent"],
            },
          },
        },
      }
    : {}),
});
