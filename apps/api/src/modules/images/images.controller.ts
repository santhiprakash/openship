/**
 * Image catalog controller - proxies the Oblien image catalog to the dashboard.
 */

import type { Context } from "hono";
import { getActiveOrganizationId } from "../../lib/controller-helpers";
import * as imagesService from "./images.service";

export async function list(c: Context) {
  const organizationId = getActiveOrganizationId(c);
  const search = c.req.query("search")?.trim() || undefined;
  const category = c.req.query("category")?.trim() || undefined;

  try {
    const images = await imagesService.listImages(organizationId, { search, category });
    return c.json({ success: true, images });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list images";
    if (message === "cloud-not-connected") {
      // Not an error from the user's perspective - they just don't have
      // a cloud account linked. Return an empty catalog so the modal can
      // fall back to the Custom Image tile cleanly.
      return c.json({ success: true, images: [], cloudConnected: false });
    }
    return c.json({ success: false, error: message }, 500);
  }
}
