"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Check, X } from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { api } from "@/lib/api";

type InviteState =
  | { kind: "loading" }
  | { kind: "needs-login"; email?: string; organizationName?: string }
  | { kind: "ready"; email: string; organizationName: string; role: string }
  | { kind: "accepting" }
  | { kind: "accepted"; organizationId: string; organizationName: string }
  | { kind: "error"; message: string };

/**
 * Module-level singleton — see TeamTab for the proxy-ref explanation.
 */
const orgClient = (authClient as unknown as {
  organization: {
    getInvitation: (opts: { id: string }) => Promise<{ data?: { invitation: { email: string; role: string; status: string }; organization: { id: string; name: string } }; error?: { message?: string } }>;
    acceptInvitation: (opts: { invitationId: string }) => Promise<{ data?: { invitation: { organizationId: string }; member?: unknown }; error?: { message?: string } }>;
    rejectInvitation: (opts: { invitationId: string }) => Promise<{ error?: { message?: string } }>;
  };
}).organization;

export default function AcceptInvitePage() {
  const params = useParams();
  const router = useRouter();
  const { data: session, isPending: sessionLoading } = useSession();
  const [state, setState] = useState<InviteState>({ kind: "loading" });

  const inviteId = String(params.id);

  useEffect(() => {
    if (sessionLoading) return;

    (async () => {
      try {
        const res = await orgClient.getInvitation({ id: inviteId });
        if (res.error) {
          setState({ kind: "error", message: res.error.message ?? "Invalid invitation" });
          return;
        }
        const { invitation, organization } = res.data!;
        if (invitation.status !== "pending") {
          setState({
            kind: "error",
            message: `This invitation is ${invitation.status}.`,
          });
          return;
        }
        if (!session?.user) {
          setState({
            kind: "needs-login",
            email: invitation.email,
            organizationName: organization.name,
          });
          return;
        }
        if (session.user.email !== invitation.email) {
          setState({
            kind: "error",
            message: `This invite is for ${invitation.email}. You're logged in as ${session.user.email}.`,
          });
          return;
        }
        setState({
          kind: "ready",
          email: invitation.email,
          organizationName: organization.name,
          role: invitation.role,
        });
      } catch (err) {
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load invitation",
        });
      }
    })();
  }, [inviteId, session, sessionLoading]);

  const handleAccept = async () => {
    setState({ kind: "accepting" });
    const res = await orgClient.acceptInvitation({ invitationId: inviteId });
    if (res.error || !res.data) {
      setState({
        kind: "error",
        message: res.error?.message ?? "Failed to accept invitation",
      });
      return;
    }

    // Materialize any pending grants attached to this invitation. The
    // backend stored these at invite-with-grants time; we call the
    // materialize endpoint to write them as resource_grant rows scoped
    // to the new member's userId. Best-effort: if it fails we don't
    // block the accept — the user still becomes a member, they'll just
    // need an admin to add grants manually. Uses the api client so the
    // request targets the API origin (not the dashboard origin) in dev.
    try {
      await api.post(
        `permissions/invitations/${encodeURIComponent(inviteId)}/materialize`,
      );
    } catch (err) {
      console.warn("[accept-invite] materialize failed (continuing):", err);
    }

    setState({
      kind: "accepted",
      organizationId: res.data.invitation.organizationId,
      organizationName: "the organization",
    });
    setTimeout(() => router.push("/"), 1500);
  };

  const handleReject = async () => {
    await orgClient.rejectInvitation({ invitationId: inviteId });
    router.push("/");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-2xl border border-border/50 bg-card p-6 space-y-5">
        {state.kind === "loading" || sessionLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : state.kind === "needs-login" ? (
          <>
            <div>
              <h1 className="text-xl font-semibold text-foreground">You're invited</h1>
              <p className="text-sm text-muted-foreground mt-2">
                Join <strong>{state.organizationName}</strong> on Openship. Sign in or create an
                account with <strong>{state.email}</strong> to accept.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Link
                href={`/auth/signin?redirect=${encodeURIComponent(`/accept-invite/${inviteId}`)}`}
                className="block w-full text-center py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                Sign in
              </Link>
              <Link
                href={`/auth/signup?email=${encodeURIComponent(state.email || "")}&redirect=${encodeURIComponent(`/accept-invite/${inviteId}`)}`}
                className="block w-full text-center py-2.5 border border-border/50 rounded-xl text-sm font-medium hover:bg-muted/40 transition-colors"
              >
                Create account
              </Link>
            </div>
          </>
        ) : state.kind === "ready" ? (
          <>
            <div>
              <h1 className="text-xl font-semibold text-foreground">
                Join {state.organizationName}
              </h1>
              <p className="text-sm text-muted-foreground mt-2">
                You've been invited to join <strong>{state.organizationName}</strong> as a{" "}
                <strong>{state.role}</strong>.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleReject}
                className="flex-1 py-2.5 border border-border/50 rounded-xl text-sm font-medium hover:bg-muted/40 transition-colors"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={handleAccept}
                className="flex-1 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                Accept
              </button>
            </div>
          </>
        ) : state.kind === "accepting" ? (
          <div className="flex items-center justify-center py-8 gap-3 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            Joining organization...
          </div>
        ) : state.kind === "accepted" ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <Check className="size-6 text-emerald-500" />
            </div>
            <p className="text-base font-medium text-foreground">You're in</p>
            <p className="text-sm text-muted-foreground">Redirecting to the dashboard...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <X className="size-6 text-destructive" />
            </div>
            <p className="text-base font-medium text-foreground">Can't accept this invite</p>
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <Link
              href="/"
              className="mt-2 text-sm font-medium text-primary hover:underline"
            >
              Back to dashboard
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
