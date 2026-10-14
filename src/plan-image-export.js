const SVG_NS = "http://www.w3.org/2000/svg";

function exportStyle(boundsWidth, boundsHeight) {
  const unit = Math.min(boundsWidth, boundsHeight) / 700;
  return `
    .dxf-line{fill:none;stroke:#3e4945;stroke-width:1.4;vector-effect:non-scaling-stroke}
    .dxf-detail{fill:none;stroke:#626d68;stroke-width:1.2;vector-effect:non-scaling-stroke}
    .dxf-annotation{fill:#3c6590;font-weight:500;font-family:Arial,sans-serif}
    .dxf-zone{stroke-width:${unit * 1.3};fill-opacity:.34}
    .dxf-zone.unassigned{fill:#aab8b3;stroke:#397c80;fill-opacity:.24}
    .dxf-zone.not-applicable{fill:#7c8580;stroke:#555e59;fill-opacity:.68}
    .dxf-zone.status-not-started{fill:#c94043;stroke:#9e292c}
    .dxf-zone.status-in-progress{fill:#e38b22;stroke:#a75e0d}
    .dxf-zone.status-done{fill:#16835d;stroke:#0e5e43}
    .dxf-zone.status-blocked{fill:#8f334e;stroke:#672037}
    .dxf-zone.filtered-out{fill:#b9c2be;stroke:#8c9993;fill-opacity:.4}
    .dxf-zone.selected{fill-opacity:.72}
    .dxf-label,.dxf-loggia-label{fill:#293a33;paint-order:stroke;stroke:#fff;stroke-width:${unit * 2};stroke-linejoin:round;font-family:Arial,sans-serif;font-weight:800}
    .dxf-room-marker.filtered-out .dxf-label,.dxf-loggia-label.filtered-out{fill:#77847e}
    .dxf-room-marker.selected .dxf-label{fill:#111d18;font-weight:900}
    .dxf-room-hit{display:none}
    .blocked-badge{fill:#fff;stroke:#672037;stroke-width:${unit * 1.5}}
    .blocked-badge-text{fill:#672037;font-family:Arial,sans-serif;font-weight:900;text-anchor:middle}
  `;
}

function markBlockedRooms(svg) {
  const blocked = new Set([...svg.querySelectorAll(".dxf-zone.status-blocked:not(.filtered-out)[data-room]")]
    .map((zone) => zone.getAttribute("data-room")));
  for (const marker of svg.querySelectorAll(".dxf-room-marker[data-room]")) {
    if (!blocked.has(marker.getAttribute("data-room"))) continue;
    const label = marker.querySelector(".dxf-label");
    if (!label) continue;
    const size = Number(label.getAttribute("font-size"));
    const x = Number(label.getAttribute("x")) + size * 1.35;
    const y = Number(label.getAttribute("y")) - size * .38;
    if (![size, x, y].every(Number.isFinite)) continue;
    const badge = document.createElementNS(SVG_NS, "circle");
    badge.setAttribute("class", "blocked-badge");
    badge.setAttribute("cx", String(x));
    badge.setAttribute("cy", String(y));
    badge.setAttribute("r", String(size * .46));
    const sign = document.createElementNS(SVG_NS, "text");
    sign.setAttribute("class", "blocked-badge-text");
    sign.setAttribute("x", String(x));
    sign.setAttribute("y", String(y + size * .3));
    sign.setAttribute("font-size", String(size * .86));
    sign.textContent = "!";
    marker.append(badge, sign);
  }
}

export function planExportSvg(source) {
  const viewBox = source.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0 || !source.querySelector(".dxf-line, .dxf-detail, .dxf-zone")) {
    throw new Error("Le plan de cet étage n'est pas encore disponible.");
  }
  const svg = source.cloneNode(true);
  svg.setAttribute("xmlns", SVG_NS);
  svg.removeAttribute("class");
  svg.removeAttribute("id");
  svg.setAttribute("width", "6000");
  svg.setAttribute("height", String(Math.round(6000 * viewBox[3] / viewBox[2])));
  svg.setAttribute("shape-rendering", "geometricPrecision");
  svg.setAttribute("text-rendering", "geometricPrecision");
  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = exportStyle(viewBox[2], viewBox[3]);
  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("x", String(viewBox[0]));
  background.setAttribute("y", String(viewBox[1]));
  background.setAttribute("width", String(viewBox[2]));
  background.setAttribute("height", String(viewBox[3]));
  background.setAttribute("fill", "#fff");
  svg.prepend(background);
  svg.prepend(style);
  markBlockedRooms(svg);
  return new XMLSerializer().serializeToString(svg);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadPlanImage(source, format, name) {
  const markup = planExportSvg(source);
  const svgBlob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
  if (format === "svg") {
    download(svgBlob, `${name}.svg`);
    return;
  }
  const viewBox = source.viewBox.baseVal;
  const aspect = viewBox.width / viewBox.height;
  const width = Math.min(6000, Math.floor(Math.sqrt(24_000_000 * aspect)));
  const height = Math.round(width / aspect);
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Le navigateur ne peut pas créer l'image haute définition.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("La création du PNG a échoué. Essayez le format SVG.");
    download(png, `${name}.png`);
  } finally {
    URL.revokeObjectURL(url);
  }
}
