# Translating

The interface follows Obsidian's language setting (*Settings → General → Language*).

1. Open `src/i18n.ts`. The `en` catalog is the source of truth.
2. Copy the `zh` block, rename it to your language code (Obsidian's code, for example `de`, `fr`, `ja`, `pt-BR`), and translate the values. Keep `{placeholders}` unchanged.
3. Add it to `catalogs`.
4. Run `npm test`, then open a pull request.

Missing keys fall back to English, so a partial translation is fine.

Translated so far: English (complete) and Simplified Chinese (commands, status panel, notifications). Settings and setup wizard text are English for now; translations are welcome.
