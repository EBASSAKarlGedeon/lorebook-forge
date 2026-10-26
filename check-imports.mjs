import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = "src", files = readdirSync(dir).filter(f => f.endsWith(".js"));
const exportsOf = {};
for (const f of files) {
  const t = readFileSync(join(dir, f), "utf8"), set = new Set();
  for (const m of t.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z0-9_$]+)/g)) set.add(m[1]);
  for (const m of t.matchAll(/export\s*\{([^}]*)\}/g)) m[1].split(",").forEach(x => { const n = x.split(/\s+as\s+/).pop().trim(); if (n) set.add(n); });
  exportsOf[f] = set;
}
let bad = 0;
for (const f of files) {
  const t = readFileSync(join(dir, f), "utf8");
  for (const m of t.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/([^"']+)["']/g)) {
    const target = m[2].endsWith(".js") ? m[2] : m[2] + ".js";
    if (!exportsOf[target]) { console.log(`${f}: imports from missing file ${target}`); bad++; continue; }
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name && !exportsOf[target].has(name)) { console.log(`${f}: "${name}" is not exported by ${target}`); bad++; }
    }
  }
}
console.log(bad ? `${bad} problem(s)` : "All named imports resolve.");
