/**
 * server composition — closed-product full composition root.
 *
 * Mounts the closed-product route surface (avatar, character-cards, cards,
 * desk, diary) on top of whatever `./open-root.ts` already mounted. This
 * file is closed: only `server/main-full.ts` imports it, and
 * `server/index.ts` never does. Every line below is moved verbatim from
 * `server/index.ts`'s old inline mount block (same factory, same
 * arguments, same relative order among these five routes).
 *
 */
import type { Hono } from "hono";
import type { CompositionContext } from "./contract.ts";
import { createAvatarRoute } from "../routes/avatar.ts";
import { createCharacterCardsRoute } from "../routes/character-cards.ts";
import { createCardsRoute } from "../routes/cards.ts";
import { createDeskRoute } from "../routes/desk.ts";
import { createDiaryRoute } from "../routes/diary.ts";

export function registerClosedRoutes(app: Hono, ctx: CompositionContext): void {
  const { engine, hub } = ctx;
  app.route("/api", createAvatarRoute(engine));
  app.route("/api", createCharacterCardsRoute(engine));
  app.route("/api", createCardsRoute(engine));
  app.route("/api", createDeskRoute(engine, hub));
  app.route("/api", createDiaryRoute(engine));
}
