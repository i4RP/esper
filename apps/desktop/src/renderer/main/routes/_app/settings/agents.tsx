import { createFileRoute } from "@tanstack/react-router";

import AgentsSettingsPage from "../../../pages/settings/agents";

export const Route = createFileRoute("/_app/settings/agents")({
  component: AgentsSettingsPage,
});
