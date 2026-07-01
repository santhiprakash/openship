import { docs, resources, changelog } from "@/.source/server";
import { loader } from "fumadocs-core/source";

export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

export const resourcesSource = loader({
  baseUrl: "/resources",
  source: resources.toFumadocsSource(),
});

export const changelogSource = loader({
  baseUrl: "/changelog",
  source: changelog.toFumadocsSource(),
});

export interface ResourceFrontmatter {
  title: string;
  description?: string;
  date?: string;
  category?: string;
  author?: string;
  body: React.ComponentType;
  _exports?: { raw?: string };
}

export interface DocFrontmatter {
  title: string;
  description?: string;
  body: React.ComponentType;
  toc: unknown;
}

export interface ChangelogFrontmatter {
  title: string;
  description?: string;
  version: string;
  date: string;
  tags?: string[];
  body: React.ComponentType;
}
