"use client";

import React, { useState, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import ProjectSettings from "@/components/import-project/ProjectSettings";
import BuildSettings from "@/components/import-project/BuildSettings";
import DockerSettings from "@/components/import-project/DockerSettings";
import ComposeServices from "@/components/import-project/ComposeServices";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import MonorepoApps from "@/components/import-project/MonorepoApps";
import Sidebar from "./components/Sidebar";
import DeployTargetStep, { DeployTargetSummary, useDesktopTargets } from "./components/DeployTargetStep";
// Clone-strategy gate moved from inline render to a preflight modal
// triggered from <Sidebar>'s handleDeploy. The inline placement was
// wrong (showed before the user clicked Deploy). See
// CloneStrategyNudge.tsx for the hook + modal-content exports.
import { decodeSlug } from "@/utils/repoSlug";
import { useDeployment } from "@/context/DeploymentContext";
import { usesServiceDeployment } from "@/context/deployment/types";
import { usePlatform } from "@/context/PlatformContext";
import SkeletonLoader from "./components/SkeletonLoader";
import ErrorState from "@/components/shared/ErrorState";
import { PageContainer } from "@/components/ui/PageContainer";

interface DeployError {
    type: 'invalid_url' | 'repo_not_found' | 'initialization_failed';
    message: string;
    details?: string;
}

const ProjectName: React.FC = () => {
    const { config, updateConfig } = useDeployment();
    return (
        <div className="bg-card rounded-2xl border border-border/50">
            <div className="px-5 py-5">
                <label className="text-[15px] font-semibold text-foreground mb-2 block">
                    Project Name
                </label>
                <input
                    type="text"
                    value={config.projectName}
                    onChange={(e) => updateConfig({ projectName: e.target.value })}
                    placeholder="my-awesome-project"
                    className="w-full px-4 py-2.5 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                />
                <p className="text-sm text-muted-foreground mt-1.5">
                    A unique identifier for your deployment
                </p>
            </div>
        </div>
    );
};

const DeployRepository: React.FC = () => {
    const params = useParams();
    const slug = params.slug as string;
    const { config, initializeFromRepo, initializeFromLocal } = useDeployment();
    const { deployMode } = usePlatform();
    const searchParams = useSearchParams();
    const force = searchParams.get("force") || undefined;
    const projectId = searchParams.get("projectId") || undefined;
    const branch = searchParams.get("branch") || undefined;
    const isDesktop = deployMode === "desktop";

    // Decode the slug at render time so the skeleton can name the source
    // ("Fetching owner/repo from GitHub") on the very first paint, before the
    // async initialize call resolves.
    const decodedSource = React.useMemo(() => {
        const d = slug ? decodeSlug(slug) : null;
        if (!d) return null;
        if (d.kind === "local") return { kind: "local" as const, path: d.path };
        return {
            kind: "repo" as const,
            owner: d.owner,
            repo: d.repo,
            branch: branch ?? d.branch,
        };
    }, [slug, branch]);

    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<DeployError | null>(null);
    const hasInitialized = useRef<boolean>(false);

    // Desktop-only: resolve available deploy targets (server / cloud)
    const targets = useDesktopTargets();

    // Step: "target" = pick build/deploy target, "config" = project settings
    // Only desktop gets step 1. Non-desktop skips straight to config.
    const [step, setStep] = useState<"target" | "config">(isDesktop ? "target" : "config");

    // Track whether the user explicitly came back to step 1 via the edit
    // affordance. If they did, we must NOT auto-skip past it again - they
    // came here to make a change. Reset to true only on initial mount.
    const autoSkipTargetRef = useRef(true);

    useEffect(() => {
        const initialize = async () => {
            if (hasInitialized.current || !slug) return;
            hasInitialized.current = true;

            const decoded = decodeSlug(slug);

            if (!decoded) {
                setError({
                    type: 'invalid_url',
                    message: 'Invalid Repository URL',
                    details: 'The repository URL format is not recognized. Please check the URL and try again.'
                });
                setLoading(false);
                return;
            }

            let result;
            if (decoded.kind === "local") {
                result = await initializeFromLocal(decoded.path, { projectId });
            } else {
                result = await initializeFromRepo(decoded.owner, decoded.repo, force, {
                    branch: branch ?? decoded.branch,
                    projectId: projectId ?? decoded.projectId,
                });
            }

            if (!result.success) {
                // If build is already in progress, redirect to build page (handled elsewhere)
                if ('buildInProgress' in result && result.buildInProgress) {
                    setLoading(false);
                    return;
                }

                // Handle specific error cases
                if (result.error) {
                    setError({
                        type: result.errorType === 'api_error' ? 'repo_not_found' : 'initialization_failed',
                        message: decoded.kind === 'local' ? 'Failed to Load Project' : 'Failed to Load Repository',
                        details: result.error
                    });
                } else {
                    setError({
                        type: 'initialization_failed',
                        message: decoded.kind === 'local' ? 'Failed to Load Project' : 'Failed to Load Repository',
                        details: decoded.kind === 'local'
                            ? 'We couldn\'t scan this folder. Make sure the path is correct and accessible.'
                            : 'We couldn\'t load this repository. It might be private, doesn\'t exist, or you don\'t have access to it.'
                    });
                }
            }
            
            setLoading(false);
        };

        initialize();
    }, [slug, initializeFromRepo, initializeFromLocal, force, projectId, branch]);

    if (loading) {
        return <SkeletonLoader source={decodedSource} />;
    }

    if (error) {
        return (
            <ErrorState 
                type="repo-not-found" 
                error={{
                    message: error.message,
                    details: error.details
                }}
            />
        );
    }

    if (!config.repo || !config.owner) {
        return null;
    }

    const isServiceDeployment = usesServiceDeployment(config);
    const isMonorepoFlow = config.projectType === "monorepo";
    const isSingleAppFlow =
        !isMonorepoFlow &&
        (config.projectType === "app" || (config.projectType === "services" && !isServiceDeployment));

    return (
        <PageContainer>
                {/* Step 1: Deploy target picker - centered onboarding style (desktop only).
                    Container widens when cloud is picked so the step's right-column
                    power picker fits beside the deploy options without crushing them. */}
                {step === "target" && isDesktop && (
                    <div className="flex items-center justify-center min-h-[calc(100vh-8rem)]">
                        <div
                            className={`w-full ${
                                config.deployTarget === "cloud" ? "max-w-4xl" : "max-w-lg"
                            }`}
                        >
                            <DeployTargetStep
                                targets={targets}
                                autoSkipAllowed={autoSkipTargetRef.current}
                                onContinue={() => setStep("config")}
                            />
                        </div>
                    </div>
                )}

                {/* Step 2: Project configuration */}
                {step === "config" && (
                    <div className="grid lg:grid-cols-[1fr_340px] gap-6">
                        <div className="space-y-5">
                            {/* Target summary bar - click to go back to step 1 (desktop only) */}
                            {isDesktop && (
                                <DeployTargetSummary
                                    deployTarget={config.deployTarget}
                                    buildStrategy={config.buildStrategy}
                                    showBuildStrategy={isSingleAppFlow}
                                    cloudResourceTier={config.cloudResourceTier}
                                    hasServer={config.options.hasServer}
                                    serverName={
                                      config.serverId
                                        ? (targets.servers.find((s) => s.id === config.serverId)?.name ??
                                           targets.servers.find((s) => s.id === config.serverId)?.sshHost ?? null)
                                        : null
                                    }
                                    onEdit={() => {
                                        // User explicitly came back to change something - don't
                                        // auto-skip them past the picker again.
                                        autoSkipTargetRef.current = false;
                                        setStep("target");
                                    }}
                                />
                            )}

                            {/* App flow: framework picker + build settings */}
                            {config.projectType === "app" && (
                                <>
                                    <ProjectSettings />
                                    <BuildSettings />
                                </>
                            )}

                            {/* Docker flow: single Dockerfile, just port */}
                            {config.projectType === "docker" && (
                                <DockerSettings />
                            )}

                            {/* Services flow: shared env + compose parsed services */}
                            {config.projectType === "services" && (
                                <ComposeServices />
                            )}

                            {/* Monorepo flow: workspace header + per-sub-app cards */}
                            {isMonorepoFlow && (
                                <MonorepoApps />
                            )}

                            {/* Global env vars - service-stack (compose with mode="services")
                                and monorepo per-app mode own their own env scoping. In
                                SINGLE-app mode (either compose-single or monorepo-single)
                                the project deploys as one container with one env set, so
                                the global editor renders. */}
                            {!isServiceDeployment &&
                                !(isMonorepoFlow && config.serviceDeploymentMode !== "single") && (
                                <EnvironmentVariables collapsible />
                            )}
                            <ProjectName />
                        </div>
                        <Sidebar />
                    </div>
                )}
        </PageContainer>
    );
};

export default DeployRepository;
