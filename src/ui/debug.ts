import type { TerrainStats } from "../terrain/stats";
import type { MappingEngine } from "../audio/mappings";

type ScalarTerrainStat = Exclude<keyof TerrainStats, "regionMass">;

// §13: "dev-critical and demo-gold... building this before tuning is
// mandatory — you cannot tune mappings you can't see." This panel is the
// only place in the app that shows the raw numbers driving the sound: the
// five TerrainStats, and what every mapping row is currently outputting.
// Toggled with `~`, hidden by default — this is a tool, not part of the
// instrument's own UI (that's overlay.ts).

export interface DebugDeps {
  getFps: () => number;
  // The same object main.ts's computeStats() mutates in place — reading
  // its fields here always sees the latest values, no extra plumbing
  // needed to keep this panel in sync.
  stats: TerrainStats;
  // A getter, not the engine itself: mappingEngine doesn't exist until
  // the gesture gate fires, and can't be handed to initDebug() before
  // then. Reading it fresh through a closure each refresh means this
  // panel doesn't care when (or whether yet) that happens.
  getMappingEngine: () => MappingEngine | null;
  getRenderMode: () => string;
}

export interface DebugOverlay {
  /** Re-read fps/stats/mappings and update the DOM. Cheap to call often —
   * it's a no-op whenever the panel isn't visible. */
  refresh(): void;
  toggle(): void;
}

const STAT_LABELS: { key: ScalarTerrainStat; label: string }[] = [
  { key: "peak", label: "peak" },
  { key: "valleyDepth", label: "valleyDepth" },
  { key: "meanElev", label: "meanElev" },
  { key: "roughness", label: "roughness" },
  { key: "waterFrac", label: "waterFrac" },
  { key: "landMass", label: "landMass" },
];

export function initDebug(root: HTMLElement, deps: DebugDeps): DebugOverlay {
  root.innerHTML = "";
  root.className = "debug";
  root.style.display = "none";
  let visible = false;

  const fpsRow = document.createElement("div");
  root.appendChild(fpsRow);
  const renderModeRow = document.createElement("div");
  root.appendChild(renderModeRow);

  const statRows = new Map<ScalarTerrainStat, HTMLDivElement>();
  for (const { key } of STAT_LABELS) {
    const row = document.createElement("div");
    statRows.set(key, row);
    root.appendChild(row);
  }
  const regionsRow = document.createElement("div");
  root.appendChild(regionsRow);

  // Rebuilt from scratch on every refresh rather than diffed in place —
  // the mapping engine doesn't exist for a while (before the gesture
  // gate), and once it does the row count never changes, so there's no
  // real cost to just clearing and re-appending eight small text rows a
  // few times a second.
  const mappingsSection = document.createElement("div");
  root.appendChild(mappingsSection);

  function refresh(): void {
    if (!visible) return;

    fpsRow.textContent = `${deps.getFps()} fps`;
    renderModeRow.textContent = deps.getRenderMode();
    for (const { key, label } of STAT_LABELS) {
      statRows.get(key)!.textContent = `${label}  ${deps.stats[key].toFixed(3)}`;
    }
    regionsRow.textContent = `land nw/ne/sw/se  ${Array.from(deps.stats.regionMass).map((v) => v.toFixed(2)).join(" ")}`;

    mappingsSection.innerHTML = "";
    const engine = deps.getMappingEngine();
    if (!engine) {
      const row = document.createElement("div");
      row.className = "debug-dim";
      row.textContent = "(press to begin — no audio graph yet)";
      mappingsSection.appendChild(row);
      return;
    }
    for (const entry of engine.readCurrentValues()) {
      const row = document.createElement("div");
      row.textContent = `${entry.stat} -> ${entry.param}  ${entry.value.toFixed(2)}`;
      mappingsSection.appendChild(row);
    }
  }

  function toggle(): void {
    visible = !visible;
    root.style.display = visible ? "block" : "none";
    refresh(); // don't wait for the next scheduled refresh to populate on open
  }

  return { refresh, toggle };
}
