import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Volume2 } from "lucide-react";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { matchSupportedLocale, type SupportedLocale } from "@/i18n/shared";

type DictationSound = "default" | "soft" | "chime" | "none";

const DICTATION_SOUND_OPTIONS: DictationSound[] = [
  "soft",
  "default",
  "chime",
  "none",
];

// Preview samples bundled with the renderer; the actual dictation sounds are
// embedded in the native helper under the same names.
const DICTATION_SOUND_FILES: Record<
  "start" | "stop",
  Record<DictationSound, string | null>
> = {
  start: {
    default: new URL("../../../assets/sounds/rec-start.mp3", import.meta.url)
      .href,
    soft: new URL("../../../assets/sounds/rec-start-soft.wav", import.meta.url)
      .href,
    chime: new URL(
      "../../../assets/sounds/rec-start-chime.wav",
      import.meta.url,
    ).href,
    none: null,
  },
  stop: {
    default: new URL("../../../assets/sounds/rec-stop.mp3", import.meta.url)
      .href,
    soft: new URL("../../../assets/sounds/rec-stop-soft.wav", import.meta.url)
      .href,
    chime: new URL("../../../assets/sounds/rec-stop-chime.wav", import.meta.url)
      .href,
    none: null,
  },
};

function playDictationSoundPreview(kind: "start" | "stop", sound: string) {
  const url = DICTATION_SOUND_FILES[kind][sound as DictationSound];
  if (url) {
    void new Audio(url).play().catch(() => {});
  }
}

