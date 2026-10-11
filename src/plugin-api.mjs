/** Stable local authoring entry; official tool definitions share one bundled module. */
export { Context, Service, FiberState } from '@validation-engineering/cordis-compat-deepseek';
export { defineTool, createUserMessage, SessionId, ToolCallId } from '../dist/upstream/plugins.mjs';
