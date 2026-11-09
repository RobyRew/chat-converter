/** Site-wide constants for the Chat Converter pages. */
export type Page = 'convert' | 'formats' | 'guide';

export const SOURCE_URL = 'https://github.com/RobyRew/chat-converter';
export const DOCS_URL = `${SOURCE_URL}/blob/main/docs`;

/** The format notes in the repository for each source app. */
export const INPUT_DOCS: Record<string, string> = {
  telegram: `${DOCS_URL}/formats/telegram-desktop-export.md`,
  whatsapp: `${DOCS_URL}/formats/whatsapp-export.md`,
  instagram: `${DOCS_URL}/formats/meta-export.md`,
  messenger: `${DOCS_URL}/formats/meta-export.md`,
  snapchat: `${DOCS_URL}/formats/snapchat-export.md`,
  vsco: `${DOCS_URL}/formats/vsco-and-hinge-exports.md`,
  hinge: `${DOCS_URL}/formats/vsco-and-hinge-exports.md`,
  universalchat: `${DOCS_URL}/universalchat.md`,
};
