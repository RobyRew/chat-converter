import { discordImporter } from '../importers/discord';
import { instagramImporter, messengerImporter } from '../importers/meta';
import { telegramImporter } from '../importers/telegram';
import { whatsappImporter } from '../importers/whatsapp';
import { htmlExporter } from '../exporters/html';
import { jsonExporter } from '../exporters/json';
import { markdownExporter } from '../exporters/markdown';
import { telegramExporter } from '../exporters/telegram';
import { whatsappExporter } from '../exporters/whatsapp';
import { telegramAndroidExporter, telegramIosExporter, whatsappZipExporter } from '../exporters/whatsapp-package';
import { Registry } from './registry';
import { universalchatImporter } from '../importers/universalchat';
import { snapchatImporter } from '../importers/snapchat';
import { vscoImporter } from '../importers/vsco';
import { hingeImporter } from '../importers/hinge';
import { universalchatExporter, universalchatZipExporter } from '../exporters/universalchat';

/** A fresh registry with all built-in plugins. Use for custom setups or isolation. */
export function createRegistry(): Registry {
  const r = new Registry();
  r.registerImporter(whatsappImporter)
    .registerImporter(telegramImporter)
    .registerImporter(instagramImporter)
    .registerImporter(messengerImporter)
    .registerImporter(discordImporter)
    .registerImporter(snapchatImporter)
    .registerImporter(vscoImporter)
    .registerImporter(hingeImporter)
    .registerImporter(universalchatImporter);
  r.registerExporter(telegramExporter)
    .registerExporter(whatsappExporter)
    .registerExporter(htmlExporter)
    .registerExporter(markdownExporter)
    .registerExporter(jsonExporter)
    .registerExporter(whatsappZipExporter)
    .registerExporter(telegramIosExporter)
    .registerExporter(telegramAndroidExporter)
    .registerExporter(universalchatExporter)
    .registerExporter(universalchatZipExporter);
  return r;
}

/** Shared default registry used by `convert()` when no registry is supplied. */
export const defaultRegistry = createRegistry();
