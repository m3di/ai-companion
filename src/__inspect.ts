import { loadGraph, formatDiagnostics } from './entities.js';
import { simplify, renderMap } from './simplify.js';
import { focusView, focusLinesFromGraph } from './focusView.js';
const g = loadGraph();
if (g.errors.length) { console.log('LINT ERRORS:\n'+formatDiagnostics(g.errors)); process.exit(1); }
const s = simplify(g);
const short = (i:string)=>i.split('/').pop();
console.log(`GRAPH: ${g.entities.size} entities · ${g.edges.length} edges (inverses incl.)`);
const kinds = new Map<string,number>();
for (const e of g.entities.values()) kinds.set(e.kind,(kinds.get(e.kind)??0)+1);
console.log('kinds:', [...kinds].sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${n} ${k}`).join(', '));
console.log('with probes:', [...g.entities.values()].filter(e=>e.probe).length, '| open:', [...g.entities.values()].filter(e=>e.status==='open').length, '| goals:', [...g.entities.values()].filter(e=>e.goal).length);
console.log('blocks edges:', g.edges.filter(e=>e.rel==='blocks').length, '-> reduced', s.edges.length);
console.log('\nCRITICAL PATHS:');
for (const p of s.criticalPaths) console.log('  ', p.path.map(short).join(' → '));
console.log('\nMERGE CANDIDATES:', s.mergeCandidates.length ? '' : '(none)');
for (const m of s.mergeCandidates.slice(0,5)) console.log(`   ${short(m.a)} ~ ${short(m.b)} (${m.why})`);
console.log('\nDERIVED FOCUS:');
console.log(focusLinesFromGraph(focusView(g, s)).join('\n'));
