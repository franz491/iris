import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const roots = ["backend/src", "frontend/src", "frontend/src-tauri/src"];
const pattern = /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}["'])/i;
export function scanSecrets(root) { const hits=[]; function walk(dir){ for(const e of readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name); if(e.isDirectory()) walk(p); else if(/\.(ts|js|rs|json|yaml|yml|toml|env)$/i.test(e.name) && !/(^|\.)test\./i.test(e.name)){const lines=readFileSync(p,"utf8").split(/\r?\n/); lines.forEach((line,i)=>{if(pattern.test(line)&&!(/\b(example|fixture|dummy|redacted)\b/i.test(line))) hits.push({file:path.relative(root,p),line:i+1});});}}} for(const r of roots){const p=path.join(root,r); if(existsSync(p)) walk(p);} return hits; }
if(import.meta.main){const hits=scanSecrets(process.cwd()); if(hits.length){console.error(hits.map(h=>`${h.file}:${h.line}`).join("\n"));process.exitCode=1;}else console.log("Secret check passed.");}
