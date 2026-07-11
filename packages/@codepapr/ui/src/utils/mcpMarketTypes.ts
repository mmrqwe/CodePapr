export type MarketSource = 'official';

export interface RegistryEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  choices?: string[];
}

export interface RegistryTransport {
  type: 'stdio' | 'streamable-http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  variables?: Record<string, string>;
}

export interface RegistryPackage {
  registryType: 'npm' | 'pypi' | 'cargo' | 'oci' | 'nuget' | 'mcpb';
  registryBaseUrl?: string;
  identifier: string;
  version?: string;
  fileSha256?: string;
  runtimeHint?: 'npx' | 'uvx' | 'docker' | 'dnx';
  transport: RegistryTransport;
  runtimeArguments?: string[];
  packageArguments?: string[];
  environmentVariables?: RegistryEnvVar[];
}

export interface RegistryServerJSON {
  $schema?: string;
  name: string;
  description: string;
  title?: string;
  version: string;
  websiteUrl?: string;
  repository?: {
    url: string;
    source?: string;
    id?: string;
    subfolder?: string;
  };
  icons?: Array<{ src: string; mimeType?: string; sizes?: string; theme?: string }>;
  packages?: RegistryPackage[];
  remotes?: RegistryTransport[];
}

export interface RegistryServerEntry {
  server: RegistryServerJSON;
  _meta: Record<string, {
    status?: string;
    statusChangedAt?: string;
    statusMessage?: string;
    publishedAt?: string;
    updatedAt?: string;
    isLatest?: boolean;
  }>;
}

export interface RegistryListResponse {
  servers: RegistryServerEntry[];
  metadata: {
    count: number;
    nextCursor?: string;
  };
}

export interface MarketMCPListing {
  id: string;
  name: string;
  title: string;
  description: string;
  source: MarketSource;
  registryType: string;
  identifier: string;
  runtimeHint: string;
  transport: RegistryTransport;
  envVars: RegistryEnvVar[];
  packageArgs: string[];
  runtimeArgs: string[];
  command: string;
  args: string;
  url: string;
  categories: ('search' | 'database' | 'custom')[];
  iconUrl: string;
  websiteUrl: string;
  repositoryUrl: string;
  verified: boolean;
  useCount: number;
  version: string;
  needsManualConfig: boolean;
  manualConfigNote: string;
}

export interface MarketPagination {
  nextCursor?: string;
  currentPage: number;
  hasMore: boolean;
}
