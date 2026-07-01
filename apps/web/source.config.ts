import { defineDocs, defineConfig, frontmatterSchema } from "fumadocs-mdx/config";
import { z } from "zod";

export const docs = defineDocs({ dir: "content/docs" });

export const resources = defineDocs({
  dir: "content/resources",
  docs: {
    schema: frontmatterSchema.extend({
      date: z.string().optional(),
      category: z.string().optional(),
      author: z.string().optional(),
    }),
  },
});

export const changelog = defineDocs({
  dir: "content/changelog",
  docs: {
    schema: frontmatterSchema.extend({
      version: z.string(),
      date: z.string(),
      tags: z.array(z.string()).optional(),
    }),
  },
});

export default defineConfig();
