import { useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import {
  FilePlus2,
  FolderPlus,
  Minus,
  ToggleLeft,
  Download,
  Upload,
  ChevronDown,
  ChevronRight,
  Folder,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

interface Snippet {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
}

interface SnippetFolder {
  id: string;
  name: string;
  enabled: boolean;
  snippets: Snippet[];
}

type Library = { folders: SnippetFolder[] };

type Selection =
  | { kind: "folder"; folderId: string }
  | { kind: "snippet"; folderId: string; snippetId: string }
  | null;

/**
 * Clipy-style snippet editor: toolbar, folder tree on the left, content
 * editor on the right. Everything is persisted as the snippetLibrary settings
 * section and shows up under the Cmd+Shift+V paste menu.
 */
export default function SnippetEditorPage() {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const libraryQuery = api.settings.getSnippetLibrary.useQuery();
  const saveMutation = api.settings.setSnippetLibrary.useMutation({
    onError: () => toast.error(t("errors.generic")),
    onSettled: () => utils.settings.getSnippetLibrary.invalidate(),
  });

  const [library, setLibrary] = useState<Library>({ folders: [] });
  const [selection, setSelection] = useState<Selection>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (libraryQuery.data && !loadedRef.current) {
      loadedRef.current = true;
      setLibrary(libraryQuery.data);
    }
  }, [libraryQuery.data]);

  const persist = (next: Library) => {
    setLibrary(next);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveMutation.mutate(next);
    }, 400);
  };

  const selectedFolder = useMemo(
    () =>
      selection
        ? (library.folders.find((f) => f.id === selection.folderId) ?? null)
        : null,
    [library, selection],
  );
  const selectedSnippet = useMemo(
    () =>
      selection?.kind === "snippet"
        ? (selectedFolder?.snippets.find(
            (s) => s.id === selection.snippetId,
          ) ?? null)
        : null,
    [selection, selectedFolder],
  );

  // ── toolbar actions ────────────────────────────────────────────────

  const addFolder = () => {
    const folder: SnippetFolder = {
      id: uuid(),
      name: t("settings.snippetEditor.newFolder"),
      enabled: true,
      snippets: [],
    };
    persist({ folders: [...library.folders, folder] });
    setSelection({ kind: "folder", folderId: folder.id });
  };

  const addSnippet = () => {
    let folderId = selection?.folderId ?? library.folders[0]?.id;
    let folders = library.folders;
    if (!folderId) {
      const folder: SnippetFolder = {
        id: uuid(),
        name: t("settings.snippetEditor.newFolder"),
        enabled: true,
        snippets: [],
      };
      folders = [folder];
      folderId = folder.id;
    }
    const snippet: Snippet = {
      id: uuid(),
      title: t("settings.snippetEditor.newSnippet"),
      content: "",
      enabled: true,
    };
    persist({
      folders: folders.map((folder) =>
        folder.id === folderId
          ? { ...folder, snippets: [...folder.snippets, snippet] }
          : folder,
      ),
    });
    setSelection({ kind: "snippet", folderId, snippetId: snippet.id });
  };

  const removeSelected = () => {
    if (!selection) return;
    if (selection.kind === "folder") {
      persist({
        folders: library.folders.filter((f) => f.id !== selection.folderId),
      });
    } else {
      persist({
        folders: library.folders.map((folder) =>
          folder.id === selection.folderId
            ? {
                ...folder,
                snippets: folder.snippets.filter(
                  (s) => s.id !== selection.snippetId,
                ),
              }
            : folder,
        ),
      });
    }
    setSelection(null);
  };

  const toggleSelected = () => {
    if (!selection) return;
    persist({
      folders: library.folders.map((folder) => {
        if (folder.id !== selection.folderId) return folder;
        if (selection.kind === "folder") {
          return { ...folder, enabled: !folder.enabled };
        }
        return {
          ...folder,
          snippets: folder.snippets.map((s) =>
            s.id === selection.snippetId ? { ...s, enabled: !s.enabled } : s,
          ),
        };
      }),
    });
  };

  const exportLibrary = () => {
    const blob = new Blob([JSON.stringify(library, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "esper-snippets.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importLibrary = (file: File) => {
    void file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as Library;
        if (!Array.isArray(parsed.folders)) throw new Error("bad format");
        // Re-key ids so imports never collide with existing entries.
        const folders = parsed.folders.map((folder) => ({
          id: uuid(),
          name: String(folder.name ?? ""),
          enabled: folder.enabled !== false,
          snippets: (folder.snippets ?? []).map((snippet) => ({
            id: uuid(),
            title: String(snippet.title ?? ""),
            content: String(snippet.content ?? ""),
            enabled: snippet.enabled !== false,
          })),
        }));
        persist({ folders: [...library.folders, ...folders] });
        toast.success(t("settings.snippetEditor.toast.imported"));
      } catch {
        toast.error(t("settings.snippetEditor.toast.importFailed"));
      }
    });
  };

  // ── render ─────────────────────────────────────────────────────────

  const toolbarButton = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    disabled = false,
  ) => (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className="flex h-auto flex-col items-center gap-1 px-3 py-2 text-[11px]"
    >
      {icon}
      {label}
    </Button>
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-bold">
          {t("settings.snippetEditor.title")}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("settings.snippetEditor.description")}
        </p>
      </div>

      <div className="mb-4 flex gap-2">
        {toolbarButton(
          t("settings.snippetEditor.toolbar.addSnippet"),
          <FilePlus2 className="h-4 w-4" />,
          addSnippet,
        )}
        {toolbarButton(
          t("settings.snippetEditor.toolbar.addFolder"),
          <FolderPlus className="h-4 w-4" />,
          addFolder,
        )}
        {toolbarButton(
          t("settings.snippetEditor.toolbar.remove"),
          <Minus className="h-4 w-4" />,
          removeSelected,
          !selection,
        )}
        {toolbarButton(
          t("settings.snippetEditor.toolbar.toggle"),
          <ToggleLeft className="h-4 w-4" />,
          toggleSelected,
          !selection,
        )}
        {toolbarButton(
          t("settings.snippetEditor.toolbar.import"),
          <Download className="h-4 w-4" />,
          () => fileInputRef.current?.click(),
        )}
        {toolbarButton(
          t("settings.snippetEditor.toolbar.export"),
          <Upload className="h-4 w-4" />,
          exportLibrary,
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) importLibrary(file);
            e.target.value = "";
          }}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex min-h-[420px]">
            {/* Folder tree */}
            <div className="w-[260px] shrink-0 overflow-y-auto border-r border-border py-2">
              {library.folders.length === 0 && (
                <p className="px-4 py-6 text-xs text-muted-foreground">
                  {t("settings.snippetEditor.emptyHint")}
                </p>
              )}
              {library.folders.map((folder) => (
                <div key={folder.id}>
                  <button
                    className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-sm ${
                      selection?.kind === "folder" &&
                      selection.folderId === folder.id
                        ? "bg-brand text-brand-foreground"
                        : "hover:bg-muted"
                    } ${folder.enabled ? "" : "opacity-45"}`}
                    onClick={() =>
                      setSelection({ kind: "folder", folderId: folder.id })
                    }
                    onDoubleClick={() =>
                      setCollapsed((c) => ({
                        ...c,
                        [folder.id]: !c[folder.id],
                      }))
                    }
                  >
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        setCollapsed((c) => ({
                          ...c,
                          [folder.id]: !c[folder.id],
                        }));
                      }}
                    >
                      {collapsed[folder.id] ? (
                        <ChevronRight className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <Folder className="h-4 w-4 shrink-0" />
                    <span className="truncate">{folder.name}</span>
                  </button>
                  {!collapsed[folder.id] &&
                    folder.snippets.map((snippet) => (
                      <button
                        key={snippet.id}
                        className={`flex w-full items-center px-3 py-1.5 pl-11 text-sm ${
                          selection?.kind === "snippet" &&
                          selection.snippetId === snippet.id
                            ? "bg-brand text-brand-foreground"
                            : "hover:bg-muted"
                        } ${snippet.enabled && folder.enabled ? "" : "opacity-45"}`}
                        onClick={() =>
                          setSelection({
                            kind: "snippet",
                            folderId: folder.id,
                            snippetId: snippet.id,
                          })
                        }
                      >
                        <span className="truncate">
                          {snippet.title ||
                            t("settings.snippetEditor.untitled")}
                        </span>
                      </button>
                    ))}
                </div>
              ))}
            </div>

            {/* Editor pane */}
            <div className="flex-1 p-4">
              {selection?.kind === "folder" && selectedFolder && (
                <div className="space-y-3">
                  <label className="text-xs text-muted-foreground">
                    {t("settings.snippetEditor.folderName")}
                  </label>
                  <Input
                    value={selectedFolder.name}
                    onChange={(e) =>
                      persist({
                        folders: library.folders.map((f) =>
                          f.id === selectedFolder.id
                            ? { ...f, name: e.target.value }
                            : f,
                        ),
                      })
                    }
                  />
                </div>
              )}
              {selection?.kind === "snippet" && selectedSnippet && (
                <div className="flex h-full flex-col gap-3">
                  <Input
                    value={selectedSnippet.title}
                    placeholder={t("settings.snippetEditor.titlePlaceholder")}
                    onChange={(e) =>
                      persist({
                        folders: library.folders.map((folder) =>
                          folder.id === selection.folderId
                            ? {
                                ...folder,
                                snippets: folder.snippets.map((s) =>
                                  s.id === selectedSnippet.id
                                    ? { ...s, title: e.target.value }
                                    : s,
                                ),
                              }
                            : folder,
                        ),
                      })
                    }
                  />
                  <Textarea
                    className="min-h-[300px] flex-1 font-mono text-sm"
                    value={selectedSnippet.content}
                    placeholder={t(
                      "settings.snippetEditor.contentPlaceholder",
                    )}
                    onChange={(e) =>
                      persist({
                        folders: library.folders.map((folder) =>
                          folder.id === selection.folderId
                            ? {
                                ...folder,
                                snippets: folder.snippets.map((s) =>
                                  s.id === selectedSnippet.id
                                    ? { ...s, content: e.target.value }
                                    : s,
                                ),
                              }
                            : folder,
                        ),
                      })
                    }
                  />
                </div>
              )}
              {!selection && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {t("settings.snippetEditor.selectHint")}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
