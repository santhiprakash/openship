// source.config.ts
import { defineDocs, defineConfig, frontmatterSchema } from "fumadocs-mdx/config";
import { z } from "zod";
var docs = defineDocs({ dir: "content/docs" });
var resources = defineDocs({
  dir: "content/resources",
  docs: {
    schema: frontmatterSchema.extend({
      date: z.string().optional(),
      category: z.string().optional(),
      author: z.string().optional()
    })
  }
});
var changelog = defineDocs({
  dir: "content/changelog",
  docs: {
    schema: frontmatterSchema.extend({
      version: z.string(),
      date: z.string(),
      tags: z.array(z.string()).optional()
    })
  }
});
var source_config_default = defineConfig();
export {
  changelog,
  source_config_default as default,
  docs,
  resources
};
