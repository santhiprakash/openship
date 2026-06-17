/**
 * Prepare service - resolves project info from a source (GitHub or local path).
 *
 * Pure introspection: reads files, detects stack, returns a unified shape.
 * No database writes, no deployment logic.
 */

import * as githubService from "../github/github.service";
import { MANIFEST_FILES, type RepoFile, type StackResult } from "../../lib/stack-detector";
import { parseComposeEnvFile, parseComposeFile, type ComposeService } from "../../lib/compose-parser";
import {
  applyWorkspaceContext,
  discoverMonorepoApps,
  discoverProjectRootHints,
  isIgnoredRepoPath,
  normalizeProjectRootDirectory,
  selectPreferredProjectRoot,
  type MonorepoApp,
  type MonorepoWorkspace,
  type ProjectRootSnapshot,
  type ProjectRootSnapshotInput,
  type RepoTreeEntry,
} from "../../lib/project-root-detector";
import type { ProjectType } from "@repo/core";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { env } from "../../config";

const PREPARE_FILE_CONTENTS = [
  ...MANIFEST_FILES,
  "pnpm-workspace.yaml",
  "vercel.json",
  "turbo.json",
  "nx.json",
  "rush.json",
] as const;
const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] as const;

interface ProjectReader {
  listDirectory: (path: string) => Promise<RepoFile[]>;
  readText: (path: string) => Promise<string | undefined>;
  readJson: (path: string) => Promise<Record<string, unknown> | undefined>;
  listTree: () => Promise<RepoTreeEntry[]>;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type Source =
  | { source: "github"; owner: string; repo: string; userId: string; branch?: string }
  | { source: "local"; path: string };

export interface ProjectInfo {
  repository: {
    name: string;
    full_name: string;
    owner: { login: string };
    private: boolean;
    default_branch: string;
    selected_branch?: string;
    clone_url?: string;
    html_url?: string;
    branches?: { name: string }[];
  };
  stack: StackResult["stack"];
  projectType: ProjectType;
  category: string;
  packageManager: string;
  buildCommand: string;
  installCommand: string;
  startCommand: string;
  buildImage: string;
  outputDirectory: string;
  rootDirectory: string;
  productionPaths: string[];
  port: number;
  services?: ComposeService[];
  monorepoApps?: MonorepoApp[];
  monorepoWorkspace?: MonorepoWorkspace;
  rootEnv?: Record<string, string>;
}

function joinProjectPath(rootDirectory: string, name: string): string {
  const normalizedRootDirectory = normalizeProjectRootDirectory(rootDirectory);
  return normalizedRootDirectory ? `${normalizedRootDirectory}/${name}` : name;
}

async function readProjectSnapshot(
  reader: ProjectReader,
  rootDirectory = "",
  source: ProjectRootSnapshotInput["source"] = "root",
): Promise<ProjectRootSnapshotInput> {
  const normalizedRootDirectory = normalizeProjectRootDirectory(rootDirectory);
  const files = await reader.listDirectory(normalizedRootDirectory);
  const packageJson = await reader.readJson(joinProjectPath(normalizedRootDirectory, "package.json"));
  const fileContents: Record<string, string> = {};

  await Promise.all(
    PREPARE_FILE_CONTENTS
      .filter((name) => files.some((file) => file.name.toLowerCase() === name.toLowerCase()))
      .map(async (name) => {
        const content = await reader.readText(joinProjectPath(normalizedRootDirectory, name));
        if (content) {
          fileContents[name] = content;
        }
      }),
  );

  // Workspace manifests with dynamic basenames - PREPARE_FILE_CONTENTS
  // is a static list, but .NET solutions are named per-repo (e.g.
  // `MedicaScopeLMS.sln`) so the lowercase-equality match above would
  // miss them. Without the content here, `detectWorkspaces` finds the
  // filename in `files` but can't pull its body, so workspace
  // discovery (and the whole monorepo flow) silently no-ops.
  await Promise.all(
    files
      .filter((file) => /\.sln$/i.test(file.name))
      .map(async (file) => {
        const content = await reader.readText(joinProjectPath(normalizedRootDirectory, file.name));
        if (content) {
          fileContents[file.name] = content;
        }
      }),
  );

  return {
    rootDirectory: normalizedRootDirectory,
    files,
    packageJson,
    fileContents,
    source,
  };
}

async function loadCandidateSnapshot(
  reader: ProjectReader,
  rootDirectory: string,
  source: ProjectRootSnapshotInput["source"],
): Promise<ProjectRootSnapshotInput | null> {
  const snapshot = await readProjectSnapshot(reader, rootDirectory, source);
  if (!snapshot.rootDirectory || snapshot.files.length === 0) {
    return null;
  }

  return snapshot;
}

interface SelectedProjectSnapshot {
  selected: ProjectRootSnapshot;
  monorepo: { apps: MonorepoApp[]; workspace: MonorepoWorkspace } | null;
}

async function selectProjectSnapshot(
  reader: ProjectReader,
  rootSnapshot: ProjectRootSnapshotInput,
): Promise<SelectedProjectSnapshot> {
  const treeEntries = await reader.listTree().catch(() => [] as RepoTreeEntry[]);
  const hints = discoverProjectRootHints(
    treeEntries,
    rootSnapshot.fileContents,
    rootSnapshot.packageJson,
  );

  const candidates = (await Promise.all(
    hints.map((hint) => loadCandidateSnapshot(reader, hint.rootDirectory, hint.source)),
  )).filter((candidate): candidate is ProjectRootSnapshotInput => Boolean(candidate));

  const selected = applyWorkspaceContext(
    rootSnapshot,
    selectPreferredProjectRoot(rootSnapshot, candidates),
  );
  const monorepo = discoverMonorepoApps(rootSnapshot, candidates);

  return { selected, monorepo };
}

function createGitHubReader(
  userId: string,
  owner: string,
  repo: string,
  branch: string,
): ProjectReader {
  let treePromise: Promise<RepoTreeEntry[]> | null = null;

  const readText = async (path: string) => {
    try {
      const file = await githubService.getFileContent(userId, owner, repo, path, { branch });
      return file?.content;
    } catch {
      return undefined;
    }
  };

  return {
    listDirectory: async (path: string) => {
      try {
        const contents = await githubService.listFiles(userId, owner, repo, {
          branch,
          ...(path ? { path } : {}),
        });

        return Array.isArray(contents)
          ? contents.map((file: any) => ({
              name: file.name,
              type: file.type === "dir" ? "dir" : "file",
            }))
          : [];
      } catch {
        return [];
      }
    },
    readText,
    readJson: async (path: string) => {
      const content = await readText(path);
      if (!content) return undefined;
      try {
        return JSON.parse(content);
      } catch {
        return undefined;
      }
    },
    listTree: async () => {
      if (!treePromise) {
        treePromise = githubService.listRepositoryTree(userId, owner, repo, { branch });
      }
      return treePromise;
    },
  };
}

async function listLocalTree(dirPath: string): Promise<RepoTreeEntry[]> {
  const tree: RepoTreeEntry[] = [];

  const visit = async (absolutePath: string, relativePath = "") => {
    const entries = await readdir(absolutePath, { withFileTypes: true });

    for (const entry of entries) {
      const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory() && isIgnoredRepoPath(nextRelativePath)) {
        continue;
      }

      tree.push({ path: nextRelativePath, type: entry.isDirectory() ? "dir" : "file" });
      if (entry.isDirectory()) {
        await visit(join(absolutePath, entry.name), nextRelativePath);
      }
    }
  };

