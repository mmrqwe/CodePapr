/**
 * 工具参数校验辅助函数 - CLI 和 UI 共享
 */

export function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} 必须是非空字符串`);
  }
  return value;
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

export function asOptionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return asPositiveInteger(value, name);
}

export function asOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${name} 必须是布尔值`);
  }
  return value;
}

export function asOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('args 必须是字符串数组');
  }
  return value;
}

export function asPatchArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('patches 必须是非空数组');
  }
  if (value.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('patches 每一项都必须是对象');
  }
  return value as Array<Record<string, unknown>>;
}

export function asSafeSkillName(value: unknown, name: string): string {
  const raw = asString(value, name);
  if (!/^[A-Za-z0-9._/-]+$/.test(raw) || raw.includes('..')) {
    throw new Error(`${name} 只能包含安全的 skill 路径片段`);
  }
  return raw;
}

export function boundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value ?? fallback));
}
