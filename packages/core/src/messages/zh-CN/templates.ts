import type { TemplateDefinition, TemplateRegistry } from '../../domain/template/renderer.js';

export function createZhCNTemplates(): TemplateRegistry {
  const cocCheckTemplate: TemplateDefinition = {
    variants: [
      {
        id: 'detailed',
        weight: 1,
        text: '{{summary}}',
      },
    ],
  };

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
    'coc.check.success': cocCheckTemplate,
    'coc.check.failed': cocCheckTemplate,
  };
}
