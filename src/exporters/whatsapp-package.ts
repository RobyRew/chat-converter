import type { CapabilityMatrix, Conversation, ExportFormatId } from '../model';
import type { Exporter, ExportOptions, PackageContext, PackageSummary } from '../engine/contracts';
import { strToU8 } from '../engine/zip';
import { archiveName, buildWhatsAppChat, type WhatsAppChat, type WhatsAppFlavor } from './whatsapp-format';

/** Telegram-Android rejects a history file above 32 MiB (SendMessagesHelper.java, `32 * 1024 * 1024`). */
export const ANDROID_MAX_HISTORY_BYTES = 32 * 1024 * 1024;

const caps: CapabilityMatrix = {
  timestamps: true,
  richText: true,
  media: true,
  mediaCaptions: true,
  stickers: true,
  polls: true,
  contacts: true,
  location: true,
  groups: true,
  multipleParticipants: true,
};

// WhatsApp's export has *bold*, _italic_, ~strike~ and ```mono``` but no underline, spoiler, links or
// mentions; calls and service events become text lines; checklists become text.
const approximates: CapabilityMatrix = { entities: true, calls: true, timezone: true };

interface Profile {
  format: ExportFormatId;
  flavor: WhatsAppFlavor;
  /** `_chat.txt` first: Telegram-iOS takes the first entry matching `_chat\.txt`, Android the first `.txt`. */
  chatFirst: boolean;
  android: boolean;
}

function summarize(conv: Conversation, chat: WhatsAppChat, entries: string[]): PackageSummary {
  return {
    suggestedName: archiveName(chat.title),
    messagesIn: conv.messages.length,
    messagesOut: chat.messagesOut,
    mediaWritten: chat.media.length,
    mediaOmitted: chat.mediaOmitted,
    entries,
    dropped: chat.dropped,
    approximated: chat.approximated,
  };
}

function build(conv: Conversation, profile: Profile, opts: ExportOptions | undefined, ctx: { media: PackageContext['media'] }): WhatsAppChat {
  return buildWhatsAppChat(conv, {
    ...opts?.whatsapp,
    flavor: profile.flavor,
    includeMedia: true,
    media: ctx.media,
    ...(opts?.title ? { title: opts.title } : {}),
  });
}

function createPackageExporter(profile: Profile): Exporter {
  return {
    format: profile.format,
    capabilities: caps,
    approximates,
    async serialize(conv, ctx, opts) {
      // In memory: the chat text alone (previews, and callers without a file to stream to).
      const chat = build(conv, profile, opts, ctx);
      return {
        files: [{ name: '_chat.txt', bytes: strToU8(chat.text) }],
        suggestedName: archiveName(chat.title),
        mime: 'text/plain',
      };
    },
    async write(conv, ctx, opts) {
      const chat = build(conv, profile, opts, ctx);
      const txt = strToU8(chat.text);
      const last = conv.messages.at(-1);
      const lastModified = new Date(last ? last.ts + (last.tzOffsetMinutes ?? 0) * 60000 : 0);
      if (profile.android) {
        ctx.warn('Telegram for Android imports only the chat text from a zip; the media inside is not uploaded.');
        if (txt.byteLength > ANDROID_MAX_HISTORY_BYTES) {
          ctx.warn(`_chat.txt is ${txt.byteLength} bytes; Telegram for Android refuses history files above 32 MiB.`);
        }
      }
      for (const w of chat.warnings) ctx.warn(w);

      const writeMedia = async (): Promise<void> => {
        for (const m of chat.media) {
          if (m.bytes) {
            await ctx.sink.addBytes(m.name, m.bytes, { level: 6, lastModified: m.lastModified });
            continue;
          }
          const file = m.ref ? ctx.media.get(m.ref) : undefined;
          if (!file) throw new Error(`Media file disappeared while writing: ${m.ref ?? m.name}`);
          await ctx.sink.addFile(m.name, file, { level: 0, lastModified: m.lastModified });
        }
      };
      if (profile.chatFirst) {
        await ctx.sink.addBytes('_chat.txt', txt, { level: 6, lastModified });
        await writeMedia();
      } else {
        await writeMedia();
        await ctx.sink.addBytes('_chat.txt', txt, { level: 6, lastModified });
      }
      return summarize(conv, chat, ctx.sink.entries.map((e) => e.name));
    },
  };
}

/** WhatsApp's own export layout (media first, `_chat.txt` last, `-GIF-` names). */
export const whatsappZipExporter = createPackageExporter({
  format: 'whatsapp-zip',
  flavor: 'whatsapp',
  chatFirst: false,
  android: false,
});

/** The package Telegram for iPhone/iPad imports, media included. */
export const telegramIosExporter = createPackageExporter({
  format: 'telegram-ios',
  flavor: 'telegram',
  chatFirst: true,
  android: false,
});

/** The same package for Telegram for Android, which imports the text only. */
export const telegramAndroidExporter = createPackageExporter({
  format: 'telegram-android',
  flavor: 'telegram',
  chatFirst: true,
  android: true,
});
