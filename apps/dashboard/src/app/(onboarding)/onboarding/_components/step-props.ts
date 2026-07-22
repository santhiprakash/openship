import type { OnboardingState } from "@repo/onboarding";

export interface StepProps {
  state: OnboardingState;
  onUpdate: (patch: Partial<OnboardingState>) => void;
  onNext: () => void;
  onBack?: () => void;
  /** Choose step only: skip the setup and go straight into the app (local mode). */
  onSkip?: () => void;
}
