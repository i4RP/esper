import { useMemo, useCallback, useState } from "react";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import type { FormatterConfig } from "@/types/formatter";
import { useTranslation } from "react-i18next";

import type { ComboboxOption } from "@/components/ui/combobox";
import {
  getModelSelectionKey,
  getSpeechModelSelectionKey,
  resolveStoredModelSelectionValue,
} from "@/utils/model-selection";

interface UseFormattingSettingsReturn {
  // State
  formattingEnabled: boolean;
  selectedModelId: string;
  formattingOptions: ComboboxOption[];

  // Derived booleans
  disableFormattingToggle: boolean;
  hasFormattingOptions: boolean;
  showCloudRequiresSpeech: boolean;
  showCloudRequiresAuth: boolean;
  showCloudReady: boolean;
  showNoLanguageModels: boolean;

  // Handlers
  handleFormattingEnabledChange: (enabled: boolean) => void;
  handleFormattingModelChange: (modelId: string) => void;
  handleCloudLogin: () => Promise<void>;

  // Loading state
  isLoginPending: boolean;
}

export function useFormattingSettings(): UseFormattingSettingsReturn {
  const { t } = useTranslation();
  // tRPC queries
  const formatterConfigQuery = api.settings.getFormatterConfig.useQuery();
  const languageModelsQuery = api.models.getModels.useQuery({
    type: "language",
  });
  const speechModelQuery = api.models.getDefaultModel.useQuery({
    type: "speech",
  });
  const defaultLanguageModelQuery = api.models.getDefaultModel.useQuery({
    type: "language",
  });
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | undefined>(
    undefined,
  );
  const utils = api.useUtils();

  // Use query data directly
  const formatterConfig = formatterConfigQuery.data ?? null;

  // Mutations with optimistic updates
  const setFormatterConfigMutation =
    api.settings.setFormatterConfig.useMutation({
      onMutate: async (newConfig) => {
        // Cancel outgoing refetches
        await utils.settings.getFormatterConfig.cancel();

        // Snapshot previous value
        const previousConfig = utils.settings.getFormatterConfig.getData();

        // Optimistically update
        utils.settings.getFormatterConfig.setData(undefined, newConfig);

        return { previousConfig };
      },
      onError: (error, _newConfig, context) => {
        // Rollback on error
        if (context?.previousConfig) {
          utils.settings.getFormatterConfig.setData(
            undefined,
            context.previousConfig,
          );
        }
        console.error("Failed to save formatting settings:", error);
        toast.error(t("settings.dictation.formatting.toast.saveFailed"));
      },
      onSettled: () => {
        // Refetch to ensure consistency
        utils.settings.getFormatterConfig.invalidate();
      },
    });

  const loginMutation = api.auth.login.useMutation({
    onSuccess: () => {
      toast.info(t("settings.dictation.formatting.toast.loginInBrowser"));
    },
    onError: (error) => {
      console.error("Failed to initiate login:", error);
      toast.error(t("settings.dictation.formatting.toast.loginStartFailed"));
    },
  });

  // Subscriptions
  api.models.onSelectionChanged.useSubscription(undefined, {
    onData: ({ modelType }) => {
      if (modelType === "speech") {
        utils.settings.getFormatterConfig.invalidate();
        utils.models.getDefaultModel.invalidate({ type: "speech" });
      }
    },
    onError: (error) => {
      console.error("Selection changed subscription error:", error);
    },
  });

  api.auth.onAuthStateChange.useSubscription(undefined, {
    onData: (authState) => {
      setIsAuthenticated(authState.isAuthenticated);
    },
    onError: (error) => {
      console.error("Auth state subscription error:", error);
    },
  });

  // Derived values
  const languageModels = languageModelsQuery.data || [];
  const hasLanguageModels = languageModels.length > 0;
  // Esper is local-only: cloud formatting was removed, so only connected
  // language models are offered.
  const cloudFormattingOptionValue = getSpeechModelSelectionKey("amical-cloud");
  const hasFormattingOptions = hasLanguageModels;
  const formattingEnabled = formatterConfig?.enabled ?? false;
  const disableFormattingToggle = !hasFormattingOptions;

  const formattingOptions = useMemo<ComboboxOption[]>(() => {
    return languageModels.map((model) => ({
      value: getModelSelectionKey(
        model.providerInstanceId,
        model.type,
        model.id,
      ),
      label: `${model.name} (${model.provider})`,
    }));
  }, [languageModels]);

  const optionValues = useMemo(() => {
    return new Set(formattingOptions.map((option) => option.value));
  }, [formattingOptions]);

  const selectedModelId = useMemo(() => {
    const preferredModelId =
      formatterConfig?.modelId || defaultLanguageModelQuery.data || "";

    if (optionValues.has(preferredModelId)) {
      return preferredModelId;
    }

    const normalizedSelection = resolveStoredModelSelectionValue(
      languageModels,
      preferredModelId,
      "language",
    );

    return normalizedSelection && optionValues.has(normalizedSelection)
      ? normalizedSelection
      : "";
  }, [
    cloudFormattingOptionValue,
    defaultLanguageModelQuery.data,
    formatterConfig?.modelId,
    languageModels,
    optionValues,
  ]);

  // Inline state conditions (cloud formatting no longer exists)
  const showCloudRequiresSpeech = false;
  const showCloudRequiresAuth = false;
  const showCloudReady = false;
  const showNoLanguageModels = !hasLanguageModels;

  // Handlers
  const handleFormattingEnabledChange = useCallback(
    (enabled: boolean) => {
      const nextConfig: FormatterConfig = {
        enabled,
        modelId: formatterConfig?.modelId,
        fallbackModelId: formatterConfig?.fallbackModelId,
      };
      setFormatterConfigMutation.mutate(nextConfig);
    },
    [formatterConfig, setFormatterConfigMutation],
  );

  const handleFormattingModelChange = useCallback(
    (modelId: string) => {
      if (!modelId) {
        return;
      }

      const currentModelId =
        formatterConfig?.modelId || defaultLanguageModelQuery.data || "";

      if (modelId === currentModelId) {
        return;
      }

      const nextConfig: FormatterConfig = {
        enabled: formatterConfig?.enabled ?? false,
        modelId,
        fallbackModelId: formatterConfig?.fallbackModelId,
      };

      if (modelId !== cloudFormattingOptionValue) {
        nextConfig.fallbackModelId = modelId;
      } else if (
        !nextConfig.fallbackModelId &&
        currentModelId &&
        currentModelId !== cloudFormattingOptionValue
      ) {
        nextConfig.fallbackModelId = currentModelId;
      }

      setFormatterConfigMutation.mutate(nextConfig);
    },
    [
      formatterConfig,
      cloudFormattingOptionValue,
      defaultLanguageModelQuery.data,
      setFormatterConfigMutation,
    ],
  );

  const handleCloudLogin = useCallback(async () => {
    try {
      await loginMutation.mutateAsync();
    } catch {
      // Errors already handled in mutation callbacks
    }
  }, [loginMutation]);

  return {
    // State
    formattingEnabled,
    selectedModelId,
    formattingOptions,

    // Derived booleans
    disableFormattingToggle,
    hasFormattingOptions,
    showCloudRequiresSpeech,
    showCloudRequiresAuth,
    showCloudReady,
    showNoLanguageModels,

    // Handlers
    handleFormattingEnabledChange,
    handleFormattingModelChange,
    handleCloudLogin,

    // Loading state
    isLoginPending: loginMutation.isPending,
  };
}