export default function PreferencesSettingsPage() {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [selectedLocale, setSelectedLocale] = useState<string>("system");

  // tRPC queries and mutations
  const preferencesQuery = api.settings.getPreferences.useQuery();
  const uiSettingsQuery = api.settings.getUISettings.useQuery();
  const updatePreferencesMutation = api.settings.updatePreferences.useMutation({
    onSuccess: () => {
      toast.success(t("settings.preferences.toast.updated"));
      utils.settings.getPreferences.invalidate();
    },
    onError: (error) => {
      console.error("Failed to update preferences:", error);
      toast.error(t("settings.preferences.toast.updateFailed"));
    },
  });
  const updateUILocaleMutation = api.settings.updateUILocale.useMutation({
    onSuccess: () => {
      utils.settings.getUISettings.invalidate();
      utils.settings.getSettings.invalidate();
      setRestartDialogOpen(true);
    },
    onError: (error) => {
      console.error("Failed to update UI locale:", error);
      toast.error(t("errors.generic"));
      // Revert selection back to persisted value.
      const persisted = uiSettingsQuery.data?.locale ?? null;
      setSelectedLocale(persisted ?? "system");
    },
  });
  const restartAppMutation = api.settings.restartApp.useMutation();

  useEffect(() => {
    const persisted = uiSettingsQuery.data?.locale ?? null;
    setSelectedLocale(persisted ?? "system");
  }, [uiSettingsQuery.data?.locale]);

  const handleLaunchAtLoginChange = (checked: boolean) => {
    updatePreferencesMutation.mutate({
      launchAtLogin: checked,
    });
  };

  const handleShowWidgetWhileInactiveChange = (checked: boolean) => {
    updatePreferencesMutation.mutate({
      showWidgetWhileInactive: checked,
    });
  };

  const handleMinimizeToTrayChange = (checked: boolean) => {
    updatePreferencesMutation.mutate({
      minimizeToTray: checked,
    });
  };

  const handleShowInDockChange = (checked: boolean) => {
    updatePreferencesMutation.mutate({
      showInDock: checked,
    });
  };

  const handleMuteSystemAudioChange = (checked: boolean) => {
    updatePreferencesMutation.mutate({
      muteSystemAudio: checked,
    });
  };

  const handleMuteDictationSoundsChange = (checked: boolean) => {
    updatePreferencesMutation.mutate({
      muteDictationSounds: checked,
    });
  };

  const handleDictationSoundChange = (kind: "start" | "stop", value: string) => {
    updatePreferencesMutation.mutate(
      kind === "start"
        ? { dictationStartSound: value as DictationSound }
        : { dictationStopSound: value as DictationSound },
    );
    playDictationSoundPreview(kind, value);
  };

  const handleLanguageChange = (value: string) => {
    let nextLocale: SupportedLocale | null = null;
    if (value !== "system") {
      const supportedLocale = matchSupportedLocale(value);
      if (!supportedLocale) {
        return;
      }
      nextLocale = supportedLocale;
    }
    setSelectedLocale(nextLocale ?? "system");

    const currentLocale = uiSettingsQuery.data?.locale ?? null;
    if (nextLocale === currentLocale) {
      return;
    }

    updateUILocaleMutation.mutate({ locale: nextLocale });
  };

  const showWidgetWhileInactive =
    preferencesQuery.data?.showWidgetWhileInactive ?? true;
  const minimizeToTray = preferencesQuery.data?.minimizeToTray ?? false;
  const launchAtLogin = preferencesQuery.data?.launchAtLogin ?? true;
  const showInDock = preferencesQuery.data?.showInDock ?? true;
  const muteSystemAudio = preferencesQuery.data?.muteSystemAudio ?? true;
  const muteDictationSounds =
    preferencesQuery.data?.muteDictationSounds ?? false;
  const dictationStartSound =
    preferencesQuery.data?.dictationStartSound ?? "soft";
  const dictationStopSound =
    preferencesQuery.data?.dictationStopSound ?? "soft";
  const isMac = window.electronAPI.platform === "darwin";
  const localeDisabled =
    uiSettingsQuery.isLoading || updateUILocaleMutation.isPending;

  return (
    <div>
      {/* Header Section */}
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t("settings.preferences.title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("settings.preferences.description")}
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-4">
            {/* Launch at Login Section */}
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-base font-medium text-foreground">
                  {t("settings.preferences.launchAtLogin.label")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings.preferences.launchAtLogin.description")}
                </p>
              </div>
              <Switch
                checked={launchAtLogin}
                onCheckedChange={handleLaunchAtLoginChange}
                disabled={updatePreferencesMutation.isPending}
              />
            </div>

            <Separator />

            {/* Minimize to Tray Section */}
            {/* <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-base font-medium text-foreground">
                  Minimize to tray
                </Label>
                <p className="text-xs text-muted-foreground">
                  Keep the application running in the system tray when minimized
                </p>
              </div>
              <Switch
                checked={minimizeToTray}
                onCheckedChange={handleMinimizeToTrayChange}
                disabled={updatePreferencesMutation.isPending}
              />
            </div>

            <Separator /> */}

            {/* Show Widget While Inactive Section */}
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-base font-medium text-foreground">
                  {t("settings.preferences.showWidgetWhileInactive.label")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "settings.preferences.showWidgetWhileInactive.description",
                  )}
                </p>
              </div>
              <Switch
                checked={showWidgetWhileInactive}
                onCheckedChange={handleShowWidgetWhileInactiveChange}
                disabled={updatePreferencesMutation.isPending}
              />
            </div>

            <Separator />

            {/* Show in Dock Section (macOS only) */}
            {isMac && (
              <>
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label className="text-base font-medium text-foreground">
                      {t("settings.preferences.showInDock.label")}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.preferences.showInDock.description")}
                    </p>
                  </div>
                  <Switch
                    checked={showInDock}
                    onCheckedChange={handleShowInDockChange}
                    disabled={updatePreferencesMutation.isPending}
                  />
                </div>

                <Separator />
              </>
            )}

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-base font-medium text-foreground">
                  {t("settings.preferences.muteSystemAudio.label")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings.preferences.muteSystemAudio.description")}
                </p>
              </div>
              <Switch
                checked={muteSystemAudio}
                onCheckedChange={handleMuteSystemAudioChange}
                disabled={
                  updatePreferencesMutation.isPending ||
                  preferencesQuery.isLoading
                }
              />
            </div>

            <Separator />

            {/* Mute dictation sounds */}
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-base font-medium text-foreground">
                  {t("settings.preferences.muteDictationSounds.label")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings.preferences.muteDictationSounds.description")}
                </p>
              </div>
              <Switch
                checked={muteDictationSounds}
                onCheckedChange={handleMuteDictationSoundsChange}
                disabled={
                  updatePreferencesMutation.isPending ||
                  preferencesQuery.isLoading
                }
              />
            </div>

            <Separator />

            {/* Dictation start/stop sounds */}
            {(["start", "stop"] as const).map((kind) => {
              const value =
                kind === "start" ? dictationStartSound : dictationStopSound;
              return (
                <div key={kind}>
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <Label className="text-base font-medium text-foreground">
                        {t(`settings.preferences.dictationSounds.${kind}.label`)}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          `settings.preferences.dictationSounds.${kind}.description`,
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t("settings.preferences.dictationSounds.preview")}
                        onClick={() => playDictationSoundPreview(kind, value)}
                        disabled={value === "none" || muteDictationSounds}
                      >
                        <Volume2 className="h-4 w-4" />
                      </Button>
                      <Select
                        value={value}
                        onValueChange={(next) =>
                          handleDictationSoundChange(kind, next)
                        }
                        disabled={
                          updatePreferencesMutation.isPending ||
                          preferencesQuery.isLoading ||
                          muteDictationSounds
                        }
                      >
                        <SelectTrigger className="w-[180px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DICTATION_SOUND_OPTIONS.map((option) => (
                            <SelectItem key={option} value={option}>
                              {t(
                                `settings.preferences.dictationSounds.options.${option}`,
                              )}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Separator className="mt-4" />
                </div>
              );
            })}

            {/* Language */}
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-base font-medium text-foreground">
                  {t("settings.preferences.language.label")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings.preferences.language.description")}
                </p>
              </div>
              <Select
                value={selectedLocale}
                onValueChange={handleLanguageChange}
                disabled={localeDisabled}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">
                    {t("settings.preferences.language.options.system")}
                  </SelectItem>
                  <SelectItem value="en">
                    {t("settings.preferences.language.options.en")}
                  </SelectItem>
                  <SelectItem value="de">
                    {t("settings.preferences.language.options.de")}
                  </SelectItem>
                  <SelectItem value="es">
                    {t("settings.preferences.language.options.es")}
                  </SelectItem>
                  <SelectItem value="ja">
                    {t("settings.preferences.language.options.ja")}
                  </SelectItem>
                  <SelectItem value="zh-TW">
                    {t("settings.preferences.language.options.zh-TW")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Separator />

            {/* Theme Section */}
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-base font-medium text-foreground">
                  {t("settings.preferences.theme.label")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings.preferences.theme.description")}
                </p>
              </div>
              <ThemeToggle />
            </div>
          </CardContent>
        </Card>

        {/* add future preferences here in a card */}
      </div>

      <AlertDialog open={restartDialogOpen} onOpenChange={setRestartDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.preferences.language.restartDialog.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.preferences.language.restartDialog.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                toast.success(
                  t("settings.preferences.language.toast.applyNextStart"),
                );
              }}
            >
              {t("settings.preferences.language.restartDialog.later")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                toast.info(t("settings.preferences.language.toast.restarting"));
                restartAppMutation.mutate();
              }}
              disabled={restartAppMutation.isPending}
            >
              {t("settings.preferences.language.restartDialog.restartNow")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
