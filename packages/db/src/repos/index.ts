export { createUserRepo, type User, type NewUser } from "./user.repo";
export { createSessionRepo, type Session } from "./session.repo";
export { createAccountRepo, type Account } from "./account.repo";
export {
  createGitInstallationRepo,
  type GitInstallation,
  type NewGitInstallation,
} from "./git-installation.repo";
export { createProjectAppRepo, type ProjectApp, type NewProjectApp } from "./project-app.repo";
export {
  createProjectRepo,
  type Project,
  type NewProject,
  type EnvVar,
  type NewEnvVar,
} from "./project.repo";
export {
  createDeploymentRepo,
  type Deployment,
  type NewDeployment,
  type BuildSession,
  type NewBuildSession,
} from "./deployment.repo";
export { createDomainRepo, type Domain, type NewDomain } from "./domain.repo";
export {
  createServiceRepo,
  normalizeRoutingFields,
  type Service,
  type NewService,
  type ServiceDeployment,
  type NewServiceDeployment,
} from "./service.repo";
export { createSettingsRepo, type UserSettings, type NewUserSettings } from "./settings.repo";
export {
  createInstanceSettingsRepo,
  type InstanceSettings,
  type NewInstanceSettings,
} from "./instance-settings.repo";
export { createServerRepo, type Server, type NewServer } from "./server.repo";
export {
  createMailServerRepo,
  type MailServer,
  type NewMailServer,
} from "./mail-server.repo";
export {
  createAnalyticsRepo,
  type ServerAnalyticsRow,
  type NewServerAnalytics,
  type ServerAnalyticsGeoRow,
  type NewServerAnalyticsGeo,
} from "./analytics.repo";
export {
  createTerminalSessionRepo,
  type TerminalSession,
  type NewTerminalSession,
  type TerminalExitReason,
} from "./terminal-session.repo";
export {
  createServiceTerminalSessionRepo,
  type ServiceTerminalSession,
  type NewServiceTerminalSession,
} from "./service-terminal-session.repo";
export {
  createCloudHandoffCodeRepo,
  type HandoffUserData,
  type HandoffCodeRow,
} from "./cloud-handoff-code.repo";
export {
  createBackupDestinationRepo,
  createBackupPolicyRepo,
  createBackupRunRepo,
  createBackupRestoreRepo,
  type BackupDestination,
  type NewBackupDestination,
  type BackupPolicy,
  type NewBackupPolicy,
  type BackupRun,
  type NewBackupRun,
  type BackupRestore,
  type NewBackupRestore,
  type BackupRunStatus,
  type BackupRestoreStatus,
} from "./backup.repo";
export { createMemberRepo, type Member, type MemberRole } from "./member.repo";
export { createInvitationRepo, type Invitation } from "./invitation.repo";
export { createAuditEventRepo, type AuditEvent, type NewAuditEvent } from "./audit-event.repo";
export {
  createResourceGrantRepo,
  type ResourceGrant,
  type Permission,
  type ResourceType,
} from "./resource-grant.repo";
export { createOrganizationRepo, type Organization } from "./organization.repo";
export {
  createInvitationPendingGrantRepo,
  type InvitationPendingGrant,
} from "./invitation-pending-grant.repo";
export {
  createNotificationChannelRepo,
  createNotificationSubscriptionRepo,
  createNotificationDefaultRepo,
  createNotificationDeliveryRepo,
  type NotificationChannel,
  type NotificationSubscription,
  type NotificationDefault,
  type NotificationDelivery,
  type ChannelKind,
  type DeliveryStatus,
} from "./notification.repo";

// ─── Convenience: pre-bound repos using the singleton db ─────────────────────

import { db } from "../client";
import { createUserRepo } from "./user.repo";
import { createSessionRepo } from "./session.repo";
import { createAccountRepo } from "./account.repo";
import { createGitInstallationRepo } from "./git-installation.repo";
import { createProjectAppRepo } from "./project-app.repo";
import { createProjectRepo } from "./project.repo";
import { createDeploymentRepo } from "./deployment.repo";
import { createDomainRepo } from "./domain.repo";
import { createServiceRepo } from "./service.repo";
import { createSettingsRepo } from "./settings.repo";
import { createInstanceSettingsRepo } from "./instance-settings.repo";
import { createServerRepo } from "./server.repo";
import { createMailServerRepo } from "./mail-server.repo";
import { createAnalyticsRepo } from "./analytics.repo";
import { createTerminalSessionRepo } from "./terminal-session.repo";
import { createServiceTerminalSessionRepo } from "./service-terminal-session.repo";
import { createCloudHandoffCodeRepo } from "./cloud-handoff-code.repo";
import {
  createBackupDestinationRepo,
  createBackupPolicyRepo,
  createBackupRunRepo,
  createBackupRestoreRepo,
} from "./backup.repo";
import { createMemberRepo } from "./member.repo";
import { createInvitationRepo } from "./invitation.repo";
import { createAuditEventRepo } from "./audit-event.repo";
import { createResourceGrantRepo } from "./resource-grant.repo";
import { createInvitationPendingGrantRepo } from "./invitation-pending-grant.repo";
import { createOrganizationRepo } from "./organization.repo";
import {
  createNotificationChannelRepo,
  createNotificationSubscriptionRepo,
  createNotificationDefaultRepo,
  createNotificationDeliveryRepo,
} from "./notification.repo";

/**
 * Pre-bound repository instances using the singleton `db`.
 *
 * Usage:
 *   import { repos } from "@repo/db";
 *   const user = await repos.user.findByEmail("test@example.com");
 *
 * For testing, create isolated repos with `createUserRepo(testDb)` etc.
 */
export const repos = {
  user: createUserRepo(db),
  session: createSessionRepo(db),
  account: createAccountRepo(db),
  gitInstallation: createGitInstallationRepo(db),
  projectApp: createProjectAppRepo(db),
  project: createProjectRepo(db),
  deployment: createDeploymentRepo(db),
  domain: createDomainRepo(db),
  service: createServiceRepo(db),
  settings: createSettingsRepo(db),
  instanceSettings: createInstanceSettingsRepo(db),
  server: createServerRepo(db),
  mailServer: createMailServerRepo(db),
  analytics: createAnalyticsRepo(db),
  terminalSession: createTerminalSessionRepo(db),
  serviceTerminalSession: createServiceTerminalSessionRepo(db),
  cloudHandoffCode: createCloudHandoffCodeRepo(db),
  backupDestination: createBackupDestinationRepo(db),
  backupPolicy: createBackupPolicyRepo(db),
  backupRun: createBackupRunRepo(db),
  backupRestore: createBackupRestoreRepo(db),
  member: createMemberRepo(db),
  invitation: createInvitationRepo(db),
  auditEvent: createAuditEventRepo(db),
  resourceGrant: createResourceGrantRepo(db),
  invitationPendingGrant: createInvitationPendingGrantRepo(db),
  organization: createOrganizationRepo(db),
  notificationChannel: createNotificationChannelRepo(db),
  notificationSubscription: createNotificationSubscriptionRepo(db),
  notificationDefault: createNotificationDefaultRepo(db),
  notificationDelivery: createNotificationDeliveryRepo(db),
} as const;
