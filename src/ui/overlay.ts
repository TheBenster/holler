import {
  MIN_RADIUS,
  MAX_RADIUS,
  MIN_STRENGTH,
  MAX_STRENGTH,
  type BrushSettings,
  type BrushTool,
} from "../terrain/brush";

// §5: the bottom-edge UI overlay — the only visible controls in the app.
// This module builds a handful of plain HTML elements (buttons, sliders,
// a text label) with vanilla DOM APIs — no framework, since the spec is
// explicit that ~10 controls doesn't justify pulling in React/Vue/etc.
//
// Important rule from the spec: sliders may control the BRUSH, never the
// sound. There's no volume knob or filter slider anywhere in this file —
// only radius/strength (how the brush behaves) and world state
// (seed/randomize/reset). That's why `OverlayDeps` below only ever touches
// `brushSettings` and terrain callbacks, nothing audio-related, even once
// M2 adds real audio.

// Everything this module needs from the outside world, handed in as one
// object by whoever calls initOverlay() (main.ts). Notice this file never
// does `import ... from "../main"` — it doesn't know main.ts exists at
// all. That keeps this a "leaf" module: it only depends on brush.ts (for
// types and slider bounds) and the DOM, so it's easy to reason about in
// isolation and easy to reuse if the app's structure changes later.
export interface OverlayDeps {
  brushSettings: BrushSettings;
  getSeed: () => number;
  onRandomize: () => void;
  onReset: () => void;
}

export interface Overlay {
  /** re-read brushSettings/seed and update the DOM — call after anything
   * outside this module changes them (e.g. keyboard shortcuts). Without
   * this, pressing `[` to shrink the radius would update the actual brush
   * but leave the slider showing the old value, which would be a
   * confusing bug for exactly no functional reason. */
  refresh: () => void;
}

// The four brushes in a fixed order, paired with their button label. Using
// an array + loop to build the buttons instead of writing four nearly-
// identical blocks of code by hand means adding a fifth brush later is a
// one-line change here, not a copy-pasted block.
const TOOLS: { tool: BrushTool; label: string }[] = [
  { tool: "raise", label: "raise" },
  { tool: "lower", label: "lower" },
  { tool: "smooth", label: "smooth" },
  { tool: "flatten", label: "flatten" },
];

export function initOverlay(root: HTMLElement, deps: OverlayDeps): Overlay {
  // Clear out whatever was in the root element (nothing, currently — it's
  // an empty <div id="overlay"> in index.html) and build everything fresh.
  root.innerHTML = "";
  root.className = "overlay";

  // --- brush select buttons ---
  const brushGroup = document.createElement("div");
  brushGroup.className = "overlay-group";
  // Map from tool -> its button element, so refresh() below can quickly
  // find "which button needs the .active class" without searching the DOM.
  const brushButtons = new Map<BrushTool, HTMLButtonElement>();
  for (const { tool, label } of TOOLS) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      deps.brushSettings.tool = tool;
      refresh(); // update which button looks "active" immediately
    });
    brushButtons.set(tool, btn);
    brushGroup.appendChild(btn);
  }
  root.appendChild(brushGroup);

  // Small local helper for building a labeled <input type="range"> —
  // radius and strength need the exact same wiring (label + input +
  // min/max/step + read/write callbacks), so this exists to avoid writing
  // that boilerplate twice. It's declared inside initOverlay() rather than
  // at module scope because it reaches into `root` via closure.
  function slider(
    labelText: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (v: number) => void,
  ): HTMLInputElement {
    const wrap = document.createElement("label");
    wrap.className = "overlay-slider";
    wrap.textContent = labelText;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(get()); // seed the slider's starting position from the current value
    // "input" fires continuously while dragging (unlike "change", which
    // only fires once you let go) — we want the brush to update live as
    // the slider moves, not just after release.
    input.addEventListener("input", () => set(Number(input.value)));
    wrap.appendChild(input);
    root.appendChild(wrap);
    return input;
  }

  const radiusInput = slider(
    "radius",
    MIN_RADIUS,
    MAX_RADIUS,
    0.5,
    () => deps.brushSettings.radius,
    (v) => (deps.brushSettings.radius = v),
  );
  const strengthInput = slider(
    "strength",
    MIN_STRENGTH,
    MAX_STRENGTH,
    0.5,
    () => deps.brushSettings.strength,
    (v) => (deps.brushSettings.strength = v),
  );

  // Just a readout, not an input — there's no "type in a seed" field in
  // v1, only randomize (new seed) and reset (regenerate current seed).
  const seedEl = document.createElement("span");
  seedEl.className = "overlay-seed";
  root.appendChild(seedEl);

  const randomizeBtn = document.createElement("button");
  randomizeBtn.textContent = "randomize";
  randomizeBtn.title = "r"; // shows as a tooltip on hover, hinting at the keyboard shortcut
  randomizeBtn.addEventListener("click", () => {
    deps.onRandomize();
    refresh(); // the seed readout needs updating after this
  });
  root.appendChild(randomizeBtn);

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "reset";
  resetBtn.title = "backspace";
  resetBtn.addEventListener("click", () => {
    deps.onReset();
    refresh();
  });
  root.appendChild(resetBtn);

  // The single function responsible for making the DOM match whatever
  // brushSettings/seed currently say. Every event handler above calls
  // this after it changes something, and main.ts's keyboard handler calls
  // the same `refresh` (returned below) after keyboard-driven changes —
  // so no matter which of the three input methods (click, drag, keyboard)
  // caused a change, the UI always ends up showing the true current state.
  function refresh(): void {
    for (const [tool, btn] of brushButtons) {
      btn.classList.toggle("active", deps.brushSettings.tool === tool);
    }
    radiusInput.value = String(deps.brushSettings.radius);
    strengthInput.value = String(deps.brushSettings.strength);
    seedEl.textContent = `seed ${deps.getSeed()}`;
  }

  refresh(); // make sure the very first render already matches the real starting state
  return { refresh };
}
