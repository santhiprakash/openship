/**
 * @module @/lib/api
 *
 * Centralised API layer for the Openship dashboard.
 *
 * Usage:
 *   import { projectsApi, deployApi, githubApi } from "@/lib/api";
 *   const { projects, numbers } = await projectsApi.getHome();
 */

/* --- Low-level client (rarely needed directly) -------------------- */
export {
	api,
	ApiError,
	getApiErrorMessage,
	isAbortError,
	isNetworkError,
	setNetworkErrorHandler,
	getApiBaseUrl,
} from "./client";
export type { RequestOptions } from "./client";

/* --- Endpoint registry (single source of truth for paths) --------- */
export { endpoints } from "./endpoints";

/* --- Domain services ---------------------------------------------- */
export { projectsApi } from "./projects";
export { deployApi } from "./deploy";
export { domainsApi } from "./domains";
export { tokensApi } from "./tokens";
export type { AccessToken, CreatedAccessToken } from "./tokens";
export { githubApi } from "./github";
export { iconsApi } from "./icons";
export { imagesApi } from "./images";
export type { ImageCatalogEntry, ListImagesResponse } from "./images";
export { aiApi } from "./ai";
export { sandboxApi } from "./sandbox";
export { systemApi } from "./system";
export { migrationApi } from "./migration";
export type {
  DomainChoice,
  PreflightResult,
  StartServerResult,
  StartCloudResult,
  StartTunnelResult,
  SwitchBackResult,
} from "./migration";
export { settingsApi } from "./settings";
export type {
  BuildMode,
  UserSettingsResponse,
  DefaultDeployTarget,
  DeployDefaultsResponse,
  CloneCredentialsState,
  CloneStrategyPreference,
} from "./settings";
export { cloudApi } from "./cloud";
export type { CloudStatus } from "./cloud";
export { servicesApi, serviceKind } from "./services";
export type { Service, ServiceContainer, ServiceEnvVar, ServiceInput } from "./services";
export { mailApi } from "./mail";
export { mailAdminApi } from "./mail-admin";
export type {
  AdminDomain,
  AdminMailbox,
  CreateDomainPayload,
  UpdateDomainPayload,
  CreateMailboxPayload,
  UpdateMailboxPayload,
  DomainDependents,
  AdditionalDomainDnsState,
  MailServerStats,
  DnsCheck,
  DnsCheckStatus,
  DnsScanResult,
  ComponentAction,
  ComponentActionResult,
  ComponentLogs,
  BulkRestartResult,
} from "./mail-admin";
export type {
  MailSetupStep,
  MailStepStatus,
  MailSetupStatus,
  MailCredentials,
  MailWebmailSummary,
  DnsRecord,
  DnsRecords,
  MailSSEEvent,
  PortConflict,
  PortResolution,
  PortUsage,
  MailComponentHealth,
  MailComponentStatus,
  MailComponentDef,
  MailHealthResponse,
  WebmailTargetOption,
} from "./mail";

/* --- Interactive terminal ----------------------------------------- */
export {
  requestTerminalTicket,
  buildTerminalWsUrl,
  TERMINAL_SUBPROTOCOL_PREFIX,
  TERMINAL_RESUME_SUBPROTOCOL_PREFIX,
} from "./terminal";
export type {
  ServerControlMsg,
  ClientControlMsg,
  ReadyMsg,
  ExitMsg,
  ErrorMsg,
  PongMsg,
  ResizeMsg,
  PingMsg,
  TerminalErrorCode,
  TerminalTicketResponse,
} from "./terminal";

/* --- Service terminal --------------------------------------------- */
export {
  requestServiceTerminalTicket,
  buildServiceTerminalWsUrl,
} from "./service-terminal";

/* --- Notifications ------------------------------------------------- */
export { notificationsApi } from "./notifications";
export type {
  NotificationCategory,
  NotificationChannel,
  NotificationSubscription,
  NotificationDefault,
  NotificationDelivery,
  ChannelKind,
  DeliveryStatus,
} from "./notifications";

/* --- Billing ------------------------------------------------------- */
export { billingApi } from "./billing";
export type {
  BillingState,
  CreditPack,
  UsageGroupBy,
  UsageQuery,
  UsageUnits,
  UsageResponse,
  SubscriptionPlanTierId,
  SubscriptionInterval,
} from "./billing";

/* --- Backups ------------------------------------------------------- */
export { backupDestinationsApi, backupsApi } from "./backups";
export type {
  BackupDestinationSummary,
  CreateDestinationInput,
  UpdateDestinationInput,
  BackupPolicy,
  BackupRun,
  BackupRestore,
} from "./backups";

/* --- Auth helpers -------------------------------------------------- */
export { getAuthToken } from "./auth";
