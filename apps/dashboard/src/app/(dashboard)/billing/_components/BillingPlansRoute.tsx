"use client";

import { useEffect, useState } from "react";
import { PricingCards, type ApiPlan } from "@/components/billing/PricingCards";
import { api } from "@/lib/api/client";
import { endpoints } from "@/lib/api/endpoints";
import type { PlanTierId } from "@repo/core";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

interface PlansResponse {
  data: { plans: ApiPlan[] };
}

interface CheckoutResponse {
  data: { checkoutUrl: string };
}

export function BillingPlansRoute({ currentPlan }: { currentPlan: PlanTierId }) {
  const { t } = useI18n();
  const [plans, setPlans] = useState<ApiPlan[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchPlans() {
      try {
        const res = await api.get<PlansResponse>(endpoints.billing.plans);
        if (!cancelled) setPlans(res.data.plans);
      } catch {
        if (!cancelled) setError(t.billing.plansRoute.loadError);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchPlans();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectPlan = async (planTierId: PlanTierId) => {
    if (planTierId === "free" || planTierId === currentPlan) return;
    setSubscribing(planTierId);
    try {
      // Body key MUST be `planTierId` — the backend `createSubscriptionSchema`
      // validates that exact field (the old `planId` silently 400'd).
      const res = await api.post<CheckoutResponse>("billing/subscription", {
        planTierId,
        interval: "monthly",
      });
      window.location.href = res.data.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : t.billing.plansRoute.checkoutError);
      setSubscribing(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !plans) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">{error || t.billing.plansRoute.genericError}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 text-sm font-medium text-primary hover:underline"
        >
          {t.billing.plansRoute.tryAgain}
        </button>
      </div>
    );
  }

  return (
    <PricingCards
      plans={plans}
      currentPlan={currentPlan}
      onSelectPlan={handleSelectPlan}
      subscribingPlan={subscribing}
    />
  );
}
