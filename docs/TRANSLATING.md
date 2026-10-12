# Translating

The interface follows Obsidian's language setting (*Settings → General → Language*). Every screen is translatable: settings, setup wizard, dialogs, status panel and notifications.

1. Copy `src/locales/zh.ts` to `src/locales/<code>.ts`, using Obsidian's language code (for example `it`, `ru`, `zh-tw`, lower case). `src/locales/en.ts` is the source of truth.
2. Translate the values. Keep every `{placeholder}` exactly as it is; a test checks this.
3. Register the catalog in `src/i18n.ts` (`const catalogs = { zh, de, … }`).
4. Run `npm test`, then open a pull request.

Missing keys fall back to English, so a partial translation still works.

Available (all complete): English, Simplified Chinese (`zh`), German (`de`), Spanish (`es`), French (`fr`), Japanese (`ja`), Korean (`ko`) and Brazilian Portuguese (`pt`). German, Spanish, French, Japanese, Korean and Portuguese were machine-assisted in 1.2.0; corrections from native speakers are very welcome. A catalog is looked up by the full language code first, then by its first part, so `pt-BR` uses `pt` and `zh-TW` falls back to `zh`.

`npm test` checks that every catalog has every key with the same `{placeholders}`.
