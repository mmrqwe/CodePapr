/**
 * ImmutablePrefix: Frozen system prompt, tools, few-shots
 *
 * Core invariant: Once created, this object NEVER changes.
 * - System prompt is 100% static (no timestamps, no placeholders)
 * - Tool definitions are frozen
 * - Few-shot examples are immutable
 * - SHA256 hash is computed at startup and never changes
 */

import {
  IImmutablePrefix,
  IToolDefinition,
  IMessage,
  IModelParameters,
  IPrefixContent,
  PrefixModificationError,
} from '@codepapr/types';
import { sha256, deepFreeze } from '@codepapr/common';
import { Serializer } from './Serializer';

function canonicalToolDefinition(tool: IToolDefinition): IToolDefinition {
  const parameters = Serializer.canonical(tool.parameters) as IToolDefinition['parameters'];

  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      ...parameters,
      required: parameters.required ? [...parameters.required].sort() : undefined,
    },
  };
}

export class ImmutablePrefix implements IImmutablePrefix {
  private readonly systemPrompt: string;
  private readonly tools: ReadonlyArray<IToolDefinition>;
  private readonly fewShots: ReadonlyArray<IMessage>;
  private readonly model: string;
  private readonly parameters: Readonly<IModelParameters>;

  private readonly hash: string;
  private readonly contentBytes: number;
  private readonly createdAt: number;
  private readonly version: string;

  constructor(config: {
    systemPrompt: string;
    tools: IToolDefinition[];
    fewShots?: IMessage[];
    model: string;
    parameters: IModelParameters;
  }) {
    // 1. Validate static content (no timestamps, dynamic content)
    this.validateStaticContent(config.systemPrompt);

    // 2. Deep freeze and store immutable copies
    this.systemPrompt = config.systemPrompt;
    this.tools = Object.freeze(
      [...config.tools]
        .map((tool) => deepFreeze(canonicalToolDefinition(tool)))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
    this.fewShots = Object.freeze(
      (config.fewShots ?? []).map((m) =>
        deepFreeze({
          ...m,
          metadata: m.metadata ? { ...m.metadata } : undefined,
        })
      )
    );
    this.model = Object.freeze(config.model);
    this.parameters = deepFreeze({
      ...config.parameters,
    }) as Readonly<IModelParameters>;

    // 3. Compute hash immediately (foundation for cache)
    this.hash = this.computeHash();

    // 4. Compute content bytes
    this.contentBytes = Serializer.getByteLength(this.toJSON());

    // 5. Store metadata
    this.createdAt = Date.now();
    this.version = '1.0.0';

    // 6. Final freeze to prevent any future modifications
    Object.freeze(this);
  }

  /**
   * Validate that system prompt contains no dynamic content
   * Destroys cache: timestamps, session IDs, random values, etc.
   */
  private validateStaticContent(prompt: string): void {
    const forbidden = [
      /\$\{[^}]+\}/, // Template interpolation
      /{{[^}]+}}/, // Double braces
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, // ISO timestamps
      /\[TIMESTAMP\]/i,
      /\[SESSION/i,
      /\[TIME/i,
      /\[DATE/i,
      /\[RANDOM/i,
    ];

    for (const pattern of forbidden) {
      if (pattern.test(prompt)) {
        throw new PrefixModificationError(
          `System prompt contains dynamic content matching: ${pattern}. ` +
            `This would destroy cache consistency. Use static content only.`
        );
      }
    }
  }

  /**
   * Compute SHA256 hash of the entire prefix
   * Uses deterministic serialization (sorted keys)
   */
  computeHash(): string {
    const content = this.toJSON();
    const serialized = Serializer.stringify(content);
    return sha256(serialized);
  }

  /**
   * Get frozen system prompt (read-only)
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * Get frozen tool definitions (read-only)
   */
  getToolDefinitions(): ReadonlyArray<IToolDefinition> {
    return this.tools;
  }

  /**
   * Get frozen few-shot examples (read-only)
   */
  getFewShots(): ReadonlyArray<IMessage> {
    return this.fewShots;
  }

  /**
   * Get model name
   */
  getModelName(): string {
    return this.model;
  }

  /**
   * Get model parameters (read-only)
   */
  getParameters(): Readonly<IModelParameters> {
    return this.parameters;
  }

  /**
   * Get content byte count
   */
  getContentBytes(): number {
    return this.contentBytes;
  }

  /**
   * Validate consistency (should always be true)
   */
  validate(): boolean {
    return this.hash === this.computeHash();
  }

  /**
   * Convert to canonical JSON (for serialization)
   */
  toJSON(): IPrefixContent {
    return {
      systemPrompt: this.systemPrompt,
      tools: [...this.tools],
      fewShots: this.fewShots.length > 0 ? [...this.fewShots] : undefined,
      model: this.model,
      parameters: { ...this.parameters },
    };
  }

  /**
   * Convert to message array format (for API requests)
   * Prefix always starts with system message
   */
  toMessageArray(): IMessage[] {
    const messages: IMessage[] = [
      {
        id: 'prefix-system',
        role: 'system' as const,
        content: this.systemPrompt,
        timestamp: 0,
        metadata: { isPrefixSystem: true, prefixHash: this.hash },
      },
    ];

    // Add few-shot examples
    messages.push(...this.fewShots);

    return messages;
  }

  /**
   * Check if frozen (should always be true)
   */
  isFrozen(): boolean {
    return Object.isFrozen(this);
  }

  /**
   * Get version
   */
  getVersion(): string {
    return this.version;
  }

  /**
   * Get creation timestamp
   */
  getCreatedAt(): number {
    return this.createdAt;
  }
}

/**
 * Factory for creating and validating ImmutablePrefix
 */
export class ImmutablePrefixFactory {
  static create(config: {
    systemPrompt: string;
    tools: IToolDefinition[];
    fewShots?: IMessage[];
    model: string;
    parameters: IModelParameters;
  }): IImmutablePrefix {
    return new ImmutablePrefix(config);
  }

  static fromJSON(data: IPrefixContent): IImmutablePrefix {
    return new ImmutablePrefix({
      systemPrompt: data.systemPrompt,
      tools: data.tools,
      fewShots: data.fewShots,
      model: data.model,
      parameters: data.parameters,
    });
  }
}
