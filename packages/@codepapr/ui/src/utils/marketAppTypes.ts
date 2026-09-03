export type AppInstallScope = 'global' | 'workspace';

export interface PaprAppListing {
  id: string;
  name: string;
  title: string;
  titleEn?: string;
  version: string;
  description: string;
  descriptionEn?: string;
  kind: 'app' | 'plugin';
  author?: string;
  icon?: string;
  tags: string[];
  directory: string;
  entry?: string;
  files?: string[];
  surface?: {
    type?: string;
    width?: number;
    height?: number;
    position?: string;
  };
  permissions?: {
    network?: boolean;
    local?: 'none' | 'read' | 'write';
  };
}

export interface PaprMarketRegistry {
  version: string;
  name: string;
  description: string;
  repository: string;
  updatedAt: string;
  apps: PaprAppListing[];
}
