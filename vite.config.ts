import { defineConfig } from "vite";

// base is "/holler/" for the eventual benbeaver.dev/holler/ deploy (§4, §14 M5).
// switch to "/" if you serve it from its own subdomain instead.
export default defineConfig({
  base: "/holler/",
  build: {
    target: "es2022",
  },
});
