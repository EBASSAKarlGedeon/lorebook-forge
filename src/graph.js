// Road-map graph (Stage 22): the pageCache as a node-link map.
// Nodes = read/batch-read pages, links = wiki links harvested from them.
// Road-styled: nodes are dots on a dark map, edges dashed like roads,
// domains colored by categorical palette (validated for the dark surface).
// Hand-rolled force layout — no d3, zero new dependencies.
import { extensionName } from "./config.js";
import { escapeHtml } from "./helpers.js";
import { openInReader, getPageCache } from "./research.js";

// Categorical palette — validated (dataviz skill validator, dark surface
// #16181d): lightness band, chroma floor, contrast all PASS; CVD WARN on
// green↔amber (ΔE 7.9 protan, floor band) is legal because identity is
// never color-alone — every node is labeled.
const DOMAIN_COLORS = {
    "fandom.com": "#8b5cf6",    // violet
    "wiki.gg": "#d97706",       // amber
    "wikipedia.org": "#059669", // emerald
    "other": "#3b82f6",         // blue
};
const DOMAIN_ORDER = ["fandom.com", "wiki.gg", "wikipedia.org", "other"];

function domainOf(url) {
    try {
        const h = new URL(url).hostname;
        if (h.endsWith(".fandom.com") || h === "fandom.com") return "fandom.com";
        if (h.endsWith(".wiki.gg") || h === "wiki.gg") return "wiki.gg";
        if (h.endsWith("wikipedia.org")) return "wikipedia.org";
        return "other";
    } catch { return "other"; }
}

