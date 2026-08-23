import type { ModelProfile, Settings } from '../store/internals/types';

export type VisionSlot = 'primary' | 'fast' | 'mentor';

function findProfile(
  settings: Settings,
  profileId: string | undefined,
): ModelProfile | undefined {
  if (!profileId || !settings.modelProfiles?.length) return undefined;
  return settings.modelProfiles.find((p) => p.id === profileId);
}

function profileVision(profile: ModelProfile | undefined): boolean | undefined {
  if (!profile || typeof profile.multimodalEnabled !== 'boolean') return undefined;
  return profile.multimodalEnabled;
}

function legacySlotVision(settings: Settings, slot: 'primary' | 'fast'): boolean {
  if (!settings.multimodalEnabled) return false;
  if (settings.multimodalModelTier === 'all') return true;
  return settings.multimodalModelTier === slot;
}

/**
 * Known pure-text models that do not accept multimodal/vision inputs in their API.
 * Even if multimodal is accidentally toggled on in profiles/settings, they should
 * not receive raw image payloads directly.
 */
export function isKnownTextOnlyModel(modelName: string | undefined): boolean {
  if (!modelName) return false;
  const lower = modelName.trim().toLowerCase();
  if (lower.includes('deepseek')) return true;
  if (
    lower === 'o1-mini' ||
    lower === 'o3-mini' ||
    lower.startsWith('gpt-3.5') ||
    lower.startsWith('text-embedding')
  ) {
    return true;
  }
  if (lower.startsWith('qwen') && !lower.includes('-vl') && !lower.includes('vision')) {
    return true;
  }
  return false;
}

/** Fast slot is actually available as a routing target. */
export function isFastSlotAvailable(settings: Settings): boolean {
  return settings.fastModelEnabled === true && trim(settings.fastModel).length > 0;
}

/**
 * Whether the fast role itself can receive images.
 * Does not fall back to the primary profile — fast must be enabled and its own
 * profile (or legacy flag) must turn vision on.
 */
export function fastSlotSupportsVision(settings: Settings): boolean {
  if (!isFastSlotAvailable(settings)) return false;
  const fastModel = settings.modelProfiles?.length
    ? findProfile(settings, settings.fastProfileId)?.model || settings.fastModel
    : settings.fastModel;
  if (isKnownTextOnlyModel(fastModel)) return false;
  if (settings.modelProfiles?.length) {
    const fast = findProfile(settings, settings.fastProfileId);
    return profileVision(fast) === true;
  }
  return legacySlotVision(settings, 'fast');
}

export function primarySlotSupportsVision(settings: Settings): boolean {
  const primaryModel = settings.modelProfiles?.length
    ? (findProfile(settings, settings.primaryProfileId) || settings.modelProfiles[0])?.model || settings.model
    : settings.model;
  if (isKnownTextOnlyModel(primaryModel)) return false;
  if (settings.modelProfiles?.length) {
    const primary =
      findProfile(settings, settings.primaryProfileId) || settings.modelProfiles[0];
    const flagged = profileVision(primary);
    if (flagged !== undefined) return flagged;
  }
  return legacySlotVision(settings, 'primary');
}

export function mentorSlotSupportsVision(settings: Settings): boolean {
  if (!settings.mentorEnabled || !trim(settings.mentorModel)) return false;
  const mentorModel = settings.modelProfiles?.length
    ? findProfile(settings, settings.mentorProfileId)?.model || settings.mentorModel
    : settings.mentorModel;
  if (isKnownTextOnlyModel(mentorModel)) return false;
  if (settings.modelProfiles?.length) {
    return profileVision(findProfile(settings, settings.mentorProfileId)) === true;
  }
  return false;
}

function trim(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function inferVisionSlot(settings: Settings, currentModel: string): VisionSlot {
  const model = trim(currentModel);
  const fast = trim(settings.fastModel);
  const primary = trim(settings.model);
  const mentor = trim(settings.mentorModel);
  const isFast = isFastSlotAvailable(settings) && model === fast;
  const isPrimary = model === primary;
  const isMentor = settings.mentorEnabled && mentor.length > 0 && model === mentor;
  if (isFast && !isPrimary) return 'fast';
  if (isMentor && !isPrimary && !isFast) return 'mentor';
  return 'primary';
}

export function slotSupportsVision(settings: Settings, slot: VisionSlot): boolean {
  if (slot === 'fast') return fastSlotSupportsVision(settings);
  if (slot === 'mentor') return mentorSlotSupportsVision(settings);
  return primarySlotSupportsVision(settings);
}

/** The running model itself can take image inputs. */
export function modelSupportsVision(settings: Settings, currentModel: string): boolean {
  if (isKnownTextOnlyModel(currentModel)) return false;
  return slotSupportsVision(settings, inferVisionSlot(settings, currentModel));
}

/**
 * Offload only to the fast slot, and only when it has multimodal enabled.
 * Mentor is never a vision fallback.
 */
export function shouldOffloadVision(settings: Settings, currentModel: string): boolean {
  const slot = inferVisionSlot(settings, currentModel);
  if (slot === 'fast') return false;
  return !slotSupportsVision(settings, slot) && fastSlotSupportsVision(settings);
}

/** Show `read_image` when this model can see, or when fast can see on its behalf. */
export function shouldExposeReadImage(settings: Settings, currentModel: string): boolean {
  return modelSupportsVision(settings, currentModel) || shouldOffloadVision(settings, currentModel);
}

export type VisionInputAction = 'native' | 'offload' | 'drop';

export function resolveVisionInputAction(
  settings: Settings,
  currentModel: string,
): VisionInputAction {
  if (modelSupportsVision(settings, currentModel)) return 'native';
  if (shouldOffloadVision(settings, currentModel)) return 'offload';
  return 'drop';
}
