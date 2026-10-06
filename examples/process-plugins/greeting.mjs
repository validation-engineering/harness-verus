import { greeting } from './version.mjs';

export const name = 'process-greeting';
export const inject = ['webServer'];
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/cordis-process-greeting',
    handler(_request, response) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ greeting, pid: process.pid }));
    },
  }));
}
