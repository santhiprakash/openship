import { Hono } from "hono";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./destination.controller";

const r = secureRouter(new Hono(), {
  module: "backup-destinations",
  basePath: "/api/backup-destinations",
});


r.get("/", { tag: "backup_destination:list" }, ctrl.listAll);
r.post("/", { tag: "backup_destination:write" }, ctrl.create);
r.get("/:id", { tag: "backup_destination:read" }, ctrl.getOne);
r.patch("/:id", { tag: "backup_destination:write" }, ctrl.update);
r.delete("/:id", { tag: "backup_destination:admin" }, ctrl.remove);
r.post("/:id/preflight", { tag: "backup_destination:write" }, ctrl.preflight);

export const backupDestinationRoutes = r.hono;

