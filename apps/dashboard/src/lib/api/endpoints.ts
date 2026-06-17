/**
 * Single source of truth for every API endpoint path.
 *
 * All route strings live here - never hardcode paths in components,
 * hooks, or context files. Import from `@/lib/api` instead.
 */

export const endpoints = {
  /* ---------------------------------------------------------------- */
  /*  Projects                                                        */
  /* ---------------------------------------------------------------- */
  projects: {
    home: "projects/home",
    item: (id: string | number) => `projects/${id}`,
    local: "projects/local",
    scan: "projects/scan",
    import: "projects/import",
    info: (id: string | number) => `projects/${id}/info`,
    environments: (id: string | number) => `projects/${id}/environments`,
    options: (id: string | number) => `projects/${id}/options`,
    toggle: (id: string | number, action: "enable" | "disable") => `projects/${id}/${action}`,
    clearCache: (id: string | number) => `projects/${id}/clear-cache`,
    clearBuild: (id: string | number) => `projects/${id}/clear-build`,
    deploymentSession: (id: string | number) => `projects/${id}/deployment-session`,
    connect: (id: string | number) => `projects/${id}/connect`,
    env: (id: string | number) => `projects/${id}/env`,
    git: (id: string | number) => `projects/${id}/git`,
    gitLink: (id: string | number) => `projects/${id}/git/link`,
    branches: (id: string | number) => `projects/${id}/branches`,
    branch: (id: string | number) => `projects/${id}/branch`,
    gitSwitch: (id: string | number) => `projects/${id}/git/switch`,
    autoDeploy: (id: string | number) => `projects/${id}/auto-deploy`,
    webhookDomain: (id: string | number) => `projects/${id}/webhook-domain`,
    resources: (id: string | number) => `projects/${id}/resources`,
    cloneToken: (id: string | number) => `projects/${id}/clone-token`,
    sleepMode: (id: string | number) => `projects/${id}/sleep-mode`,
    deployments: (id: string | number) => `projects/${id}/deployments`,
    logs: (id: string | number) => `projects/${id}/logs`,
    logsStream: (id: string | number) => `projects/${id}/logs/stream`,
    serverLogsRecent: (id: string | number) => `projects/${id}/server-logs/recent`,
    serverLogsStreamToken: (id: string | number) => `projects/${id}/server-logs/stream-token`,
    serverLogsStream: (id: string | number) => `projects/${id}/server-logs/stream`,
    ensure: "projects/ensure",
  },

  /* ---------------------------------------------------------------- */
  /*  Services (compose / multi-service projects)                     */
  /* ---------------------------------------------------------------- */
  services: {
    list: (projectId: string | number) => `projects/${projectId}/services`,
    create: (projectId: string | number) => `projects/${projectId}/services`,
    get: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}`,
    update: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}`,
    delete: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}`,
    sync: (projectId: string | number) => `projects/${projectId}/services/sync`,
    containers: (projectId: string | number) => `projects/${projectId}/services/containers`,
    start: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/start`,
    stop: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/stop`,
    restart: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/restart`,
    logs: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/logs`,
    logsStream: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/logs/stream`,
    envGet: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/env`,
    envSet: (projectId: string | number, serviceId: string) =>
      `projects/${projectId}/services/${serviceId}/env`,
  },

  /* ---------------------------------------------------------------- */
  /*  Deploy / Build                                                  */
  /* ---------------------------------------------------------------- */
  deploy: {
    list: "deployments",
    delete: (id: string) => `deployments/${id}`,
    reject: (id: string) => `deployments/${id}/reject`,
    rollback: (id: string) => `deployments/${id}/rollback`,
    cancel: (id: string) => `deployments/${id}/cancel`,
    prepare: "deployments/prepare",
    buildAccess: "deployments/build/access",
    buildStart: (id: string) => `deployments/${id}/build`,
    buildStatus: (id: string) => `deployments/${id}/build`,
    buildRedeploy: (id: string) => `deployments/${id}/redeploy`,
    sslStatus: "deployments/ssl/status",
    sslRenew: "deployments/ssl/renew",
    buildRespond: (id: string) => `deployments/${id}/build/respond`,
  },

  /* ---------------------------------------------------------------- */
  /*  Domains                                                          */
  /* ---------------------------------------------------------------- */
  domains: {
    preview: "domains/preview",
    verify: (id: string) => `domains/${encodeURIComponent(id)}/verify`,
  },

  /* ---------------------------------------------------------------- */
  /*  GitHub                                                          */
  /* ---------------------------------------------------------------- */
  github: {
    userHome: "github/home",
    orgRepos: (owner: string) => `github/orgs/${owner}/repos`,
    userRepos: "github/repos",
    status: "github/status",
    connect: "github/connect",
    connectRedirect: "github/connect/redirect",
    connectPoll: "github/connect/poll",
    disconnect: "github/disconnect",
  },

  /* ---------------------------------------------------------------- */
  /*  Icons                                                           */
  /* ---------------------------------------------------------------- */
  icons: {
    search: "icons/search-icons",
  },

  /* ---------------------------------------------------------------- */
  /*  Image catalog (Oblien)                                          */
  /* ---------------------------------------------------------------- */
  images: {
    list: "images",
  },

  /* ---------------------------------------------------------------- */
  /*  AI                                                              */
  /* ---------------------------------------------------------------- */
  ai: {
    sessionList: "/ai/session/list",
  },

  /* ---------------------------------------------------------------- */
  /*  Analytics                                                       */
  /* ---------------------------------------------------------------- */
  analytics: {
    summary: "analytics",
    periods: "analytics/periods",
    deployments: "analytics/deployments",
    usage: "analytics/usage",
    usageStream: "analytics/usage/stream",
    container: "analytics/container",
    dashboard: "analytics/dashboard",
    server: (serverId: string) => `analytics/server/${serverId}`,
    serverGeo: (serverId: string) => `analytics/server/${serverId}/geo`,
    serverLive: (serverId: string) => `analytics/server/${serverId}/live`,
  },

  /* ---------------------------------------------------------------- */
  /*  System (self-hosted only)                                       */
  /* ---------------------------------------------------------------- */
  system: {
    browse: "system/browse",
    settings: "system/settings",
    onboarding: "system/onboarding",
    testConnection: "system/test-connection",
    check: "system/check",
    install: "system/install",
    remove: "system/remove",
    installStream: "system/install/stream",
    installSession: "system/install/session",
    monitorStream: "system/monitor/stream",
    servers: "system/servers",
    server: (id: string) => `system/servers/${id}`,
    serverRateLimit: (id: string) => `system/servers/${id}/rate-limit`,
  },

  /* ---------------------------------------------------------------- */
  /*  Mail server setup (self-hosted only)                            */
  /* ---------------------------------------------------------------- */
  mail: {
    steps: "mail/steps",
    status: "mail/status",
    servers: "mail/servers",
    setup: "mail/setup",
    cancelSetup: "mail/setup/cancel",
    acknowledgeDns: "mail/setup/dns-ack",
    acknowledgePtr: "mail/setup/ptr-ack",
    resetSetup: "mail/setup/reset",
    setPostmasterPassword: "mail/credentials/postmaster",
    health: (serverId: string) => `mail/health/${encodeURIComponent(serverId)}`,
    portsCheck: "mail/ports/check",
    portsResolve: "mail/ports/resolve",
    admin: {
      domains: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/domains`,
      domain: (serverId: string, domain: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/domains/${encodeURIComponent(domain)}`,
      domainDependents: (serverId: string, domain: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/domains/${encodeURIComponent(domain)}/dependents`,
      domainDns: (serverId: string, domain: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/domains/${encodeURIComponent(domain)}/dns`,
      domainDnsAcknowledge: (serverId: string, domain: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/domains/${encodeURIComponent(domain)}/dns/acknowledge`,
      pendingDomainDns: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/domains-dns/pending`,
      mailboxes: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/mailboxes`,
      mailbox: (serverId: string, email: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/mailboxes/${encodeURIComponent(email)}`,
      stats: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/stats`,
      dnsScan: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/dns-scan`,
      testEmail: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/test-email`,
      componentAction: (serverId: string, key: string, action: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/components/${encodeURIComponent(key)}/${encodeURIComponent(action)}`,
      componentLogs: (serverId: string, key: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/components/${encodeURIComponent(key)}/logs`,
      componentsRestartAll: (serverId: string) =>
        `mail/admin/${encodeURIComponent(serverId)}/components/restart-all`,
    },
    branding: (serverId: string) =>
      `mail/branding/${encodeURIComponent(serverId)}`,
    webmail: {
      targets: "mail/webmail/targets",
      deployProject: "mail/webmail/deploy-project",
    },
  },

  /* ---------------------------------------------------------------- */
  /*  Sandbox                                                         */
  /* ---------------------------------------------------------------- */
  sandbox: {
    resources: (id: string | number) => `sandbox/${id}/resources`,
  },

  /* ---------------------------------------------------------------- */
  /*  Settings (user platform preferences)                            */
  /* ---------------------------------------------------------------- */
  settings: {
    get: "settings",
    upsert: "settings",
    buildMode: "settings/build-mode",
    deployDefaults: "settings/deploy-defaults",
    cloneCredentials: "settings/clone-credentials",
    cloneStrategyPreference: "settings/clone-strategy-preference",
  },

  /* ---------------------------------------------------------------- */
  /*  Notifications (channels, subscriptions, defaults, deliveries)   */
  /* ---------------------------------------------------------------- */
  notifications: {
    categories: "notifications/categories",
    channels: "notifications/channels",
    channel: (id: string) => `notifications/channels/${id}`,
    subscriptions: "notifications/subscriptions",
    subscription: (id: string) => `notifications/subscriptions/${id}`,
    defaults: "notifications/defaults",
    deliveries: "notifications/deliveries",
    unseenCount: "notifications/deliveries/unseen-count",
    markSeen: (id: string) => `notifications/deliveries/${id}/seen`,
  },

  /* ---------------------------------------------------------------- */
  /*  Cloud (Openship Cloud connection - local/self-hosted only)      */
  /* ---------------------------------------------------------------- */
  cloud: {
    disconnect: "cloud/disconnect",
    status: "cloud/status",
  },

  /* ---------------------------------------------------------------- */
  /*  Interactive terminal (xterm.js ↔ WS ↔ ssh2 PTY)                */
  /* ---------------------------------------------------------------- */
  terminal: {
    ticket: "terminal/ticket",
    // The WebSocket path is constructed from getApiBaseUrl() with
    // protocol swap; see lib/api/terminal.ts buildTerminalWsUrl.
    wsPath: (serverId: string) => `terminal/ws/${serverId}`,
  },

  /* ---------------------------------------------------------------- */
  /*  Service terminal (xterm.js ↔ WS ↔ Docker exec OR Oblien shell) */
  /* ---------------------------------------------------------------- */
  serviceTerminal: {
    ticket: "services/terminal/ticket",
    wsPath: (serviceId: string) => `services/terminal/ws/${serviceId}`,
  },

  /* ---------------------------------------------------------------- */
  /*  Backup destinations (per-user)                                  */
  /* ---------------------------------------------------------------- */
  backupDestinations: {
    list: "backup-destinations",
    create: "backup-destinations",
    get: (id: string) => `backup-destinations/${id}`,
    update: (id: string) => `backup-destinations/${id}`,
    delete: (id: string) => `backup-destinations/${id}`,
    preflight: (id: string) => `backup-destinations/${id}/preflight`,
  },

  /* ---------------------------------------------------------------- */
  /*  Backups (policies + runs)                                       */
  /* ---------------------------------------------------------------- */
  backups: {
    listPolicies: (projectId: string | number) =>
      `projects/${projectId}/backup-policies`,
    createPolicy: (projectId: string | number) =>
      `projects/${projectId}/backup-policies`,
    updatePolicy: (policyId: string) => `backup-policies/${policyId}`,
    deletePolicy: (policyId: string) => `backup-policies/${policyId}`,
    runNow: (policyId: string) => `backup-policies/${policyId}/run`,
    listRuns: (projectId: string | number) =>
      `projects/${projectId}/backup-runs`,
    getRun: (runId: string) => `backup-runs/${runId}`,
    protectRun: (runId: string) => `backup-runs/${runId}/protect`,
    prepareRestore: (runId: string) => `backup-runs/${runId}/restore/prepare`,
    applyRestore: (restoreId: string) =>
      `backup-restores/${restoreId}/apply`,
    cancelRestore: (restoreId: string) =>
      `backup-restores/${restoreId}/cancel`,
    getRestore: (restoreId: string) => `backup-restores/${restoreId}`,
  },
} as const;
