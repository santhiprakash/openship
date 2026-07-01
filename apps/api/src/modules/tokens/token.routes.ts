/**
 * Personal Access Token routes — mounted at /api/tokens in app.ts.
 * Self-scoped: every handler operates on the caller's own tokens (ctx.userId).
 * Gated behind settings read/write so any org member can manage their tokens.
 */

import { Hono } from "hono";
import { tbValidator } from "@hono/typebox-validator";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./token.controller";
import { CreateTokenBody } from "./token.schema";

const r = secureRouter(new Hono(), {
  module: "tokens",
  basePath: "/api/tokens",
});

r.get("/", { tag: "settings:read" }, ctrl.list);
r.post("/", { tag: "settings:write" }, tbValidator("json", CreateTokenBody), ctrl.create);
r.delete("/:id", { tag: "settings:write" }, ctrl.revoke);

export const tokenRoutes = r.hono;
