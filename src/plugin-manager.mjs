import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { FiberState } from '@validation-engineering/cordis-compat-deepseek';

/** Mutations are serialized by the application at a quiescent agent boundary. */
export class PluginManager {
  #ctx; #base; #builtins; #entries = new Map();
  constructor(ctx, base, builtins) { this.#ctx = ctx; this.#base = base; this.#builtins = builtins; }
  list() { return [...this.#entries].map(([id, entry]) => ({ id, module: entry.spec.module, state: entry.fiber.state, cleanupBlocked: entry.cleanupBlocked ?? false })); }
  async #resolve(spec, fresh) {
    if (!spec || typeof spec.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(spec.id) || typeof spec.module !== 'string') {
      throw new TypeError('Plugin entries require a stable id and module');
    }
    if (Object.hasOwn(this.#builtins, spec.module)) return this.#builtins[spec.module];
    let url;
    if (spec.module.startsWith('.')) url = pathToFileURL(resolve(this.#base, spec.module));
    else {
      if (spec.module.includes(':') || spec.module.startsWith('/')) throw new Error('Use a relative path or installed npm package for a plugin');
      url = pathToFileURL(createRequire(pathToFileURL(resolve(this.#base, 'package.json'))).resolve(spec.module));
    }
    if (fresh && url.pathname.endsWith('.mjs')) url.searchParams.set('reload', String(fresh));
    const module = await import(url.href);
    return module.default ?? module;
  }
  async load(spec, { fresh = false } = {}) {
    if (this.#entries.has(spec.id)) throw new Error(`Plugin already loaded: ${spec.id}`);
    if ([...this.#entries.values()].some(entry => entry.spec.module === spec.module)) throw new Error(`Plugin module already loaded: ${spec.module}`);
    const plugin = await this.#resolve(spec, fresh ? randomUUID() : undefined);
    return this.#activate(structuredClone(spec), plugin);
  }
  #retained(fiber) { return this.#ctx.snapshot().plugins.some(node => node.id === fiber.id); }
  #recordDisposalFailure(id, entry) {
    // Observer errors can reject disposal after native removal has succeeded.
    if (this.#retained(entry.fiber)) this.#entries.set(id, { ...entry, cleanupBlocked: true });
    else this.#entries.delete(id);
  }
  async #settleDisposalFailure(id, entry, error) {
    // A child's disposal can reject before its parent's structural inverse
    // finishes reporting that failure. Drain those existing lifecycle actions
    // before exposing retry; settlement does not retry any failed inverse.
    const failures = [error];
    try { await this.#ctx.settle(); } catch (settlement) { if (settlement !== error) failures.push(settlement); }
    this.#recordDisposalFailure(id, entry);
    return failures.length === 1 ? error
      : new AggregateError(failures, `Plugin ${id} cleanup failed after lifecycle settlement`);
  }
  async #activate(spec, plugin) {
    const fiber = this.#ctx.plugin(plugin, spec.config ?? {});
    try {
      await this.#ctx.settle();
      if (fiber.state === FiberState.PENDING) throw new Error(`Plugin ${spec.id} is pending: load its required services first`);
      await fiber;
      this.#entries.set(spec.id, { spec, plugin, fiber });
      return { id: spec.id, module: spec.module, state: fiber.state, cleanupBlocked: false };
    } catch (error) {
      try { await fiber.dispose(); }
      catch (cleanup) {
        cleanup = await this.#settleDisposalFailure(spec.id, { spec, plugin, fiber }, cleanup);
        const detail = this.#entries.has(spec.id) ? 'cleanup is blocked; retain it until explicit retry succeeds' : 'was removed, but disposal reported an error';
        throw new AggregateError([error, cleanup], `Plugin ${spec.id} ${detail}`);
      }
      throw error;
    }
  }
  async unload(id) {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`Plugin not loaded: ${id}`);
    if (entry.cleanupBlocked) throw new Error(`Plugin ${id} cleanup is blocked; use retryPluginCleanup`);
    try { await entry.fiber.dispose(); }
    catch (error) { throw await this.#settleDisposalFailure(id, entry, error); }
    this.#entries.delete(id);
  }
  async retryCleanup(id) {
    const entry = this.#entries.get(id);
    if (!entry?.cleanupBlocked) throw new Error(`Plugin ${id} has no blocked cleanup`);
    const nodes = this.#ctx.snapshot().plugins;
    if (!nodes.some(node => node.id === entry.fiber.id)) { this.#entries.delete(id); return; }
    const children = new Map();
    for (const node of nodes) {
      if (!children.has(node.parent)) children.set(node.parent, []);
      children.get(node.parent).push(node.id);
    }
    // Retry only the owned subtree, deepest first. External consumers have
    // separate owners and must be repaired through their own plugin entry.
    const order = [];
    const visit = nodeId => { for (const child of children.get(nodeId) ?? []) visit(child); order.push(nodeId); };
    visit(entry.fiber.id);
    const fibers = new Map([...this.#ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => [fiber.id, fiber])));
    try {
      for (const nodeId of order) {
        if (!this.#ctx.snapshot().plugins.some(node => node.id === nodeId && node.cleanupFailed)) continue;
        const fiber = fibers.get(nodeId);
        if (!fiber) throw new Error(`Cannot recover retained plugin Fiber ${nodeId}`);
        await fiber.retryCleanup();
      }
      await entry.fiber.dispose();
    } catch (error) { throw await this.#settleDisposalFailure(id, entry, error); }
    this.#entries.delete(id);
  }
  async reload(id, config) {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`Plugin not loaded: ${id}`);
    await this.unload(id);
    try { return await this.load({ ...entry.spec, config: config ?? entry.spec.config }, { fresh: true }); }
    catch (error) {
      if (this.#entries.has(id)) throw error; // Failed newcomer still owns resources: do not restore another instance.
      try { await this.#activate(entry.spec, entry.plugin); } catch (rollback) { throw new AggregateError([error, rollback], `Plugin ${id} reload and restoration failed`); }
      throw error;
    }
  }
}
