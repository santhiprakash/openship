"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { Project } from "@/constants/mock";
import ProjectCard from "./components/ProjectCard";
import {
  ProjectFilters,
  buildProjectFilterOptions,
  projectMatchesFilter,
  type ProjectFilter,
} from "./components/ProjectFilters";
import EmptyState from "@/components/overview/EmptyState";
import { ProjectIllustration } from "@/components/overview/ProjectIllustration";
import { projectsApi } from "@/lib/api";
import { useRouter } from "next/navigation";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Plus, Search, Server } from "lucide-react";
import { PageContainer } from "@/components/ui/PageContainer";
import { usePlatform } from "@/context/PlatformContext";

export default function ProjectsPage() {
  const { t } = useI18n();
  const [projects, setProjects] = useState<Project[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<ProjectFilter>({ kind: "all" });
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const { selfHosted } = usePlatform();
  const isLoadingRef = useRef(false);

  useEffect(() => {
    const fetchProjects = async () => {
      if (isLoadingRef.current) return;
      isLoadingRef.current = true;
      setIsLoading(true);
      try {
        const response = await projectsApi.getHome();
        if (response.success && Array.isArray(response.projects)) {
          setProjects(response.projects);
        }
      } catch (error) {
        console.error("Error fetching projects:", error);
      } finally {
        setIsLoading(false);
        isLoadingRef.current = false;
      }
    };
    fetchProjects();
    return () => { isLoadingRef.current = false; };
  }, []);

  // Target filters derived from the loaded projects (Cloud / each server /
  // Local). Show the filter card once there's more than one group to pick
  // from; the right column also carries a "connect a server" CTA when none of
  // the projects deploy to a server, so it's never empty.
  const filterOptions = useMemo(() => buildProjectFilterOptions(projects, t), [projects, t]);
  const showFilterCard = filterOptions.length > 1;
  const hasServers = projects.some((p) => p.deployTarget === "server");

  const filteredProjects = projects.filter((p) => {
    // Apps (catalog-installed: Convex, webmail, …) live under the Apps tab.
    if (p.isApp) return false;
    if (!projectMatchesFilter(p, filter)) return false;
    const q = searchQuery.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.slug.toLowerCase().includes(q) ||
      p.framework.toLowerCase().includes(q)
    );
  });

  return (
    <PageContainer outerClassName="pb-20">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
              {t.dashboard.pages.projects.title}
            </h1>
            <p className="text-sm text-muted-foreground/70 mt-1">
              {isLoading
                ? t.projects.list.loading
                : interpolate(
                    projects.length === 1 ? t.projects.list.countOne : t.projects.list.countOther,
                    { count: String(projects.length) },
                  )}
            </p>
          </div>
          <Link
            href="/library"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 w-full sm:w-auto justify-center"
          >
            <Plus className="size-4" />
            <span>{t.dashboard.pages.projects.createButton}</span>
          </Link>
        </div>

        {isLoading ? (
          <div className="bg-card rounded-2xl border border-border/50">
            <div className="divide-y divide-border/50">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="px-5 py-4 flex items-center gap-4 animate-pulse">
                  <div className="w-10 h-10 bg-muted rounded-xl" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-muted rounded-lg w-32" />
                    <div className="h-3 bg-muted/60 rounded-lg w-48" />
                  </div>
                  <div className="h-6 bg-muted/60 rounded-full w-16" />
                </div>
              ))}
            </div>
          </div>
        ) : projects.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {/* Search — above the columns so the right column starts level
                with the list, not the search box. */}
            {projects.length > 3 && (
              <div className="relative max-w-md mb-4">
                <Search className="absolute start-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder={t.dashboard.pages.projects.searchPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full ps-10 pe-4 py-2.5 bg-card border border-border/50 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20 transition-all text-foreground placeholder:text-muted-foreground"
                />
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
              {/* Left: project list / empty state for the active search + filter */}
              <div className="min-w-0">
                {filteredProjects.length > 0 ? (
                  <div className="bg-card rounded-2xl border border-border/50 divide-y divide-border/50">
                    {filteredProjects.map((project) => (
                      <ProjectCard key={project.id} project={project} />
                    ))}
                  </div>
                ) : (
                  <div className="flex min-h-[380px] flex-col items-center justify-center px-6 py-12 text-center">
                    <ProjectIllustration className="relative mx-auto mb-6 h-40 w-56" />
                    {searchQuery ? (
                      <p className="mx-auto max-w-sm text-sm text-muted-foreground/70">
                        {t.dashboard.pages.projects.noResultsFound.replace("{query}", searchQuery)}
                      </p>
                    ) : (
                      <>
                        <h3 className="mb-2 text-xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
                          {t.projects.list.noTargetProjects}
                        </h3>
                        {/* No CTA button here — the page header already owns the
                            primary "Create Project" action, and the right card
                            owns "Connect a server". This copy just points to both. */}
                        <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground/70">
                          {t.projects.list.noTargetDesc}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Right: filter by deploy target + a server CTA so the column
                  is never empty (e.g. when nothing is deployed to a server). */}
              <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
                {showFilterCard && (
                  <ProjectFilters options={filterOptions} active={filter} onChange={setFilter} />
                )}
                {!hasServers && (
                  <div className="bg-card rounded-2xl border border-border/50 p-5">
                    <div className="w-9 h-9 bg-info-bg rounded-xl flex items-center justify-center mb-3">
                      <Server className="size-[18px] text-info" />
                    </div>
                    <h3 className="font-semibold text-foreground text-sm mb-1">
                      {t.projects.serverCta.title}
                    </h3>
                    <p className="text-xs text-muted-foreground/70 mb-3 leading-relaxed">
                      {t.projects.serverCta.description}
                    </p>
                    {/* SSH servers are a self-hosted/desktop capability — the SaaS
                        can't connect one, so send cloud users to the download page
                        to get the app that can. Self-hosted/desktop use the real flow. */}
                    {selfHosted ? (
                      <Link
                        href="/servers/new"
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-muted/50 text-foreground text-[13px] font-medium transition-colors hover:bg-muted"
                      >
                        <Plus className="size-3.5" />
                        {t.projects.serverCta.button}
                      </Link>
                    ) : (
                      <a
                        href="https://openship.io/download"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-muted/50 text-foreground text-[13px] font-medium transition-colors hover:bg-muted"
                      >
                        <Plus className="size-3.5" />
                        {t.projects.serverCta.button}
                      </a>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
    </PageContainer>
  );
}
