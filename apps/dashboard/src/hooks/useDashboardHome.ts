import { useState, useEffect, useRef } from "react";
import { projectsApi } from "@/lib/api";
import { type Project } from "@/constants/mock";

interface DashboardNumbers {
  total_active_projects?: number;
  total_deployments?: number;
  total_success_deployments?: number;
  total_failed_deployments?: number;
}

/**
 * Surfaced from the API when the active org has zero visible projects.
 * Lets the dashboard show a "your projects are in [Other Org]" CTA
 * instead of just an empty state — the common "I deployed but it's
 * not here" symptom of a session that switched orgs.
 */
export interface OtherOrgHint {
  organizationId: string;
  name: string;
  projectCount: number;
}

export function useDashboardHome(initialData?: any) {
  const [projects, setProjects] = useState<Project[]>(initialData?.projects || []);
  const [numbers, setNumbers] = useState<DashboardNumbers>(initialData?.numbers || {});
  const [otherOrgs, setOtherOrgs] = useState<OtherOrgHint[]>(initialData?.otherOrgs || []);
  const [loading, setLoading] = useState(!initialData);
  const initRef = useRef(false);

  useEffect(() => {
    // If we already have SSR initialData, no need to fetch!
    if (initialData) return;

    if (initRef.current) return;
    initRef.current = true;

    (async () => {
      try {
        const res = await projectsApi.getHome();
        setNumbers(res.numbers ?? {});
        if (res.success && Array.isArray(res.projects)) {
          setProjects(res.projects);
        }
        const maybeOther = (res as unknown as { otherOrgs?: OtherOrgHint[] }).otherOrgs;
        if (Array.isArray(maybeOther)) {
          setOtherOrgs(maybeOther);
        }
      } catch {
        /* silent */
      } finally {
        setLoading(false);
      }
    })();
  }, [initialData]);

  return { projects, numbers, otherOrgs, loading };
}
