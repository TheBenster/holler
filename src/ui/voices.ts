import type { DroneWaveform } from "../audio/graph";

export interface VoicesDeps {
  getWaveform: (index: number) => DroneWaveform;
}

export interface VoicesPanel {
  refresh(): void;
}

const QUADRANTS = ["nw", "ne", "sw", "se"];

function waveformPath(type: DroneWaveform): string {
  switch (type) {
    case "sine":
      return "M1 12 C5 2 9 2 13 12 S21 22 25 12 S33 2 37 12 S45 22 49 12 S57 2 61 12 S69 22 73 12";
    case "triangle":
      return "M1 12 L10 3 L19 12 L28 21 L37 12 L46 3 L55 12 L64 21 L73 12";
    case "square":
      return "M1 12 L1 4 L19 4 L19 20 L37 20 L37 4 L55 4 L55 20 L73 20";
    case "sawtooth":
      return "M1 20 L19 4 L19 20 L37 4 L37 20 L55 4 L55 20 L73 4";
  }
}

/** A readout, not a control: it makes the terrain's four synth voices legible. */
export function initVoices(root: HTMLElement, deps: VoicesDeps): VoicesPanel {
  root.className = "voices";
  root.innerHTML = "";
  const title = document.createElement("div");
  title.className = "voices-title";
  title.textContent = "terrain voices";
  root.appendChild(title);

  const rows = QUADRANTS.map((quadrant) => {
    const row = document.createElement("div");
    row.className = "voice-row";
    const label = document.createElement("span");
    label.textContent = quadrant;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 74 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    svg.appendChild(path);
    const name = document.createElement("span");
    row.append(label, svg, name);
    root.appendChild(row);
    return { path, name };
  });

  function refresh(): void {
    for (let i = 0; i < rows.length; i++) {
      const waveform = deps.getWaveform(i);
      rows[i]!.path.setAttribute("d", waveformPath(waveform));
      rows[i]!.name.textContent = waveform;
    }
  }

  refresh();
  return { refresh };
}
