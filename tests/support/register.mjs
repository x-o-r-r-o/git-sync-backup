import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) { if (specifier === "obsidian") return { url: new URL("./obsidian-stub.ts", import.meta.url).href, shortCircuit: true }; return next(specifier, context); } });
