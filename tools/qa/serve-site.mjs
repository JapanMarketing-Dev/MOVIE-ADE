// site/ のプレビュー。Cloudflare Pages に近い動き（/ で終わる URL は index.html、
// 拡張子なしは .html、無いパスは 404.html、site/_headers の「/*」のヘッダー）をまねる。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
const root=resolve('site')
const port=Number(process.env.PORT)||4173
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.json':'application/json','.txt':'text/plain; charset=utf-8','.ico':'image/x-icon','.webp':'image/webp'}
async function globalHeaders(){try{const text=await readFile(resolve(root,'_headers'),'utf8');const out={};let inAll=false;for(const line of text.split('\n')){if(/^\S/.test(line)){inAll=line.trim()==='/*';continue}const m=inAll&&/^\s+([\w-]+):\s*(.+)$/.exec(line);if(m)out[m[1]]=m[2]}return out}catch{return {}}}
async function find(pathname){const rel=decodeURIComponent(pathname).slice(1);const tries=rel===''||rel.endsWith('/')?[rel+'index.html']:extname(rel)?[rel]:[rel+'.html',rel+'/index.html'];for(const t of tries){const file=resolve(root,t);if(file!==root&&!file.startsWith(root+sep))return null;try{return {file,bytes:await readFile(file)}}catch{}}return null}
createServer(async(req,res)=>{const headers=await globalHeaders();try{const url=new URL(req.url,'http://localhost');const hit=await find(url.pathname);if(!hit)throw new Error('not found');res.writeHead(200,{...headers,'Content-Type':types[extname(hit.file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(hit.bytes)}catch{const page=await readFile(resolve(root,'404.html')).catch(()=>'Not found');res.writeHead(404,{...headers,'Content-Type':'text/html; charset=utf-8'});res.end(page)}}).listen(port,'127.0.0.1',()=>console.log(`ADE LP: http://127.0.0.1:${port}`))
