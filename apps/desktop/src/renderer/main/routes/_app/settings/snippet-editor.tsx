import { createFileRoute } from "@tanstack/react-router";
import SnippetEditorPage from "../../../pages/settings/snippet-editor";

export const Route = createFileRoute("/_app/settings/snippet-editor")({
  component: SnippetEditorPage,
});
