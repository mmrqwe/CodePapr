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
  /** 可选完整性校验：文件相对路径 → 内容 SHA-256（hex）。安装时逐文件比对，
   *  不匹配或缺失校验和的已声明文件直接中止安装。 */
  sha256?: Record<string, string>;
}

export interface PaprMarketRegistry {
  version: string;
  name: string;
  description: string;
  repository: string;
  updatedAt: string;
  apps: PaprAppListing[];
}
