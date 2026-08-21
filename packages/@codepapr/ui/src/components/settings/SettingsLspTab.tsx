import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FieldCard, ToggleField } from '../forms';
import { useAgentStore } from '../../store/agentStore';
import { isKnownLspFamilyId, type LspFamilyId } from '../../utils/lspFamilies';
import type { SettingsTabProps } from './types';
import { SettingsKnowledgeGraph } from './SettingsKnowledgeGraph';

export interface LspFamilyStatus {
  familyId: string;
  label: string;
  languageIds: string[];
  available: boolean;
  origin: string;
  toolLabel: string;
  path: string | null;
  sizeBytes: number;
  usesRuntime: string | null;
  running: boolean;
  enabled: boolean;
}

export interface LspRuntimeStatus {
  id: string;
  label: string;
  usedBy: string[];
  origin: string;
  path: string | null;
  sizeBytes: number;
  available: boolean;
}

export interface LspInventory {
  families: LspFamilyStatus[];
  runtimes: LspRuntimeStatus[];
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function originLabel(
  origin: string,
  t: SettingsTabProps['t'],
): string {
  if (origin === 'bundled') return t.settingsLspOriginBundled;
  if (origin === 'cache') return t.settingsLspOriginCache;
  if (origin === 'system') return t.settingsLspOriginSystem;
  return t.settingsLspOriginMissing;
}

function familyLabel(familyId: string, t: SettingsTabProps['t']): string {
  switch (familyId) {
    case 'typescript': return t.lspFamilyTypescript;
    case 'html': return t.lspFamilyHtml;
    case 'css': return t.lspFamilyCss;
    case 'json': return t.lspFamilyJson;
    case 'yaml': return t.lspFamilyYaml;
    case 'python': return t.lspFamilyPython;
    case 'csharp': return t.lspFamilyCsharp;
    case 'java': return t.lspFamilyJava;
    case 'cpp': return t.lspFamilyCpp;
    case 'shellscript': return t.lspFamilyShell;
    case 'rust': return t.lspFamilyRust;
    case 'go': return t.lspFamilyGo;
    case 'swift': return t.lspFamilySwift;
    case 'sql': return t.lspFamilySql;
    case 'markdown': return t.lspFamilyMarkdown;
    default: return familyId;
  }
}

function runtimeLabel(id: string, t: SettingsTabProps['t']): string {
  switch (id) {
    case 'node-runtime': return t.settingsLspRuntimeNode;
    case 'node-packages': return t.settingsLspRuntimeNodePackages;
    case 'dotnet-sdk': return t.settingsLspRuntimeDotnet;
    case 'java-jre': return t.settingsLspRuntimeJavaJre;
    default: return id;
  }
}

export function SettingsLspTab({ local, update, t, currentLang }: SettingsTabProps) {
  const workspacePath = useAgentStore((s) => s.workspacePath);
  const [inventory, setInventory] = useState<LspInventory | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [stoppingFamily, setStoppingFamily] = useState<string | null>(null);

  const loadInventory = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await invoke<LspInventory>('lsp_list_components');
      setInventory(result);
    } catch (error) {
      setInventory(null);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);

  const disabled = new Set(local.lspDisabledFamilies);
  const setFamilyEnabled = (familyId: LspFamilyId, enabled: boolean) => {
    const next = new Set(disabled);
    if (enabled) {
      next.delete(familyId);
    } else {
      next.add(familyId);
    }
    update({ lspDisabledFamilies: [...next] });
  };

  const stopFamily = async (familyId: string) => {
    if (!workspacePath.trim()) {
      return;
    }
    setStoppingFamily(familyId);
    try {
      await invoke('lsp_stop_server', { workspacePath, languageId: familyId });
      await loadInventory();
    } catch {
      await loadInventory();
    } finally {
      setStoppingFamily(null);
    }
  };

  return (
    <div className="space-y-5">
      <FieldCard>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-fg">{t.settingsLspTab}</h3>
            <p className="mt-2 text-[11px] leading-relaxed text-fg-soft">{t.settingsLspDesc}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">{t.settingsLspHint}</p>
          </div>
          <button
            type="button"
            onClick={() => void loadInventory()}
            disabled={loading}
            className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-accent-soft hover:text-fg disabled:opacity-50"
          >
            {loading ? '...' : t.settingsLspRefresh}
          </button>
        </div>
      </FieldCard>

      <SettingsKnowledgeGraph t={t} lang={currentLang} />

      {loadError && (
        <div className="rounded-2xl border border-danger-bg bg-danger-bg px-4 py-3 text-sm text-danger">
          {t.settingsLspLoadError}: {loadError}
        </div>
      )}

      <div className="space-y-3">
        <h3 className="px-1 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
          {t.settingsLspLanguages}
        </h3>
        {(inventory?.families ?? []).map((family) => {
          const enabled = !disabled.has(family.familyId);
          const origin = originLabel(family.origin, t);
          const status = !family.available
            ? t.settingsLspStatusMissing
            : family.running
              ? t.settingsLspStatusRunning
              : enabled
                ? t.settingsLspStatusReady
                : t.settingsLspStatusDisabled;
          return (
            <ToggleField
              key={family.familyId}
              checked={enabled}
              onChange={(checked) => {
                if (isKnownLspFamilyId(family.familyId)) {
                  setFamilyEnabled(family.familyId, checked);
                }
              }}
              label={familyLabel(family.familyId, t)}
              desc={`${family.toolLabel || family.label} · ${origin} · ${status}${
                family.sizeBytes > 0 ? ` · ${formatBytes(family.sizeBytes)}` : ''
              }`}
              title={family.path ?? undefined}
              extra={
                family.running && workspacePath.trim() ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void stopFamily(family.familyId);
                    }}
                    disabled={stoppingFamily === family.familyId}
                    className="mt-2 rounded-md border border-line px-2 py-1 text-[10px] text-fg-muted hover:border-danger-bg hover:text-danger disabled:opacity-50"
                  >
                    {stoppingFamily === family.familyId ? '...' : t.settingsLspStop}
                  </button>
                ) : undefined
              }
            />
          );
        })}
        {!loading && !loadError && (inventory?.families.length ?? 0) === 0 && (
          <p className="px-1 text-xs text-fg-muted">{t.settingsLspEmpty}</p>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="px-1 text-xs font-semibold uppercase tracking-[0.18em] text-fg-muted">
          {t.settingsLspRuntimes}
        </h3>
        {(inventory?.runtimes ?? []).map((runtime) => (
          <FieldCard key={runtime.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-fg">{runtimeLabel(runtime.id, t)}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
                  {originLabel(runtime.origin, t)}
                  {runtime.usedBy.length > 0 ? ` · ${runtime.usedBy.map((id) => familyLabel(id, t)).join(', ')}` : ''}
                </p>
                {runtime.path && (
                  <p className="mt-1 break-all text-[10px] text-fg-dim" title={runtime.path}>
                    {runtime.path}
                  </p>
                )}
              </div>
              <span className="shrink-0 text-xs text-fg-soft">{formatBytes(runtime.sizeBytes)}</span>
            </div>
          </FieldCard>
        ))}
      </div>
    </div>
  );
}
