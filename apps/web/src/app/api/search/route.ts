import { docsSource } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

// Native Fumadocs full-text search endpoint (powers the ⌘K dialog).
export const { GET } = createFromSource(docsSource);
