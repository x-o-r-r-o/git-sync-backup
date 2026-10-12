# Translating

The interface follows Obsidian's language setting (*Settings → General → Language*). Every screen is translatable: settings, setup wizard, dialogs, status panel and notifications.

1. Copy `src/locales/zh.ts` to `src/locales/<code>.ts`, using Obsidian's language code (for example `de`, `fr`, `ja`, `pt-BR`). `src/locales/en.ts` is the source of truth.
2. Translate the values. Keep every `{placeholder}` exactly as it is; a test checks this.
3. Register the catalog in `src/i18n.ts` (`const catalogs = { zh, de }`).
4. Run `npm test`, then open a pull request.

Missing keys fall back to English, so a partial translation still works.

Available: English and Simplified Chinese (complete).
