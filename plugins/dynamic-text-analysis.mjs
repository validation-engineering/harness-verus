import { defineTool } from '@cordis-harness/app/plugin-api';
import { registerDynamicTextTool } from '../examples/shared/dynamic-text-tool.mjs';

export const name = 'dynamic-text-analysis';
export const inject = ['tools', 'rustDynamicText'];
export function apply(ctx) { registerDynamicTextTool(ctx, defineTool); }