// Pull the graph out of the shared pageCache (research.js owns it —
// passed in as a Map to avoid a circular import).
export function buildGraphModel(pageCache) {
    const nodes = new Map(); // url -> node
    for (const [url, entry] of pageCache) {
        nodes.set(url, {
            url,
            title: entry.title || url,
            domain: domainOf(url),
            kb: +((entry.text || "").length / 1024).toFixed(1),
            outgoing: 0,
            incoming: 0,
        });
    }
    const edges = [];
    const seen = new Set();
    for (const [url, entry] of pageCache) {
        for (const link of (entry.links || [])) {
            const target = link.url;
            if (!nodes.has(target) || target === url) continue;
            const key = url < target ? `${url}|${target}` : `${target}|${url}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ source: url, target });
        }
    }
    for (const e of edges) {
        nodes.get(e.source).outgoing++;
        nodes.get(e.target).incoming++;
    }
    const nodeList = [...nodes.values()];
    console.log(`[${extensionName}] Graph: ${nodeList.length} nodes, ${edges.length} edges`);
    return { nodes: nodeList, edges };
}

// ---------- Force layout (hand-rolled) ----------
// Repulsion + spring edges + centering, damped semi-implicit Euler.
// Converges in ~150 ticks at our scale (≤ a few hundred nodes).

const REPULSION = 9000;
const SPRING = 0.06;
const LINK_LENGTH = 120;
const CENTER_PULL = 0.003;
const DAMPING = 0.85;

function layoutGraph(model, width, height) {
    const { nodes, edges } = model;
    const byUrl = new Map(nodes.map(n => [n.url, n]));
    // seed on a circle by index — deterministic-ish start, no clumps
    nodes.forEach((n, i) => {
        const a = (i / Math.max(1, nodes.length)) * 2 * Math.PI;
        n.x = width / 2 + Math.cos(a) * (Math.min(width, height) / 3);
        n.y = height / 2 + Math.sin(a) * (Math.min(width, height) / 3);
        n.vx = 0;
        n.vy = 0;
    });
    const state = { nodes, edges, byUrl, cx: width / 2, cy: height / 2 };

    for (let tick = 0; tick < 200; tick++) {
        const alpha = 1 - tick / 200; // cools from 1 → 0
        // repulsion
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                let dx = nodes[i].x - nodes[j].x;
                let dy = nodes[i].y - nodes[j].y;
                let d2 = dx * dx + dy * dy;
                if (d2 < 1) {
                    dx = Math.random() - 0.5;
                    dy = Math.random() - 0.5;
                    d2 = dx * dx + dy * dy || 1;
                }
                const d = Math.sqrt(d2);
                const f = REPULSION / d2 * alpha;
                const fx = (dx / d) * f, fy = (dy / d) * f;
                nodes[i].vx += fx; nodes[i].vy += fy;
                nodes[j].vx -= fx; nodes[j].vy -= fy;
            }
        }
        // spring edges
        for (const e of edges) {
            const a = byUrl.get(e.source);
            const b = byUrl.get(e.target);
            if (!a || !b) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.max(1, Math.hypot(dx, dy));
            const f = (d - LINK_LENGTH) * SPRING * alpha;
            const fx = (dx / d) * f, fy = (dy / d) * f;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
        }
        // centering + integration
        for (const n of nodes) {
            n.vx += (state.cx - n.x) * CENTER_PULL * alpha;
            n.vy += (state.cy - n.y) * CENTER_PULL * alpha;
            n.vx *= DAMPING; n.vy *= DAMPING;
            n.x += n.vx; n.y += n.vy;
        }
    }
    return model;
}

// ---------- Rendering ----------

function nodeRadius(n) {
    // 4px base, +1px per degree, capped — magnitude without dwarfing labels
    return Math.min(11, 4 + n.outgoing + n.incoming);
}

function svgEl(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
}

// Render into #lf_graph. Pan/zoom via viewBox, wheel + drag.
export function renderGraph(pageCache) {
    const pane = $("#lf_graph");
    if (!pane.length) return;
    const model = buildGraphModel(pageCache);

    if (!model.nodes.length) {
        pane.html(`<div class="lf-graph-empty"><div class="lf-reader-empty-icon">🗺️</div>
            <h3>No pages yet</h3><p>Read or batch-read wiki pages — they appear here as a road map.</p></div>`);
        return;
    }

    const width = pane.width() || 800;
    const height = pane.height() || 500;
    layoutGraph(model, width, height);

    // viewBox pan/zoom state
    let vb = { x: 0, y: 0, w: width, h: height };
    const apply = () => svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);

    const svg = svgEl("svg", { class: "lf-graph-svg", width: "100%", height: "100%" });
    const edgesG = svgEl("g", { class: "lf-graph-edges" });
    const nodesG = svgEl("g", { class: "lf-graph-nodes" });
    svg.append(edgesG, nodesG);
    pane.html("").append(svg);

    const byUrl = new Map(model.nodes.map(n => [n.url, n]));

    // edges: dashed roads
    for (const e of model.edges) {
        const a = byUrl.get(e.source), b = byUrl.get(e.target);
        edgesG.append(svgEl("line", {
            x1: a.x.toFixed(1), y1: a.y.toFixed(1),
            x2: b.x.toFixed(1), y2: b.y.toFixed(1),
            class: "lf-graph-edge",
        }));
    }

    // nodes: dot + always-visible label under it
    for (const n of model.nodes) {
        const g = svgEl("g", { class: "lf-graph-node", transform: `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})` });
        const r = nodeRadius(n);
        g.append(svgEl("circle", {
            r, fill: DOMAIN_COLORS[n.domain], "data-url": n.url,
            "stroke-width": 2, // surface ring (color from the theme, in CSS): 2px gap rule
        }));
        const label = svgEl("text", {
            class: "lf-graph-label", y: r + 12,
            "text-anchor": "middle",
        });
        label.textContent = n.title.length > 22 ? n.title.slice(0, 21) + "…" : n.title;
        g.append(label);
        nodesG.append(g);
    }

    // legend (identity is never color-alone — labels + legend)
    const legend = $(`
        <div class="lf-graph-legend">
            ${DOMAIN_ORDER.map(d => `<span class="lf-graph-legend-item">
                <span class="lf-graph-dot" style="background:${DOMAIN_COLORS[d]}"></span>${d}</span>`).join("")}
        </div>`);
    pane.append(legend);

    // tooltip (hover layer)
    const tip = $(`<div class="lf-graph-tip"></div>`).appendTo(pane);
    svg.querySelectorAll(".lf-graph-node").forEach(g => {
        const url = g.querySelector("circle").getAttribute("data-url");
        const n = byUrl.get(url);
        g.addEventListener("mousemove", ev => {
            const off = pane.offset();
            tip.html(`<b>${escapeHtml(n.title)}</b><br>
                <span class="lf-graph-tip-dim">${escapeHtml(n.domain)} · ${n.kb} KB</span><br>
                ↗ ${n.outgoing} out · ↘ ${n.incoming} in`);
            tip.css({ left: ev.clientX - off.left + 14, top: ev.clientY - off.top + 14 }).show();
        });
        g.addEventListener("mouseleave", () => tip.hide());
        g.addEventListener("click", () => {
            openInReader(url);
        });
    });

    // pan (drag) + zoom (wheel) — listener lives on the SVG, removed with it
    // when renderGraph re-runs (pane.html("") drops the old svg subtree).
    let panning = null;
    svg.addEventListener("mousedown", ev => { panning = { x: ev.clientX, y: ev.clientY, vb }; });
    svg.addEventListener("mousemove", ev => {
        if (!panning) return;
        const k = vb.w / (pane.width() || 1);
        vb = { ...panning.vb, x: panning.vb.x - (ev.clientX - panning.x) * k, y: panning.vb.y - (ev.clientY - panning.y) * k };
        apply();
    });
    svg.addEventListener("mouseleave", () => (panning = null));
    svg.addEventListener("mouseup", () => (panning = null));
    svg.addEventListener("wheel", ev => {
        ev.preventDefault();
        const k = ev.deltaY > 0 ? 1.12 : 0.89;
        vb = { x: vb.x + vb.w * (1 - k) / 2, y: vb.y + vb.h * (1 - k) / 2, w: vb.w * k, h: vb.h * k };
        apply();
    }, { passive: false });

    apply();
    console.log(`[${extensionName}] Graph rendered: ${model.nodes.length} nodes`);
}

// Stub — studio.js calls renderGraph(getPageCache()) when toggling the pane.
export function initGraph() {
    console.log(`[${extensionName}] Graph pane ready`);
}