  await visit(dirPath);
  return tree;
}

function createLocalReader(dirPath: string): ProjectReader {
  let treePromise: Promise<RepoTreeEntry[]> | null = null;

  const absolutePathFor = (path: string) => path ? join(dirPath, path) : dirPath;

  return {
    listDirectory: async (path: string) => {
      try {
        const entries = await readdir(absolutePathFor(path), { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
        }));
      } catch {
        return [];
      }
    },
    readText: async (path: string) => {
      try {
        return await readFile(absolutePathFor(path), "utf-8");
      } catch {
        return undefined;
      }
    },
    readJson: async (path: string) => {
      try {
        return JSON.parse(await readFile(absolutePathFor(path), "utf-8"));
      } catch {
        return undefined;
      }
    },
    listTree: async () => {
      if (!treePromise) {
        treePromise = listLocalTree(dirPath);
      }
      return treePromise;
    },
  };
}

async function readProjectText(
  reader: ProjectReader,
  rootDirectory: string,
  name: string,
): Promise<string | undefined> {
  return reader.readText(joinProjectPath(rootDirectory, name));
}

async function readComposeText(
  reader: ProjectReader,
  rootDirectory: string,
  files: RepoFile[],
): Promise<string | undefined> {
  for (const name of COMPOSE_FILES) {
    if (!files.some((file) => file.name.toLowerCase() === name)) {
      continue;
    }

    const composeContent = await readProjectText(reader, rootDirectory, name);
    if (composeContent) {
      return composeContent;
    }
  }

  return undefined;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve project info from either a GitHub repo or a local filesystem path.
 * Both paths converge on detectStack and return the same ProjectInfo shape.
 */
export async function resolveProjectInfo(input: Source): Promise<ProjectInfo> {
  if (input.source === "github") {
    return resolveFromGitHub(input.userId, input.owner, input.repo, input.branch);
  }

  if (env.CLOUD_MODE) {
    throw new Error("Local project resolution is not available in cloud mode");
  }

  return resolveFromLocal(input.path);
}

// ─── Shared resolver ─────────────────────────────────────────────────────────

type RepoMeta = Parameters<typeof toProjectInfo>[0];

/**
 * Shared resolution pipeline: snapshot → select root → read compose/.env → map.
 * Source-specific work (auth, branch validation, fs stat) lives in the callers.
 */
async function resolveFromReader(
  reader: ProjectReader,
  repoMeta: RepoMeta,
  selectedBranch: string,
): Promise<ProjectInfo> {
  const rootSnapshot = await readProjectSnapshot(reader);
  const { selected, monorepo } = await selectProjectSnapshot(reader, rootSnapshot);
  const [composeContent, composeEnvContent] = await Promise.all([
    readComposeText(reader, selected.rootDirectory, selected.files),
    readProjectText(reader, selected.rootDirectory, ".env"),
  ]);

  return toProjectInfo(repoMeta, selected, composeContent, selectedBranch, composeEnvContent, monorepo);
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

async function resolveFromGitHub(
  userId: string,
  owner: string,
  repo: string,
  branch?: string,
): Promise<ProjectInfo> {
  const repository = await githubService.getRepository(userId, owner, repo, {
    withBranches: true,
  });
  const requestedBranch = branch?.trim();
  const selectedBranch = requestedBranch || repository.default_branch;

  if (requestedBranch) {
    const head = await githubService.getLatestCommit(userId, owner, repo, selectedBranch);
    if (!head) {
      throw new Error(`Branch "${selectedBranch}" was not found for ${owner}/${repo}`);
    }
  }

  return resolveFromReader(
    createGitHubReader(userId, owner, repo, selectedBranch),
    repository,
    selectedBranch,
  );
}

// ─── Local filesystem ────────────────────────────────────────────────────────

async function resolveFromLocal(dirPath: string): Promise<ProjectInfo> {
  const st = await stat(dirPath);
  if (!st.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const reader = createLocalReader(dirPath);
  const rootPackageJson = await reader.readJson("package.json");
  const name = (rootPackageJson?.name as string) ?? basename(dirPath);

  return resolveFromReader(
    reader,
    {
      name,
      full_name: dirPath,
      owner: "local",
      private: true,
      default_branch: "main",
    },
    "main",
  );
}

// ─── Shared mapper ───────────────────────────────────────────────────────────

function toProjectInfo(
  repo: {
    name: string;
    full_name: string;
    owner: string;
    private: boolean;
    default_branch: string;
    selected_branch?: string;
    clone_url?: string;
    html_url?: string;
    branches?: { name: string }[];
  },
  projectRoot: ProjectRootSnapshot,
  composeContent?: string,
  selectedBranch?: string,
  composeEnvContent?: string,
  monorepo?: { apps: MonorepoApp[]; workspace: MonorepoWorkspace } | null,
): ProjectInfo {
  const stack = projectRoot.stack;
  const rootEnv = composeEnvContent ? parseComposeEnvFile(composeEnvContent) : {};

  let services: ComposeService[] | undefined;
  if (composeContent && stack.projectType === "services") {
    try {
      const parsed = parseComposeFile(composeContent, { envFileContent: composeEnvContent });
      services = parsed.services;
    } catch {
      // Invalid YAML - continue without services.
    }
  }

  // Monorepo wins over the single-root projectType: when the root has a workspace
  // manifest AND we found 2+ deployable apps, expose the multi-app flow. The
  // `selected` root provides a single-app fallback if the user chooses to deploy
  // just one.
  const isMonorepo = !services && monorepo && monorepo.apps.length >= 2;
  const projectType: ProjectType = isMonorepo ? "monorepo" : stack.projectType;

  return {
    repository: {
      name: repo.name,
      full_name: repo.full_name,
      owner: { login: repo.owner },
      private: repo.private,
      default_branch: repo.default_branch,
      selected_branch: selectedBranch || repo.default_branch,
      clone_url: repo.clone_url,
      html_url: repo.html_url,
      branches: repo.branches,
    },
    stack: stack.stack,
    projectType,
    category: stack.category,
    packageManager: stack.packageManager,
    buildCommand: stack.buildCommand,
    installCommand: stack.installCommand,
    startCommand: stack.startCommand,
    buildImage: stack.buildImage,
    outputDirectory: stack.outputDirectory,
    rootDirectory: projectRoot.rootDirectory || "./",
    productionPaths: stack.productionPaths,
    port: stack.port,
    ...(services && { services }),
    ...(isMonorepo && monorepo
      ? { monorepoApps: monorepo.apps, monorepoWorkspace: monorepo.workspace }
      : {}),
    ...(Object.keys(rootEnv).length > 0 && { rootEnv }),
  };
}
