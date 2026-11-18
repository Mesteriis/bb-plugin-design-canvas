import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesignKind } from "../shared/design";
import { getCover, type ArtboardView, type HomeDesign, type HomeProject, importDesign, initCanvas, listHome } from "../shared/rpc";
import { canPickFiles, fileToBase64, pickZip, watchFileDrops } from "./files";
import { locale, t } from "./i18n";
import { icon, type IconName } from "./icons";
import { createDesign, openDesign } from "./open";
import { type Call, useCall } from "./rpc";
import { Thumbnail } from "./thumbnail";

type Tab = "prototype" | "other";
type Fidelity = "wireframe" | "high";
const TABS: Tab[] = ["prototype", "other"];
const CARD_MIN = 230;
const GAP = 20;
const THUMB_RATIO = 10 / 16;

interface Card extends HomeDesign {
  workspaceId: string;
  directory: string;
  where: string;
}

function projectLabel(project: HomeProject): string {
  return project.workspace && project.workspace !== project.project ? `${project.project} · ${project.workspace}` : project.project;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(at: number, now: number): string {
  const seconds = Math.round((at - now) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  try {
    const format = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
    for (const [unit, size] of steps) {
      if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
    }
    return format.format(0, "minute");
  } catch {
    return new Date(at).toLocaleDateString();
  }
}

function Glyph({ name, size = 16, spin }: { name: IconName; size?: number; spin?: boolean }) {
  return <span className={`dch-icon${spin ? " dch-spin" : ""}`} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: icon(name) }} />;
}

