import { discordImporter } from '../importers/discord';
import { instagramImporter, messengerImporter } from '../importers/meta';
import { telegramImporter } from '../importers/telegram';
import { whatsappImporter } from '../importers/whatsapp';
import { htmlExporter } from '../exporters/html';
import { jsonExporter } from '../exporters/json';
import { markdownExporter } from '../exporters/markdown';
import { telegramExporter } from '../exporters/telegram';
import { whatsappExporter } from '../exporters/whatsapp';
import { Registry } from './registry';

/** A fresh registry with all built-in plugins. Use for custom setups or isolation. */
export function createRegistry(): Registry {
  const r = new Registry();
  r.registerImporter(whatsappImporter)
    .registerImporter(telegramImporter)
    .registerImporter(instagramImporter)
    .registerImporter(messengerImporter)
    .registerImporter(discordImporter);
  r.registerExporter(telegramExporter)
    .registerExporter(whatsappExporter)
    .registerExporter(htmlExporter)
    .registerExporter(markdownExporter)
    .registerExporter(jsonExporter);
  return r;
}

/** Shared default registry used by `convert()` when no registry is supplied. */
export const defaultRegistry = createRegistry();
