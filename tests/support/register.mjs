import { registerHooks } from "node:module";
// The plugin uses window.* timers (popout-window safe); in Node, window is the global object.
globalThis.window ??= globalThis;
registerHooks({ resolve(specifier, context, next) { if (specifier === "obsidian") return { url: new URL("./obsidian-stub.ts", import.meta.url).href, shortCircuit: true }; return next(specifier, context); } });
