// Design Canvas frontend: a Design tab in every thread and a Design home page. The canvas itself
// is ported from the paseo design-canvas plugin (MIT); see LICENSE.
import {
  definePluginApp,
  experimental_useAppPanel as useAppPanel,
  useBbContext,
  useBbNavigate,
  useRealtime,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { DesignHome } from "./client/home";
import { DesignPage } from "./client/page";
import { OPEN_HOME_EVENT, OPEN_TAB_EVENT, TAB_ID } from "./client/open";
import { DesignTab } from "./client/panel";

const TAB = { id: TAB_ID, context: { kind: "thread" }, availability: "fixed" } as const;

/**
 * Shows this thread's Design tab when asked: by the home screen, or by the agent drawing a design or
 * running /canvas. It sits in the composer's banner slot, which every thread view mounts, because the
 * panel controller only works from inside the thread's own surface. It draws nothing.
 */
function TabOpener() {
  const panel = useAppPanel();
  const { threadId: showing } = useBbContext();
  const latest = useRef(panel);
  latest.current = panel;

  const open = useCallback(() => {
    const deadline = Date.now() + 5000;
    const attempt = () => {
      if (latest.current.openTab({ tab: TAB })) return;
      if (Date.now() < deadline) setTimeout(attempt, 150);
      else toast("Couldn't open the Design tab. Open it from the panel.");
    };
    attempt();
  }, []);

  useEffect(() => {
    if (!showing) return;
    const onOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail === showing) open();
    };
    window.addEventListener(OPEN_TAB_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TAB_EVENT, onOpen);
  }, [open, showing]);

  useRealtime("design-canvas:open", (payload: unknown) => {
    if (showing && (payload as { threadId?: string } | null)?.threadId === showing) open();
  });
  return null;
}

/** Takes the user to the Design home when a command asks. */
function HomeOpener() {
  const nav = useBbNavigate();
  useEffect(() => {
    const onHome = () => nav.toPluginPanel("design");
    window.addEventListener(OPEN_HOME_EVENT, onHome);
    return () => window.removeEventListener(OPEN_HOME_EVENT, onHome);
  }, [nav]);
  return null;
}

/** /plugins/design-canvas/design is the home; <workspace>/<design> after it is one design at full size. */
function DesignRoot({ subPath }: { subPath: string }) {
  const [workspaceId, slug] = subPath.split("/").map((part) => decodeURIComponent(part));
  return workspaceId && slug ? <DesignPage key={`${workspaceId}/${slug}`} workspaceId={workspaceId} slug={slug} /> : <DesignHome />;
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: TAB_ID,
    title: "Design",
    icon: "Palette",
    layout: "flush",
    component: DesignTab,
  });
  app.slots.navPanel({
    id: "design",
    title: "Design",
    icon: "Palette",
    path: "design",
    component: DesignRoot,
  });
  app.slots.experimental_appOverlay({ id: "home-opener", component: HomeOpener });
  app.composer.customize({ id: "design-tab-opener", banners: [{ id: "tab-opener", chrome: "bare", component: TabOpener }] });
  app.commands.register({
    id: "open-canvas",
    title: "Open the design canvas",
    isAvailable: (context) => context.threadId !== null,
    run: ({ experimental_panel }) => {
      experimental_panel.openTab({ tab: TAB });
    },
  });
  app.commands.register({
    id: "open-home",
    title: "Open the Design home",
    run: () => {
      window.dispatchEvent(new Event(OPEN_HOME_EVENT));
    },
  });
});
