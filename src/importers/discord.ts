import type { CapabilityMatrix, Conversation } from '../model';
import {
  ConversionError,
  type DetectResult,
  type Importer,
  type ImportInput,
  type ParseContext,
} from '../engine/contracts';

/** Discord importer — scaffolded. Targets the DiscordChatExporter JSON format next. */
const stubCaps: CapabilityMatrix = {};

export const discordImporter: Importer = {
  platform: 'discord',
  capabilities: stubCaps,
  detect: async (_input: ImportInput): Promise<DetectResult> => ({ platform: 'discord', confidence: 0, reason: 'stub' }),
  parse: async (_input: ImportInput, _ctx: ParseContext): Promise<Conversation> => {
    throw new ConversionError('Discord importer is scaffolded but not implemented yet', 'NOT_IMPLEMENTED');
  },
};
