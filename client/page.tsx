import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useCanvasHost } from "./canvas-host";

const slugKey = (workspaceId: string) => `design-canvas:page-slug:${workspaceId}`;

/** One design, full size, as paseo shows it in the main area. The thread behind it is found when needed. */
export function DesignPage({ workspaceId, slug }: { workspaceId: string; slug: string }) {
  const nav = useBbNavigate();
  const { hostRef, threadId } = useCanvasHost({
    workspaceId,
    remountKey: `${workspaceId}/${slug}`,
    initialSlug: () => slug,
    preferredThread: null,
    onSlugChange: (next) => {
      if (next) localStorage.setItem(slugKey(workspaceId), next);
    },
  });
  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, width: "100%" }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0, overflow: "hidden" }} />
      {threadId ? (
        <button
          type="button"
          onClick={() => nav.toThread(threadId)}
          style={{ position: "absolute", right: 12, bottom: 12, zIndex: 5, padding: "6px 12px", borderRadius: 8, background: "var(--card)", border: "1px solid var(--border)", color: "var(--foreground)", fontSize: 12, cursor: "pointer" }}
        >
          Open thread
        </button>
      ) : null}
    </div>
  );
}
