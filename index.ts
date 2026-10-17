import { Plugin } from "@opencode/plugin"

/**
 * Server-side entrypoint. This plugin is intentionally a no-op on the server;
 * all of its behaviour lives in the terminal UI (`./tui.ts`).
 *
 * Keeping this file lets the package load both as a discovered plugin
 * (`<config>/plugins/<name>/index.ts` + `tui.ts`) and as a package with a
 * `./tui` export.
 */
export default Plugin.define({
  id: "local.sensevoice",
  setup() {},
})
