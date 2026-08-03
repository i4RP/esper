import { useEffect, useState } from "react";
import { api } from "@/trpc/react";
import { Mic, Accessibility, Check, MoonStar } from "lucide-react";
import { OnboardingLayout } from "../shared/OnboardingLayout";
import { InfoRow, SkipPill } from "../shared/ui";
import { NavigationButtons } from "../shared/NavigationButtons";
import { OnboardingScreen } from "../../../../types/onboarding";
import { useTranslation } from "react-i18next";

interface PermissionsScreenProps {
  onNext: () => void;
  onBack: () => void;
  permissions: {
    microphone: "granted" | "denied" | "not-determined";
    accessibility: boolean;
  };
  platform: string;
  checkPermissions: () => Promise<void>;
}

/**
 * Permissions screen - handles microphone and accessibility permissions.
 * Rebuilt to the locked mock: icon tile + copy + a status
 * pill (Granted) or a pending "Grant" affordance that drives the real
 * request/openSettings flow. Real polling/request logic is preserved.
 */
export function PermissionsScreen({
  onNext,
  onBack,
  permissions,
  platform,
  checkPermissions,
}: PermissionsScreenProps) {
  const { t } = useTranslation();
  const [isRequestingMic, setIsRequestingMic] = useState(false);

  // tRPC mutations
  const requestMicPermission =
    api.onboarding.requestMicrophonePermission.useMutation();
  const sleepGuardQuery = api.onboarding.checkSleepGuard.useQuery(undefined, {
    enabled: platform === "darwin",
  });
  const installSleepGuard = api.onboarding.installSleepGuard.useMutation({
    onSettled: () => {
      void sleepGuardQuery.refetch();
    },
  });
  const openExternal = api.onboarding.openExternal.useMutation();

  const allPermissionsGranted =
    permissions.microphone === "granted" &&
    (permissions.accessibility || platform !== "darwin");

  // Poll for permission changes continuously to keep UI in sync
  useEffect(() => {
    // Always poll to detect permission changes in real-time
    const interval = setInterval(async () => {
      await checkPermissions();
    }, 2000);

    return () => {
      clearInterval(interval);
    };
  }, [checkPermissions]);

  const handleRequestMicrophone = async () => {
    setIsRequestingMic(true);
    try {
      await requestMicPermission.mutateAsync();
      await checkPermissions();
    } finally {
      setIsRequestingMic(false);
    }
  };

  const handleOpenAccessibility = async () => {
    // Open System Preferences > Security & Privacy > Privacy > Accessibility
    await openExternal.mutateAsync({
      url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    });
  };

  const handleOpenMicrophoneSettings = async () => {
    // Open platform-specific microphone privacy settings
    const url =
      platform === "darwin"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        : "ms-settings:privacy-microphone";
    await openExternal.mutateAsync({ url });
  };

  const grantedPill = (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600/10 px-3 py-1.5 text-[13px] font-semibold text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400">
      <Check size={14} />
      {t("onboarding.permissions.status.granted")}
    </span>
  );

  // Microphone action: request when not-yet-determined, otherwise open settings.
  const handleMicAction =
    permissions.microphone === "not-determined"
      ? handleRequestMicrophone
      : handleOpenMicrophoneSettings;
  const micActionLabel = isRequestingMic
    ? t("onboarding.permissions.actions.requesting")
    : permissions.microphone === "not-determined"
      ? t("onboarding.permissions.actions.request")
      : t("onboarding.permissions.actions.openSettings");

  return (
    <OnboardingLayout
      screen={OnboardingScreen.Permissions}
      title={t("onboarding.permissions.title")}
      subtitle={t("onboarding.permissions.subtitle")}
      footer={
        // Permissions are not gated: a re-signed build resets macOS's grants,
        // and blocking here would strand the user on this screen with no way
        // forward. They can be granted later from Settings.
        <div className="flex w-full flex-col items-end gap-2">
          {!allPermissionsGranted && (
            <p className="text-[13px] text-muted-foreground">
              {t("onboarding.permissions.skipHint")}
            </p>
          )}
          <NavigationButtons onBack={onBack} onNext={onNext} />
        </div>
      }
    >
      <div className="flex w-full max-w-[560px] animate-ob-rise flex-col gap-[11px]">
        <InfoRow
          className="gap-[15px] px-[19px] py-[17px]"
          tileClassName="size-[38px]"
          icon={<Mic size={20} />}
          title={t("onboarding.permissions.microphone.title")}
          description={t("onboarding.permissions.microphone.description")}
          trailing={
            permissions.microphone === "granted" ? (
              grantedPill
            ) : (
              <SkipPill
                onClick={() => void handleMicAction()}
                disabled={isRequestingMic}
              >
                {micActionLabel}
              </SkipPill>
            )
          }
        />

        {/* Accessibility (macOS only) */}
        {platform === "darwin" && (
          <InfoRow
            className="gap-[15px] px-[19px] py-[17px]"
            tileClassName="size-[38px]"
            icon={<Accessibility size={20} />}
            title={t("onboarding.permissions.accessibility.title")}
            description={t("onboarding.permissions.accessibility.description")}
            trailing={
              permissions.accessibility ? (
                grantedPill
              ) : (
                <SkipPill onClick={() => void handleOpenAccessibility()}>
                  {t("onboarding.permissions.actions.openSettings")}
                </SkipPill>
              )
            }
          />
        )}

        {/* Caps Lock sleep guard (macOS only, optional — does not gate Next) */}
        {platform === "darwin" && (
          <InfoRow
            className="gap-[15px] px-[19px] py-[17px]"
            tileClassName="size-[38px]"
            icon={<MoonStar size={20} />}
            title={t("onboarding.permissions.sleepGuard.title")}
            description={t("onboarding.permissions.sleepGuard.description")}
            trailing={
              sleepGuardQuery.data ? (
                grantedPill
              ) : (
                <SkipPill
                  onClick={() => installSleepGuard.mutate()}
                  disabled={installSleepGuard.isPending}
                >
                  {installSleepGuard.isPending
                    ? t("onboarding.permissions.actions.requesting")
                    : t("onboarding.permissions.sleepGuard.install")}
                </SkipPill>
              )
            }
          />
        )}
      </div>
    </OnboardingLayout>
  );
}
