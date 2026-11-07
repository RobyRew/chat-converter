import type { CapabilityMatrix } from '../model';
import type { Exporter } from '../engine/contracts';
import { slug } from '../engine/format';
import { strToU8 } from '../engine/zip';
import { buildWhatsAppChat } from './whatsapp-format';

/**
 * `whatsapp-txt`: the chat text alone, in WhatsApp's byte format (see `whatsapp-format.ts`). Media is
 * referenced only where a WhatsApp export already named it; everything else becomes WhatsApp's
 * "omitted" marker, as in an export made without media. For text plus media, use `whatsapp-zip`.
 */
const caps: CapabilityMatrix = {
  timestamps: true,
  richText: true,
  media: true,
  mediaCaptions: true,
  multipleParticipants: true,
  groups: true,
};

// *bold* / _italic_ / ~strike~ / ```mono``` survive; underline, spoiler, links and mentions do not.
const approximates: CapabilityMatrix = { entities: true };

export const whatsappExporter: Exporter = {
  format: 'whatsapp-txt',
  capabilities: caps,
  approximates,
  async serialize(conv, ctx, opts) {
    const chat = buildWhatsAppChat(conv, {
      // A bare text file is not an import package: no notice line unless asked for.
      noticeLine: false,
      ...opts?.whatsapp,
      flavor: 'whatsapp',
      includeMedia: false,
      media: ctx.media,
      ...(opts?.title ? { title: opts.title } : {}),
    });
    const title = opts?.title ?? conv.title;
    return {
      files: [{ name: '_chat.txt', bytes: strToU8(chat.text) }],
      suggestedName: `${slug(title)}.whatsapp.txt`,
      mime: 'text/plain',
    };
  },
};
