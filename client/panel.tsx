import type { ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { type HomeProject, listHome } from "../shared/rpc";
import type { Handoff } from "./open";
import { useCanvasHost } from "./canvas-host";
import { t } from "./i18n";
import { listenHandoff, takeHandoff } from "./open";
import { useCall } from "./rpc";

const slugKey = (threadId: string, workspaceId: string) => `design-canvas:slug:${threadId}:${workspaceId}`;
const targetKey = (threadId: string) => `design-canvas:target:${threadId}`;

/** A design from another workspace, opened in this tab. */
interface Target {
  workspaceId: string;
  slug: string;
}

function readTarget(threadId: string): Target | null {
  try {
    const value = JSON.parse(localStorage.getItem(targetKey(threadId)) ?? "null") as Target | null;
    return value && typeof value.workspaceId === "string" && typeof value.slug === "string" ? value : null;
  } catch {
    return null;
  }
}

export function DesignTab({ threadId, environment }: ExperimentalThreadTabProps) {
  const call = useCall();
  const ownWorkspace = environment?.id ?? null;
  // Phones and tablets get the notice; a narrow desktop window does not.
  const [narrow, setNarrow] = useState(() => window.matchMedia("(pointer: coarse) and (max-width: 640px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse) and (max-width: 640px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const [target, setTarget] = useState<Target | null>(() => readTarget(threadId));
  const [handoff] = useState<Handoff | undefined>(() => takeHandoff(threadId));
  const workspaceId = target?.workspaceId ?? ownWorkspace;

  // Designs in the other workspaces, to open from here.
  const [projects, setProjects] = useState<HomeProject[]>([]);
  useEffect(() => {
    let live = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const home = await call(listHome, {});
        if (live) setProjects(home.projects);
      } catch {
        // The next refresh tries again.
      }
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [call]);
  const ownDirectory = projects.find((project) => project.workspaceId === ownWorkspace)?.directory;
  const others = projects.filter((project) => project.designs.length > 0 && project.workspaceId !== ownWorkspace && project.directory !== ownDirectory);

  const label = (project: HomeProject) => (project.workspace !== project.project ? `${project.project} · ${project.workspace}` : project.project);
  const { hostRef } = useCanvasHost({
    // Other workspaces' designs go in the canvas's own menu, and on its empty card.
    others: () =>
      others
        .filter((project) => project.workspaceId !== workspaceId)
        .flatMap((project) => project.designs.map((design) => ({ group: label(project), title: design.title, open: () => choose(project.workspaceId, design.slug) }))),
    home: () => (target ? { label: t("backToWorkspace"), open: () => choose(null) } : null),
    extrasKey: `${workspaceId}|${others.map((project) => `${project.workspaceId}:${project.designs.map((design) => design.slug).join(",")}`).join(";")}`,
    workspaceId: narrow ? null : workspaceId,
    remountKey: `${workspaceId}/${target?.slug ?? ""}`,
    initialSlug: () => (target ? target.slug : handoff?.kind === "design" ? handoff.slug : localStorage.getItem(slugKey(threadId, workspaceId ?? ""))),
    preferredThread: target ? null : threadId,
    onSlugChange: (slug) => {
      const key = slugKey(threadId, workspaceId ?? "");
      if (slug) localStorage.setItem(key, slug);
      else localStorage.removeItem(key);
    },
    // Designs handed over by the home screen or the agent apply to this workspace's canvas.
    onMount: (handle) => {
      if (target) return;
      const apply = (next: Handoff) => (next.kind === "design" ? handle.select(next.slug) : handle.expectNew(next.known));
      if (handoff?.kind === "new") apply(handoff);
      return listenHandoff(threadId, apply);
    },
  });

  function choose(other: string | null, slug?: string) {
    if (!other || !slug) {
      localStorage.removeItem(targetKey(threadId));
      return setTarget(null);
    }
    const next = { workspaceId: other, slug };
    localStorage.setItem(targetKey(threadId), JSON.stringify(next));
    setTarget(next);
  }

  if (narrow) return <p style={{ padding: 24, color: "var(--muted-foreground)" }}>{t("nativeUnsupported")}</p>;
  if (!workspaceId) return <p style={{ padding: 24, color: "var(--muted-foreground)" }}>This thread has no workspace.</p>;
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0, overflow: "hidden" }} />
    </div>
  );
}
