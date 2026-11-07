import type { CapabilityMatrix, Conversation } from '../model';
import {
  ConversionError,
  type DetectResult,
  type Importer,
  type ImportInput,
  type ParseContext,
} from '../engine/contracts';

/**
 * Meta (Instagram / Messenger) importers — scaffolded. The contract is ready; the parser
 * for the "Download Your Information" JSON (incl. its latin1/UTF-8 mojibake quirk) lands next.
 */
const stubCaps: CapabilityMatrix = {};

function neverDetect(platform: Importer['platform']) {
  return (_input: ImportInput): DetectResult => ({ platform, confidence: 0, reason: 'stub' });
}

function notImplemented(label: string) {
  return async (_input: ImportInput, _ctx: ParseContext): Promise<Conversation> => {
    throw new ConversionError(`${label} importer is scaffolded but not implemented yet`, 'NOT_IMPLEMENTED');
  };
}

export const instagramImporter: Importer = {
  platform: 'instagram',
  capabilities: stubCaps,
  detect: neverDetect('instagram'),
  parse: notImplemented('Instagram'),
};

export const messengerImporter: Importer = {
  platform: 'messenger',
  capabilities: stubCaps,
  detect: neverDetect('messenger'),
  parse: notImplemented('Messenger'),
};
