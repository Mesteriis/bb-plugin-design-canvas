import { useEffect, useMemo, useRef, useState } from "react";
import { findThread, threadStatus } from "../shared/rpc";
import { agentStatus, canvasApi } from "./api";
import { type CanvasHandle, mountCanvas, type Translate } from "./canvas";
import { t } from "./i18n";
import { useCall } from "./rpc";
import { BB_THEME } from "./styles";

export interface CanvasHostOptions {
  workspaceId: string | null;
  /** Changing this mounts the canvas again, as when another workspace or design is chosen. */
  remountKey: string;
  /** The design shown when the canvas mounts. */
  initialSlug(): string | null;
  /** The thread messages go to, when there is one already. */
  preferredThread: string | null;
  onSlugChange(slug: string | null): void;
  /** Called with the mounted canvas; return a cleanup. */
  onMount?(handle: CanvasHandle): void | (() => void);
  /** Designs in other workspaces to offer in the canvas's menu, and the way back to this one's. */
  others?(): { group: string; title: string; open(): void }[];
  home?(): { label: string; open(): void } | null;
  /** Changes when the offered designs do, so the canvas redraws them. */
  extrasKey?: string;
  disabled?: boolean;
}

/**
 * Mounts paseo's canvas in a host element for one workspace. Messages go to the thread that works
 * there, started on the first one if there is none; the canvas holds sending while it runs.
 */
export function useCanvasHost(options: CanvasHostOptions) {
  const call = useCall();
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<CanvasHandle | null>(null);
  const latest = useRef({ call, options });
  latest.current = { call, options };
  // A ref for the canvas's own use: learning the thread must not mount the canvas again.
  const thread = useRef<string | null>(options.preferredThread);
  const [threadId, setThreadId] = useState<string | null>(options.preferredThread);
  const learn = (id: string) => {
    thread.current = id;
    setThreadId((current) => (current === id ? current : id));
  };

  const { workspaceId, remountKey, disabled } = options;
  const api = useMemo(() => {
    if (!workspaceId) return null;
    const base = canvasApi(
      (rpc, input) => latest.current.call(rpc, input),
      workspaceId,
      async () => {
        const found = await latest.current.call(findThread, { workspaceId, preferred: thread.current ?? latest.current.options.preferredThread, create: true });
        if (!found.threadId) throw new Error("No thread to send to.");
        learn(found.threadId);
        return found.threadId;
      },
    );
    return {
      ...base,
      others: () => latest.current.options.others?.() ?? [],
      home: () => latest.current.options.home?.() ?? null,
    };
    // remountKey stands for the workspace and design chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, remountKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !api || disabled) return;
    let slug = latest.current.options.initialSlug();
    const handle = mountCanvas({
      host,
      t: t as unknown as Translate,
      api,
      theme: BB_THEME,
      initialSlug: slug,
      onSlugChange: (next) => {
        slug = next;
        latest.current.options.onSlugChange(next);
      },
    });
    handleRef.current = handle;
    const cleanup = latest.current.options.onMount?.(handle);
    return () => {
      cleanup?.();
      handle.destroy();
      handleRef.current = null;
    };
  }, [api, disabled]);

  useEffect(() => {
    handleRef.current?.refreshExtras();
  }, [options.extrasKey]);

  useEffect(() => {
    if (!workspaceId || disabled) return;
    let stopped = false;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const found = await latest.current.call(findThread, { workspaceId, preferred: thread.current ?? latest.current.options.preferredThread, create: false });
        if (stopped) return;
        if (!found.threadId) return handleRef.current?.setAgentStatus("idle");
        learn(found.threadId);
        const { status } = await latest.current.call(threadStatus, { workspaceId, threadId: found.threadId });
        if (!stopped) handleRef.current?.setAgentStatus(agentStatus(status));
      } catch {
        // The next poll tries again.
      }
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [workspaceId, remountKey, disabled]);

  return { hostRef, handleRef, threadId };
}
