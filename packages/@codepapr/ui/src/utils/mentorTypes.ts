import type { ApiFormat, Settings } from '../store/agentStore';

export interface MentorSettings {
  enabled: boolean;
  model: string;
  baseURL: string;
  apiKey: string;
  apiFormat: ApiFormat;
  maxTokens: number;
  maxConsultations: number;
}

export const DEFAULT_MENTOR_SETTINGS: MentorSettings = {
  enabled: false,
  model: '',
  baseURL: '',
  apiKey: '',
  apiFormat: 'openai',
  maxTokens: 10000,
  maxConsultations: 2,
};

export function extractMentorSettings(settings: Settings): MentorSettings {
  return {
    enabled: settings.mentorEnabled,
    model: settings.mentorModel,
    baseURL: settings.mentorBaseURL,
    apiKey: settings.mentorApiKey,
    apiFormat: settings.mentorApiFormat,
    maxTokens: settings.mentorMaxTokens,
    maxConsultations: settings.maxMentorConsultations,
  };
}
