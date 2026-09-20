import type { RandomSource } from '../../ports/random-source.js';

export interface TemplateVariant {
  readonly id: string;
  readonly weight: number;
  readonly text: string;
}

export interface TemplateDefinition {
  readonly variants: readonly TemplateVariant[];
}

export type TemplateRegistry = Readonly<Record<string, TemplateDefinition>>;

export class TemplateRenderer {
  private readonly templates: Map<string, TemplateDefinition>;

  constructor(initialTemplates: TemplateRegistry = {}) {
    this.templates = new Map(Object.entries(initialTemplates));
  }

  register(key: string, definition: TemplateDefinition): void {
    this.templates.set(key, definition);
  }

  has(key: string): boolean {
    return this.templates.has(key);
  }

  async render(
    templateKey: string,
    data: Record<string, unknown>,
    random?: RandomSource,
  ): Promise<{ text: string; variantId?: string }> {
    const def = this.templates.get(templateKey);
    if (!def || def.variants.length === 0) {
      return { text: '' };
    }

    let selectedVariant: TemplateVariant;
    const firstVariant = def.variants[0];
    if (!firstVariant) {
      return { text: '' };
    }

    if (def.variants.length === 1 || !random) {
      selectedVariant = firstVariant;
    } else {
      const totalWeight = def.variants.reduce((acc, v) => acc + Math.max(1, v.weight), 0);
      const pick = await random.integer(1, totalWeight);
      let cumulative = 0;
      selectedVariant = firstVariant;
      for (const v of def.variants) {
        cumulative += Math.max(1, v.weight);
        if (pick <= cumulative) {
          selectedVariant = v;
          break;
        }
      }
    }

    const rendered = this.interpolate(selectedVariant.text, data);
    return {
      text: rendered,
      variantId: selectedVariant.id,
    };
  }

  private interpolate(templateStr: string, data: Record<string, unknown>): string {
    return templateStr.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path: string) => {
      const parts = path.split('.');
      let current: unknown = data;
      for (const part of parts) {
        if (current && typeof current === 'object' && part in current) {
          current = (current as Record<string, unknown>)[part];
        } else {
          return '';
        }
      }
      return current !== undefined && current !== null ? String(current) : '';
    });
  }
}

export function createClassicTemplates(): TemplateRegistry {
  return {
    'dice.roll': {
      variants: [
        {
          id: 'detailed',
          weight: 1,
          text: '{{actor.name}} 掷骰: {{detail}}',
        },
      ],
    },
    'coc.check.success': {
      variants: [
        {
          id: 'standard',
          weight: 3,
          text: '{{actor.name}}的{{skill.name}}检定成功！\n出目：{{roll.total}} / 目标值：{{target.value}}',
        },
        {
          id: 'critical',
          weight: 1,
          text: '{{actor.name}}掷出了大成功！\n{{skill.name}}：{{roll.total}} / {{target.value}}',
        },
      ],
    },
    'coc.check.failed': {
      variants: [
        {
          id: 'standard',
          weight: 3,
          text: '{{actor.name}}的{{skill.name}}检定失败。\n出目：{{roll.total}} / 目标值：{{target.value}}',
        },
        {
          id: 'extreme_failure',
          weight: 1,
          text: '{{actor.name}}掷出了大失败...\n{{skill.name}}：{{roll.total}} / {{target.value}}',
        },
      ],
    },
  };
}
