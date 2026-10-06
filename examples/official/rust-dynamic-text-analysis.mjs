import { defineTool } from '../../src/official-plugin-api.mjs';
import { registerDynamicTextTool } from '../shared/dynamic-text-tool.mjs';

export const name = 'cordis-harness-rust-dynamic-text-analysis';
export const inject = ['tools', 'rustDynamicText'];
// The application host owns the module controller. This consumer restarts when
// its provider changes, unregistering the old tool before provider cleanup.
export function apply(ctx) { registerDynamicTextTool(ctx, defineTool); }
