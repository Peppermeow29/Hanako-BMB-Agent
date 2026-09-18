/**
 * server/main-full.ts — full product composition entry (closed).
 *
 * The thin entry every current boot path spawns/imports to start the real
 * product server: `scripts/launch.js` (`npm run server`),
 * `scripts/dev-web.js` (`npm run dev:web`), `cli/server-runner.ts`'s
 * source-mode spawn, `desktop/main.cjs`'s dev-mode `HANA_SERVER_ENTRY`, and
 * `vite.config.server.js`'s build entry (packaged `bundle/index.js`, which
 * `server/bootstrap.ts` imports at runtime).
 *
 * Normal boot statically pairs the open composition root's `startServer`
 * export with the closed route hook and media adapter list. The sole env
 * branch below is a release-only, one-shot runtime probe: it starts no
 * composition and cannot switch an open server into the closed product or
 * vice versa. Which composition boots remains fixed by the selected entry.
 */
import { startServer } from "./index.ts";
import { registerClosedRoutes } from "./composition/full-root.ts";
await startServer({ registerClosedRoutes });
