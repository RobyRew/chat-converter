import type { ExportFormatId } from '../model';

/**
 * Where a converted chat can be imported, and how. Each entry states what the target's own code or
 * documentation shows; the permalinks pin the source revision that was read. `docs/import-targets.md`
 * explains each row in prose and adds the apps that have no import feature at all.
 */
export interface SourceLink {
  label: string;
  url: string;
}

export interface ImportTarget {
  /** The export format to produce for this target. */
  format: ExportFormatId;
  app: string;
  client: string;
  /** What the app accepts as an import. */
  accepts: string;
  carriesText: boolean;
  carriesMedia: boolean;
  /** Steps a person follows to import the produced file. */
  steps: string[];
  /** Limits and requirements the target enforces. */
  limits: string[];
  sources: SourceLink[];
}

const IOS = 'https://github.com/TelegramMessenger/Telegram-iOS/blob/24638bc69bd083981b178dd1e7f921eebbf7fc46';
const ANDROID = 'https://github.com/DrKLO/Telegram/blob/3de37c8cfb039452be7398909461da6288babf15';

export const IMPORT_TARGETS: readonly ImportTarget[] = [
  {
    format: 'telegram-ios',
    app: 'Telegram',
    client: 'iPhone & iPad',
    accepts:
      'One .zip shared to Telegram. The first entry whose name contains "_chat.txt" is the chat; every other non-empty entry is uploaded as media and typed by its name (.jpg photo, NNN-VIDEO-….mp4 video, NNN-STICKER-….webp sticker, NNN-AUDIO-….opus voice, anything else a file).',
    carriesText: true,
    carriesMedia: true,
    steps: [
      'Move the .zip to the iPhone or iPad (AirDrop, iCloud Drive, or the Files app).',
      'In Files, long-press the .zip, choose Share, then Telegram.',
      'Pick the chat to import into: a private chat with a mutual contact, a group where you are an admin who can change group info, or a new group.',
      'Confirm, and keep Telegram open until the import reports that it finished.',
    ],
    limits: [
      'Private chats: only with mutual contacts.',
      'Groups: you must be an admin who can change group info; a basic group is converted to a supergroup first.',
      'One import per chat at a time; Telegram asks you to wait a number of minutes before the next one.',
      'There is a daily maximum ("Daily maximum reached, please come back tomorrow").',
      'If any single media upload fails the whole import stops; Retry starts it again from the beginning.',
      'Imported messages keep their original dates and are marked as imported; everyone in the chat sees them.',
    ],
    sources: [
      { label: 'Share extension: zip detection and media typing', url: `${IOS}/submodules/TelegramUI/Components/ShareExtensionContext/Sources/ShareExtensionContext.swift#L652-L797` },
      { label: 'Import screen: uploads, file names, concurrency', url: `${IOS}/submodules/ChatImportUI/Sources/ChatImportActivityScreen.swift#L137-L290` },
      { label: 'Import API calls and errors', url: `${IOS}/submodules/TelegramCore/Sources/TelegramEngine/HistoryImport/TelegramEngineHistoryImport.swift#L41-L260` },
      { label: 'MTProto import flow', url: 'https://core.telegram.org/api/import' },
    ],
  },
  {
    format: 'telegram-android',
    app: 'Telegram',
    client: 'Android',
    accepts:
      'A file shared to Telegram whose name contains "WhatsApp" and ends in .zip or .txt (or WhatsApp/LINE/KakaoTalk shares). From a zip only the first .txt entry is read; the media inside a zip is not uploaded.',
    carriesText: true,
    carriesMedia: false,
    steps: [
      'Copy the .zip to the phone, keeping "WhatsApp" in its name.',
      'In a file manager, share the .zip to Telegram.',
      'Pick the chat to import into (same rules as on iPhone) and confirm.',
    ],
    limits: [
      'Only the chat text is imported from a zip; for photos, videos and voice notes import on an iPhone or iPad.',
      'The chat text must be 32 MiB or smaller.',
      'Private chats only with mutual contacts; groups need admin rights to change group info.',
      'One import per chat at a time, and a daily maximum.',
    ],
    sources: [
      { label: 'Share detection and the 100-line header', url: `${ANDROID}/TMessagesProj/src/main/java/org/telegram/ui/LaunchActivity.java#L3672-L3792` },
      { label: 'Upload, 32 MiB limit, MIME types', url: `${ANDROID}/TMessagesProj/src/main/java/org/telegram/messenger/SendMessagesHelper.java#L9175-L9285` },
      { label: 'Default share patterns', url: `${ANDROID}/TMessagesProj/src/main/java/org/telegram/messenger/MessagesController.java#L1860-L1886` },
    ],
  },
  {
    format: 'whatsapp-zip',
    app: 'WhatsApp format',
    client: 'any reader',
    accepts:
      "The layout WhatsApp itself exports (media first, _chat.txt last). WhatsApp cannot import it back; ChatForge, Telegram and other tools read it.",
    carriesText: true,
    carriesMedia: true,
    steps: ['Keep it as an archive, or open it with any tool that reads WhatsApp exports (ChatForge included).'],
    limits: ['WhatsApp has no feature to import a chat from a file.'],
    sources: [],
  },
];

export function importTarget(format: ExportFormatId): ImportTarget | undefined {
  return IMPORT_TARGETS.find((t) => t.format === format);
}
