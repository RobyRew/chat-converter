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

/**
 * Where each input comes from: the app's own export feature and what to drop. The web app shows these on its
 * start screen and the site's guide page; `docs/formats/` describes each layout in full.
 */
export interface ExportGuide {
  /** Platform id the importer reports (`telegram` is Telegram Desktop's export). */
  platform: string;
  app: string;
  /** What to drop, in a few words. */
  drop: string;
  steps: string[];
  tip?: string;
}

export const EXPORT_GUIDES: readonly ExportGuide[] = [
  {
    platform: 'telegram',
    app: 'Telegram',
    drop: 'the export folder (JSON, HTML or both)',
    steps: [
      'In Telegram Desktop, open the chat and choose ⋮ → Export chat history (Settings → Advanced → Export Telegram data exports every chat).',
      'Pick Machine-readable JSON (HTML is read too), tick every media type you want and drag the size limit to 4000 MB.',
      'Drop the ChatExport folder Telegram writes.',
    ],
    tip: 'The size limit applies to each file on its own; a file larger than it is left out of the export.',
  },
  {
    platform: 'whatsapp',
    app: 'WhatsApp',
    drop: 'the .zip, or _chat.txt with its media',
    steps: [
      'Open the chat, tap its name, then Export Chat (Android: ⋮ → More → Export chat).',
      'Choose Attach Media to include photos, videos and voice notes.',
      'Drop the .zip WhatsApp makes.',
    ],
  },
  {
    platform: 'instagram',
    app: 'Instagram',
    drop: 'the “Download your information” .zip or folder',
    steps: [
      'In Instagram, open Accounts Center → Your information and permissions → Download your information.',
      'Request your Messages; JSON keeps exact times, HTML is read too.',
      'When the download is ready, drop the .zip.',
    ],
  },
  {
    platform: 'messenger',
    app: 'Facebook',
    drop: 'the “Download your information” .zip or folder',
    steps: [
      'In Facebook, open Accounts Center → Your information and permissions → Download your information.',
      'Request your Messages; JSON keeps exact times, HTML is read too.',
      'When the download is ready, drop the .zip.',
    ],
  },
  {
    platform: 'snapchat',
    app: 'Snapchat',
    drop: 'the “My Data” .zip or folder',
    steps: [
      'Open My Data in Snapchat’s settings (also at accounts.snapchat.com).',
      'Select Chat History, turn on the JSON files, and submit.',
      'Drop the .zip from the download link Snapchat sends.',
    ],
    tip: 'Snaps themselves are never in the download; saved chat media is.',
  },
  {
    platform: 'vsco',
    app: 'VSCO',
    drop: 'the data download (messages.json)',
    steps: ['Request a copy of your data from VSCO.', 'Drop the .zip it sends; the converter reads messages.json.'],
  },
  {
    platform: 'hinge',
    app: 'Hinge',
    drop: 'the data download (matches.json)',
    steps: ['In Hinge’s settings, choose Download My Data.', 'Drop the .zip it sends; the converter reads export/matches.json.'],
  },
  {
    platform: 'universalchat',
    app: 'UniversalChat',
    drop: 'a .universalchat.zip or .universalchat.json',
    steps: ['A package written by Chat Converter or ChatForge: drop it to edit it or convert it into another format.'],
  },
];

/** The formats a conversion can produce, grouped the way the web app and the site offer them. */
export interface OutputFormat {
  format: ExportFormatId;
  group: 'import' | 'archive' | 'other';
  /** Short name for menus and lists (FORMAT_META's label is the long one). */
  label: string;
  note: string;
  /** Whether the output carries the media files themselves. */
  media: boolean;
}

export const OUTPUT_GROUPS: ReadonlyArray<{ id: OutputFormat['group']; label: string }> = [
  { id: 'import', label: 'Import into an app' },
  { id: 'archive', label: 'Keep a complete copy' },
  { id: 'other', label: 'Other formats' },
];

export const OUTPUT_FORMATS: readonly OutputFormat[] = [
  { format: 'telegram-ios', group: 'import', label: 'Telegram · iPhone & iPad', media: true, note: 'Text and every photo, video, voice note, sticker and file. Share the .zip to Telegram on an iPhone or iPad.' },
  { format: 'telegram-android', group: 'import', label: 'Telegram · Android', media: false, note: 'Text only: Telegram for Android does not upload media from a zip.' },
  { format: 'universalchat-zip', group: 'archive', label: 'UniversalChat package', media: true, note: 'The complete chat plus all media: the lossless archive.' },
  { format: 'universalchat', group: 'archive', label: 'UniversalChat JSON', media: false, note: 'The complete chat as one versioned JSON document.' },
  { format: 'html', group: 'archive', label: 'Web page', media: false, note: 'A readable page to keep or print.' },
  { format: 'markdown', group: 'archive', label: 'Markdown', media: false, note: 'Plain text with light formatting.' },
  { format: 'whatsapp-zip', group: 'other', label: 'WhatsApp export', media: true, note: 'WhatsApp’s own export layout, media included.' },
  { format: 'whatsapp-txt', group: 'other', label: 'WhatsApp text', media: false, note: 'The chat text in WhatsApp’s format; media is shown as “omitted”.' },
  { format: 'telegram-json', group: 'other', label: 'Telegram Desktop JSON', media: false, note: 'Telegram Desktop’s result.json layout.' },
  { format: 'json', group: 'other', label: 'Canonical JSON', media: false, note: 'The full model as JSON.' },
];

export function outputFormat(format: ExportFormatId): OutputFormat | undefined {
  return OUTPUT_FORMATS.find((o) => o.format === format);
}