/** The Design home: start a design, and the recent designs of every workspace. */
export function DesignHome() {
  const call = useCall();
  const nav = useBbNavigate();
  const screenRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const compact = width < 720;

  const [projects, setProjects] = useState<HomeProject[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refetch = useCallback(async () => {
    try {
      setProjects((await call(listHome, {})).projects);
      setLoadError(null);
    } catch (error) {
      setLoadError(describe(error));
    } finally {
      setLoaded(true);
    }
  }, [call]);
  useEffect(() => {
    void refetch();
    const timer = setInterval(() => !document.hidden && void refetch(), 8000);
    return () => clearInterval(timer);
  }, [refetch]);

  const cards = useMemo<Card[]>(
    () =>
      projects
        .flatMap((project) => project.designs.map((design) => ({ ...design, workspaceId: project.workspaceId, directory: project.directory, where: projectLabel(project) })))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [projects],
  );

  const [tab, setTab] = useState<Tab>("prototype");
  const [fidelity, setFidelity] = useState<Fidelity>("high");
  const kind: DesignKind = tab === "prototype" ? (fidelity === "wireframe" ? "wireframe" : "prototype") : tab;
  const [brief, setBrief] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);

  // New designs go where the user last designed, else to the most recently active workspace.
  const target =
    projects.find((project) => project.workspaceId === picked) ?? projects.find((project) => project.workspaceId === cards[0]?.workspaceId) ?? projects[0] ?? null;
  const designed = projects.filter((project) => project.designs.length > 0);
  const shown = filter ? cards.filter((card) => card.workspaceId === filter) : cards;

  async function run(key: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await task();
    } catch (failure) {
      setError(t("error", { error: describe(failure) }));
    } finally {
      setBusy(null);
    }
  }

  function create() {
    const text = brief.trim();
    if (!text || !target) return;
    void run("create", async () => {
      await createDesign({ call, nav, workspaceId: target.workspaceId, known: target.designs.map((design) => design.slug), kind, brief: text });
      setBrief("");
      void refetch();
    });
  }

  async function importZip(dropped?: File | null) {
    if (!target || busy) return;
    if (dropped === null) {
      setError(t("dropZipOnly"));
      return;
    }
    const file = dropped ?? (await pickZip());
    if (!file) return;
    void run("import", async () => {
      const { slug, title, kept } = await call(importDesign, { workspaceId: target.workspaceId, base64: await fileToBase64(file) });
      toast(kept.length ? t("designImportedKept", { title, files: kept.join(", ") }) : t("designImported", { title }));
      void refetch();
      openDesign({ nav, workspaceId: target.workspaceId, slug });
    });
  }

  function open(card: Card) {
    openDesign({ nav, workspaceId: card.workspaceId, slug: card.slug });
  }

  // The width decides between the two-column and the stacked layout.
  useEffect(() => {
    const host = screenRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // A zip dropped anywhere on the screen imports into the picked project.
  const importRef = useRef(importZip);
  importRef.current = importZip;
  useEffect(() => {
    const host = screenRef.current;
    if (!canPickFiles || !host) return;
    return watchFileDrops(host, { enter: () => setDropping(true), leave: () => setDropping(false), drop: (file) => void importRef.current(file) });
  }, []);

  const now = Date.now();
  const canCreate = brief.trim() !== "" && target !== null && busy === null;
  const menuOpen = picking || adding;

  const newDesign = (
    <div className={`dch-new${menuOpen ? " dch-raised" : ""}`}>
      <div className={`dch-card${menuOpen ? " dch-raised" : ""}`}>
        <div className="dch-tabs" role="tablist">
          {TABS.map((option) => (
            <button key={option} role="tab" aria-selected={option === tab} className={`dch-tab${option === tab ? " dch-on" : ""}`} onClick={() => setTab(option)}>
              {t(`kind_${option}`)}
            </button>
          ))}
        </div>
        <div className="dch-body">
          {tab === "prototype" ? (
            <div className="dch-fidelities" role="radiogroup">
              {(["wireframe", "high"] as const).map((option) => (
                <button key={option} role="radio" aria-checked={option === fidelity} className={`dch-fidelity${option === fidelity ? " dch-on" : ""}`} onClick={() => setFidelity(option)}>
                  <FidelityPreview kind={option} />
                  <span>{t(option === "high" ? "highFidelity" : "kind_wireframe")}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className={`dch-composer${menuOpen ? " dch-raised2" : ""}`}>
            <textarea
              className="dch-brief"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder={t("briefPlaceholder")}
              aria-label={t("briefPlaceholder")}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) create();
              }}
            />
            <div className="dch-bar">
              <div className="dch-barleft">
                {canPickFiles ? (
                  <div className="dch-anchor">
                    <button className="dch-plus" aria-label={t("add")} disabled={busy !== null} onClick={() => setAdding((value) => !value)}>
                      <Glyph name={busy === "import" ? "loader" : "plus"} spin={busy === "import"} />
                    </button>
                    {adding ? (
                      <>
                        <button type="button" tabIndex={-1} className="dch-backdrop" aria-label={t("close")} onClick={() => setAdding(false)} />
                        <div className="dch-popover dch-narrow">
                          <div className="dch-pad">
                            <button
                              className="dch-option"
                              role="menuitem"
                              disabled={!target}
                              onClick={() => {
                                setAdding(false);
                                void importZip();
                              }}
                            >
                              <Glyph name="upload" size={14} />
                              <span className="dch-optiontext">{t("importDesign")}</span>
                            </button>
                          </div>
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}
                <div className="dch-anchor">
                  <button
                    className="dch-chip"
                    aria-label={t("project")}
                    disabled={projects.length === 0}
                    onClick={() => {
                      setQuery("");
                      setPicking((value) => !value);
                    }}
                  >
                    <Glyph name="folder" size={14} />
                    <span className="dch-chiptext">{target ? target.project : !loaded ? "…" : t("noProjects")}</span>
                    <Glyph name="chevron" size={13} />
                  </button>
                  {picking ? (
                    <>
                      <button type="button" tabIndex={-1} className="dch-backdrop" aria-label={t("close")} onClick={() => setPicking(false)} />
                      <div className="dch-popover">
                        {projects.length > 6 ? <input className="dch-search" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus placeholder={t("searchProjects")} /> : null}
                        <div className="dch-scroll">
                          {projects
                            .filter((project) => !query.trim() || projectLabel(project).toLowerCase().includes(query.trim().toLowerCase()))
                            .map((project) => (
                              <button
                                key={project.workspaceId}
                                className="dch-option"
                                role="menuitem"
                                onClick={() => {
                                  setPicked(project.workspaceId);
                                  setPicking(false);
                                }}
                              >
                                <span className="dch-optiontext">
                                  {project.project}
                                  {project.workspace !== project.project ? <span className="dch-muted">{`  ${project.workspace}`}</span> : null}
                                </span>
                                {project === target ? <Glyph name="check" size={14} /> : null}
                              </button>
                            ))}
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
              <button className={`dch-send${canCreate ? " dch-sendon" : ""}`} aria-label={t("create")} disabled={!canCreate} onClick={create}>
                <Glyph name={busy === "create" ? "loader" : "arrowUp"} spin={busy === "create"} />
              </button>
            </div>
          </div>
        </div>
      </div>
      {error ? <p className="dch-error">{error}</p> : null}
    </div>
  );

  return (
    <div ref={screenRef} className={`dch-screen${compact ? " dch-compact" : ""}`}>
      <style>{HOME_CSS}</style>
      {dropping ? (
        <div className="dch-drop">
          <Glyph name="upload" size={22} />
          <span>{target ? target.project : ""}</span>
        </div>
      ) : null}
      {compact ? null : newDesign}
      <div className="dch-list">
        {compact ? newDesign : null}
        <div className="dch-listhead">
          <h2 className="dch-heading">{t("recent")}</h2>
          {designed.length > 1 ? (
            <div className="dch-filters">
              {[null, ...designed.map((project) => project.workspaceId)].map((id) => {
                const project = designed.find((candidate) => candidate.workspaceId === id);
                return (
                  <button key={id ?? "all"} className={`dch-filter${filter === id ? " dch-on" : ""}`} onClick={() => setFilter(id)}>
                    {project ? projectLabel(project) : t("allProjects")}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        {loadError ? <p className="dch-error">{t("error", { error: loadError })}</p> : null}
        {loaded && shown.length === 0 ? <p className="dch-muted">{t("emptyTitle")}</p> : null}
        <Grid cards={shown} call={call} busy={busy} meta={(card) => [card.where, relativeTime(card.updatedAt, now), ...(card.openComments > 0 ? [t("openComments", { count: card.openComments })] : [])].join(" · ")} onOpen={open} />
      </div>
    </div>
  );
}

/** A tiny page sketch: outlines for a wireframe, filled colour for high fidelity. */
function FidelityPreview({ kind }: { kind: Fidelity }) {
  const wire = kind === "wireframe";
  const block = (fill: string, extra: React.CSSProperties = {}): React.CSSProperties => ({
    ...(wire ? { border: "1px dashed var(--muted-foreground)", background: "transparent" } : { background: fill }),
    ...extra,
  });
  return (
    <div className="dch-sketch">
      <div style={block("var(--primary)", { height: 8, borderRadius: 2, width: "60%" })} />
      <div style={{ display: "flex", gap: 5, flex: 1 }}>
        <div style={block("var(--muted)", { flex: 1, borderRadius: 3 })} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={block("var(--muted-foreground)", { height: 4, borderRadius: 2 })} />
          <div style={block("var(--border)", { height: 4, width: "70%", borderRadius: 2 })} />
          <div style={block("var(--primary)", { height: 9, width: "55%", marginTop: "auto", borderRadius: 3 })} />
        </div>
      </div>
    </div>
  );
}

function Grid({ cards, call, busy, meta, onOpen }: { cards: Card[]; call: Call; busy: string | null; meta: (card: Card) => string; onOpen: (card: Card) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  const columns = Math.max(1, Math.floor((width + GAP) / (CARD_MIN + GAP)));
  const cardWidth = width > 0 ? Math.floor((width - GAP * (columns - 1)) / columns) : 0;
  return (
    <div ref={ref} className="dch-grid">
      {cardWidth > 0
        ? cards.map((card) => (
            <DesignCard key={`${card.workspaceId}/${card.slug}`} card={card} call={call} width={cardWidth} opening={busy === `${card.workspaceId}/${card.slug}`} meta={meta(card)} onOpen={() => onOpen(card)} />
          ))
        : null}
    </div>
  );
}

function DesignCard({ card, call, width, opening, meta, onOpen }: { card: Card; call: Call; width: number; opening: boolean; meta: string; onOpen: () => void }) {
  const [cover, setCover] = useState<ArtboardView | null>(null);
  useEffect(() => {
    if (card.error !== null) return;
    let live = true;
    call(getCover, { workspaceId: card.workspaceId, slug: card.slug }).then(
      (result) => live && setCover(result.cover),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [call, card.workspaceId, card.slug, card.updatedAt, card.error]);
  return (
    <button className="dch-design" aria-label={card.title} onClick={onOpen} style={{ width, opacity: opening ? 0.6 : 1 }}>
      <div className="dch-thumb">
        <Thumbnail cover={cover} width={width - 2} height={Math.round(width * THUMB_RATIO)} background="var(--muted)" />
      </div>
      <span className="dch-cardtitle">{card.title}</span>
      <span className="dch-cardmeta">{card.error ?? meta}</span>
    </button>
  );
}

const HOME_CSS = `
.dch-screen { position: relative; flex: 1; min-height: 0; width: 100%; display: flex; background: var(--background); color: var(--foreground); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; }
.dch-screen * { box-sizing: border-box; }

:where(.dch-screen) button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; text-align: inherit; }
:where(.dch-screen) button:disabled { cursor: default; }
.dch-icon { display: inline-flex; flex: none; color: var(--muted-foreground); }
.dch-icon svg { width: 100%; height: 100%; }
.dch-spin svg { animation: dch-rot 0.9s linear infinite; }
@keyframes dch-rot { to { transform: rotate(360deg); } }
.dch-new { width: 340px; padding: 24px; display: flex; flex-direction: column; gap: 10px; border-right: 1px solid var(--border); flex: none; overflow-y: auto; }
.dch-compact .dch-new { width: auto; padding: 0 0 8px; border-right: 0; overflow: visible; }
.dch-raised { position: relative; z-index: 10; }
.dch-raised2 { position: relative; z-index: 20; }
.dch-card { border-radius: 12px; border: 1px solid var(--border); background: var(--card); }
.dch-tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 6px; }
.dch-tab { flex: 1; height: 40px; display: flex; align-items: center; justify-content: center; border-bottom: 2px solid transparent; margin-bottom: -1px; color: var(--muted-foreground); font-weight: 500; }
.dch-tab:hover { border-color: var(--border); }
.dch-tab.dch-on { border-color: var(--foreground); color: var(--foreground); }
.dch-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.dch-fidelities { display: flex; gap: 8px; }
.dch-fidelity { flex: 1; padding: 6px; display: flex; flex-direction: column; gap: 6px; border-radius: 9px; border: 1px solid var(--border); background: var(--card); color: var(--muted-foreground); font-size: 12px; text-align: center; }
.dch-fidelity span { padding-bottom: 2px; }
.dch-fidelity:hover { border-color: var(--muted-foreground); }
.dch-fidelity.dch-on { border-color: var(--foreground); box-shadow: inset 0 0 0 .5px var(--foreground); color: var(--foreground); font-weight: 500; }
.dch-sketch { height: 58px; border-radius: 6px; padding: 7px; display: flex; flex-direction: column; gap: 5px; background: var(--background); overflow: hidden; }
.dch-composer { border-radius: 12px; border: 1px solid var(--border); background: var(--background); position: relative; }
.dch-brief { display: block; width: 100%; min-height: 92px; padding: 10px 12px 6px; border: 0; outline: 0; resize: none; background: transparent; color: var(--foreground); font: inherit; font-size: 14px; line-height: 20px; }
.dch-compact .dch-brief { min-height: 72px; }
.dch-brief::placeholder { color: var(--muted-foreground); }
.dch-bar { display: flex; align-items: center; justify-content: space-between; padding: 0 6px 6px; }
.dch-barleft { display: flex; align-items: center; gap: 2px; min-width: 0; flex-shrink: 1; }
.dch-anchor { position: relative; min-width: 0; flex-shrink: 1; }
.dch-plus { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
.dch-plus:hover, .dch-chip:hover, .dch-option:hover:not(:disabled), .dch-filter:hover:not(.dch-on) { background: var(--muted); }
.dch-chip { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; border-radius: 8px; max-width: 200px; }
.dch-chiptext { color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dch-backdrop { position: fixed; inset: 0; z-index: 20; }
.dch-popover { position: absolute; top: 32px; left: 0; z-index: 21; width: 264px; border-radius: 12px; border: 1px solid var(--border); background: var(--popover); box-shadow: 0 8px 18px rgba(0,0,0,.16); }
.dch-narrow { width: 200px; }
.dch-pad { padding: 4px; }
.dch-scroll { max-height: 280px; overflow-y: auto; padding: 4px; }
.dch-search { display: block; height: 34px; width: calc(100% - 8px); margin: 4px 4px 0; padding: 0 10px; border-radius: 8px; border: 0; outline: 0; background: var(--background); color: var(--foreground); font: inherit; }
.dch-option { display: flex; align-items: center; gap: 8px; height: 32px; width: 100%; padding: 0 10px; border-radius: 7px; }
.dch-optiontext { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dch-muted { color: var(--muted-foreground); }
.dch-send { width: 30px; height: 30px; border-radius: 15px; display: flex; align-items: center; justify-content: center; background: var(--muted); }
.dch-send.dch-sendon { background: var(--primary); }
.dch-send.dch-sendon .dch-icon { color: var(--primary-foreground); }
.dch-sendon:hover { opacity: .9; }
.dch-error { color: var(--destructive); margin: 0; }
.dch-list { flex: 1; min-width: 0; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
.dch-compact .dch-list { padding: 16px; }
.dch-compact { flex-direction: column; }
.dch-listhead { display: flex; flex-direction: column; gap: 10px; }
.dch-heading { margin: 0; font-size: 17px; font-weight: 600; }
.dch-filters { display: flex; flex-wrap: wrap; gap: 6px; }
.dch-filter { height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--border); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dch-filter.dch-on { background: var(--foreground); border-color: var(--foreground); color: var(--background); }
.dch-grid { display: flex; flex-wrap: wrap; gap: ${GAP}px; }
.dch-design { display: flex; flex-direction: column; }
.dch-thumb { border-radius: 10px; border: 1px solid var(--border); overflow: hidden; background: var(--muted); }
.dch-design:hover .dch-thumb { border-color: var(--muted-foreground); }
.dch-cardtitle { margin-top: 8px; font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dch-cardmeta { margin-top: 2px; font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dch-drop { position: absolute; inset: 8px; z-index: 50; border-radius: 14px; border: 2px dashed var(--primary); background: var(--background); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; pointer-events: none; font-size: 14px; font-weight: 500; }
`;
