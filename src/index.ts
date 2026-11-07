// Canonical model (zod schemas + types)
export * from './model/index';

// Lazy inputs (folders, zips, in-memory files) and streaming archive output
export * from './sources/index';
export * from './sinks/index';

// Engine primitives
export * from './engine/contracts';
export * from './engine/registry';
export * from './engine/pipeline';
export * from './engine/fidelity';
export * from './engine/media';
export * from './engine/ids';
export * from './engine/zip';
export * from './engine/richtext';
export * from './engine/format';
export * from './engine/transforms';
export * from './engine/time';
export * from './worker/types';
export { createRegistry, defaultRegistry } from './engine/builtins';

// Built-in plugin instances (for custom registries / advanced consumers)
export { whatsappImporter } from './importers/whatsapp';
export { telegramImporter, parseTelegramJson } from './importers/telegram';
export { parseTelegramHtml, findHtmlPages } from './importers/telegram-html';
export { DELETED_ACCOUNT } from './importers/telegram-common';
export { instagramImporter, messengerImporter } from './importers/meta';
export { discordImporter } from './importers/discord';
export { telegramExporter } from './exporters/telegram';
export { whatsappExporter } from './exporters/whatsapp';
export { htmlExporter } from './exporters/html';
export { markdownExporter } from './exporters/markdown';
export { jsonExporter } from './exporters/json';
