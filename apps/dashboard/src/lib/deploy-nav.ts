/**
 * Shared post-trigger navigation for deploys. After `deployApi.trigger(...)`
 * kicks a new deployment, callers land on the build screen for that version
 * (where progress + the edge-takeover prompt render), or the deployments list
 * if the server didn't return an id. One place for the trigger→/build idiom so
 * the Redeploy button and the domain-add auto-deploy can't drift.
 */

/** The new deployment id from a `deployApi.trigger()` response, if present. */
export function triggeredDeploymentId(res: unknown): string | undefined {
  return (res as { data?: { deployment?: { id?: string } } })?.data?.deployment?.id;
}

/** Navigate to the new build's screen, or the project's deployments list. */
export function openTriggeredBuild(
  router: { push: (href: string) => void },
  res: unknown,
  projectId: string,
): void {
  const id = triggeredDeploymentId(res);
  router.push(id ? `/build/${id}` : `/projects/${projectId}/deployments`);
}
