// Obsidian's official review rules (eslint-plugin-obsidianmd), plus type-checked TypeScript rules.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/**", "tests/**", "test-vault/**", "esbuild.config.mjs", "eslint.config.mjs"] },
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.*"] },
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
