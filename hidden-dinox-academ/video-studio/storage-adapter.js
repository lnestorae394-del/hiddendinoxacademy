"use strict";
/* Адаптеры хранилища видео. Сервер НЕ принимает видео сам: выдаёт защищённую сессию загрузки (возобновляемую) прямо в Firebase Storage и короткоживущие ссылки.
   gcsVideoStorage — настоящий бакет; localVideoStorage — каталог на диске (тесты сквозной обработки); memoryVideoStorage — только метаданные (тесты API). */
const crypto = require("crypto"), fs = require("fs"), path = require("path");
function memoryVideoStorage() {
  const objects = new Map(), deleted = [], sessions = [];
  return {
    kind: "memory", objects, sessions, deleted,
    put(p, { size, contentType = "video/mp4", head = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]) }) { objects.set(p, { size, contentType, head }); },
    async createResumableSession({ path: p, contentType, size, origin }) { this.sessions.push({ path: p, contentType, size, origin }); return { url: "memory://upload/" + p + "?s=" + crypto.randomBytes(6).toString("hex") }; },
    async cancelSession(url) { this.sessions.push({ cancelled: url }); },
    async stat(p) { const o = objects.get(p); return o ? { size: o.size, contentType: o.contentType } : null; },
    async readHead(p, n) { const o = objects.get(p); return o ? o.head.subarray(0, n) : null; },
    async signedReadUrl(p, { ttlSec, filename }) { return "memory://read/" + p + "?ttl=" + ttlSec + (filename ? "&dl=" + encodeURIComponent(filename) : ""); },
    async remove(p) { deleted.push(p); objects.delete(p); },
    async removePrefix(prefix) { for (const k of [...objects.keys()]) if (k.startsWith(prefix)) { deleted.push(k); objects.delete(k); } },
    async readBuffer(p) { const o = objects.get(p); if (!o || !o.data) throw new Error("not found"); return o.data; },
    async writeBuffer(p, buf, contentType = "application/octet-stream") { objects.set(p, { size: buf.length, contentType, head: buf.subarray(0, 16), data: buf }); },
    async setCors(origins) { this.cors = origins; return { ok: true }; }
  };
}
/* Файлы на диске: root/<путь объекта>. Нужен для проверки всего конвейера настоящим FFmpeg без обращения к облаку. */
function localVideoStorage(root) {
  const sessions = [];
  const full = p => { const f = path.join(root, p); if (!f.startsWith(path.resolve(root))) throw new Error("bad path"); return f; };
  return {
    kind: "local", root, sessions, deleted: [],
    put(p, localFile) { fs.mkdirSync(path.dirname(full(p)), { recursive: true }); fs.copyFileSync(localFile, full(p)); },
    async createResumableSession({ path: p, contentType, size, origin }) { sessions.push({ path: p, contentType, size, origin }); return { url: "local://upload/" + p }; },
    async cancelSession() {},
    async stat(p) { try { const s = fs.statSync(full(p)); return { size: s.size, contentType: "application/octet-stream" }; } catch (e) { return null; } },
    async readHead(p, n) { try { const fd = fs.openSync(full(p), "r"), b = Buffer.alloc(n); const k = fs.readSync(fd, b, 0, n, 0); fs.closeSync(fd); return b.subarray(0, k); } catch (e) { return null; } },
    async signedReadUrl(p, { ttlSec, filename }) { return "local://read/" + p + "?ttl=" + ttlSec + (filename ? "&dl=" + encodeURIComponent(filename) : ""); },
    async remove(p) { this.deleted.push(p); try { fs.unlinkSync(full(p)); } catch (e) { /* уже нет */ } },
    async removePrefix(prefix) { this.deleted.push(prefix); fs.rmSync(full(prefix), { recursive: true, force: true }); },
    async download(p, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(full(p), dst); },
    async upload(src, p) { fs.mkdirSync(path.dirname(full(p)), { recursive: true }); fs.copyFileSync(src, full(p)); },
    async readBuffer(p) { return fs.readFileSync(full(p)); },
    async writeBuffer(p, buf) { fs.mkdirSync(path.dirname(full(p)), { recursive: true }); fs.writeFileSync(full(p), buf); },
    async setCors(origins) { this.cors = origins; return { ok: true }; }
  };
}
function gcsVideoStorage({ bucket, now = () => Date.now() }) {
  const notFound = e => e && (e.code === 404 || /No such object|Not Found/i.test(String(e.message)));
  return {
    kind: "gcs",
    async createResumableSession({ path: p, contentType, origin }) { const [url] = await bucket.file(p).createResumableUpload({ metadata: { contentType }, origin, validation: false }); return { url }; },
    async cancelSession(url) { try { await fetch(url, { method: "DELETE", headers: { "Content-Length": "0" } }); } catch (e) { /* сессия и так истечёт */ } },
    async stat(p) { try { const [m] = await bucket.file(p).getMetadata(); return { size: Number(m.size), contentType: m.contentType, generation: m.generation }; } catch (e) { if (notFound(e)) return null; throw e; } },
    async readHead(p, n) { return new Promise((resolve, reject) => { const chunks = []; bucket.file(p).createReadStream({ start: 0, end: n - 1 }).on("data", c => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks))).on("error", e => (notFound(e) ? resolve(null) : reject(e))); }); },
    async signedReadUrl(p, { ttlSec, filename, contentType }) {
      const [url] = await bucket.file(p).getSignedUrl({ version: "v4", action: "read", expires: now() + ttlSec * 1000, ...(filename ? { responseDisposition: "attachment; filename*=UTF-8''" + encodeURIComponent(filename) } : {}), ...(contentType ? { responseType: contentType } : {}) }); return url;
    },
    async remove(p) { await bucket.file(p).delete({ ignoreNotFound: true }); },
    async removePrefix(prefix) { await bucket.deleteFiles({ prefix }); },
    async download(p, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); await bucket.file(p).download({ destination: dst }); },
    async upload(src, p, contentType) { await bucket.upload(src, { destination: p, metadata: { contentType: contentType || "application/octet-stream" }, resumable: fs.statSync(src).size > 5 * 1024 * 1024 }); },
    async readBuffer(p) { const [b] = await bucket.file(p).download(); return b; },
    async writeBuffer(p, buf, contentType) { await bucket.file(p).save(buf, { contentType: contentType || "application/json", resumable: false }); },
    async setCors(origins) { await bucket.setMetadata({ cors: [{ origin: origins, method: ["PUT", "GET", "HEAD", "OPTIONS"], responseHeader: ["Content-Type", "Content-Range", "Range", "x-goog-resumable"], maxAgeSeconds: 3600 }] }); return { ok: true }; }
  };
}

/* Cloudflare R2 adapter. Implements S3-compatible API with SigV4 using Node crypto only (no SDK dependency). */
function r2VideoStorage({ env = process.env, now = () => Date.now(), fetchImpl = fetch }) {
  const account = String(env.R2_ACCOUNT_ID || '').trim();
  const endpointRaw = String(env.R2_ENDPOINT || (account ? `https://${account}.r2.cloudflarestorage.com` : '')).trim();
  const bucket = String(env.R2_BUCKET || env.VIDEO_STUDIO_BUCKET || '').trim();
  const access = String(env.R2_ACCESS_KEY_ID || '').trim(), secret = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  if (!endpointRaw || !bucket || !access || !secret) throw new Error('R2_CONFIG_MISSING: нужны R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  const endpoint = new URL(endpointRaw), region = String(env.R2_REGION || 'auto');
  const enc = v => encodeURIComponent(String(v)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const canonicalPath = key => '/' + enc(bucket) + '/' + String(key).split('/').map(enc).join('/');
  const hash = b => crypto.createHash('sha256').update(b).digest('hex');
  const hmac = (k, v, out) => crypto.createHmac('sha256', k).update(v).digest(out);
  const amzDate = d => d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const signingKey = (date, service='s3') => hmac(hmac(hmac(hmac('AWS4'+secret, date), region), service), 'aws4_request');
  function canonicalQuery(params) { return [...params.entries()].map(([k,v]) => [enc(k),enc(v)]).sort((a,b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])).map(x=>x.join('=')).join('&'); }
  async function request(method, key, { query = new URLSearchParams(), headers = {}, body, payloadHash, presign = false, expires = 900 } = {}) {
    const date = new Date(now()), stamp = amzDate(date), day = stamp.slice(0,8), host = endpoint.host;
    const uri = canonicalPath(key), q = new URLSearchParams(query);
    if (presign) {
      const scope = `${day}/${region}/s3/aws4_request`;
      const signedHeaders = 'host';
      q.set('X-Amz-Algorithm','AWS4-HMAC-SHA256'); q.set('X-Amz-Credential',`${access}/${scope}`); q.set('X-Amz-Date',stamp); q.set('X-Amz-Expires',String(expires)); q.set('X-Amz-SignedHeaders',signedHeaders);
      const cq = canonicalQuery(q), canonical = [method,uri,cq,`host:${host}\n`,signedHeaders,'UNSIGNED-PAYLOAD'].join('\n');
      const toSign = ['AWS4-HMAC-SHA256',stamp,scope,hash(canonical)].join('\n');
      q.set('X-Amz-Signature',hmac(signingKey(day),toSign,'hex'));
      return `${endpoint.origin}${uri}?${canonicalQuery(q)}`;
    }
    const payload = payloadHash || (body === undefined ? hash('') : (Buffer.isBuffer(body) ? hash(body) : hash(String(body))));
    const h = Object.assign({}, headers, { host, 'x-amz-date': stamp, 'x-amz-content-sha256': payload });
    const names = Object.keys(h).map(x=>x.toLowerCase()).sort(), signedHeaders = names.join(';');
    const canonicalHeaders = names.map(n => `${n}:${String(h[n] ?? h[Object.keys(h).find(k=>k.toLowerCase()===n)]).trim().replace(/\s+/g,' ')}\n`).join('');
    const cq = canonicalQuery(q), canonical = [method,uri,cq,canonicalHeaders,signedHeaders,payload].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`, toSign = ['AWS4-HMAC-SHA256',stamp,scope,hash(canonical)].join('\n');
    h.authorization = `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey(day),toSign,'hex')}`;
    const url = `${endpoint.origin}${uri}${cq ? '?'+cq : ''}`;
    const response = await fetchImpl(url,{method,headers:h,body: body === undefined ? undefined : body});
    if (!response.ok) { const t = await response.text().catch(()=> ''); const e = new Error(`R2 ${method} ${response.status}: ${t.slice(0,500)}`); e.status=response.status; e.code='R2_REQUEST_FAILED'; throw e; }
    return response;
  }
  const parseXml = (xml, tag) => { const m=String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>') : null; };
  return {
    kind:'r2', bucket,
    async createMultipartSession({path:p,contentType}) { const r=await request('POST',p,{query:new URLSearchParams([['uploads','']]),headers:{'content-type':contentType||'application/octet-stream'}}); const xml=await r.text(); const uploadId=parseXml(xml,'UploadId'); if(!uploadId) throw new Error('R2_UPLOAD_ID_MISSING'); return {upload_id:uploadId}; },
    async signUploadPart({path:p,uploadId,partNumber,ttlSec=3600}) { return request('PUT',p,{query:new URLSearchParams([['partNumber',String(partNumber)],['uploadId',uploadId]]),presign:true,expires:ttlSec}); },
    async listMultipartParts({path:p,uploadId}) { const r=await request('GET',p,{query:new URLSearchParams([['uploadId',uploadId]])}); const xml=await r.text(), parts=[]; for(const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)){ const x=m[1], n=Number(parseXml(x,'PartNumber')), et=parseXml(x,'ETag'); if(n&&et) parts.push({PartNumber:n,ETag:et}); } return parts; },
    async completeMultipartSession({path:p,uploadId,parts}) { const body='<CompleteMultipartUpload>'+parts.sort((a,b)=>a.PartNumber-b.PartNumber).map(x=>`<Part><PartNumber>${x.PartNumber}</PartNumber><ETag>${String(x.ETag).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</ETag></Part>`).join('')+'</CompleteMultipartUpload>'; await request('POST',p,{query:new URLSearchParams([['uploadId',uploadId]]),headers:{'content-type':'application/xml'},body}); },
    async abortMultipartSession({path:p,uploadId}) { await request('DELETE',p,{query:new URLSearchParams([['uploadId',uploadId]])}).catch(()=>{}); },
    async createResumableSession({path:p,contentType}) { const r=await this.createMultipartSession({path:p,contentType}); return {upload_id:r.upload_id}; },
    async cancelSession() {},
    async stat(p) { try { const r=await request('HEAD',p); return {size:Number(r.headers.get('content-length')||0),contentType:r.headers.get('content-type')||'application/octet-stream',etag:r.headers.get('etag')}; } catch(e) { if(e.status===404) return null; throw e; } },
    async readHead(p,n) { try { const r=await request('GET',p,{headers:{range:`bytes=0-${n-1}`}}); return Buffer.from(await r.arrayBuffer()); } catch(e) { if(e.status===404) return null; throw e; } },
    async signedReadUrl(p,{ttlSec=900,filename,contentType}={}) { const q=new URLSearchParams(); if(filename) q.set('response-content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`); if(contentType) q.set('response-content-type',contentType); return request('GET',p,{query:q,presign:true,expires:ttlSec}); },
    async remove(p) { await request('DELETE',p).catch(e=>{if(e.status!==404) throw e;}); },
    async removePrefix(prefix) { let token; do { const q=new URLSearchParams([['list-type','2'],['prefix',prefix]]); if(token) q.set('continuation-token',token); const r=await request('GET','',{query:q}); const xml=await r.text(), keys=[...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map(m=>m[1]); for(const key of keys) await this.remove(key); token=parseXml(xml,'NextContinuationToken'); } while(token); },
    async download(p,dst) { const r=await request('GET',p); fs.mkdirSync(path.dirname(dst),{recursive:true}); await new Promise((resolve,reject)=>{const out=fs.createWriteStream(dst); require('stream').Readable.fromWeb(r.body).pipe(out).on('finish',resolve).on('error',reject);}); },
    async upload(src,p,contentType) { const stat=fs.statSync(src), type=contentType||'application/octet-stream'; if(stat.size<=64*1024*1024){await request('PUT',p,{headers:{'content-type':type},body:fs.readFileSync(src)});return;} const init=await this.createMultipartSession({path:p,contentType:type}), parts=[], fd=fs.openSync(src,'r'), size=64*1024*1024; try { const count=Math.ceil(stat.size/size); for(let n=1;n<=count;n++){const len=Math.min(size,stat.size-(n-1)*size),buf=Buffer.alloc(len);fs.readSync(fd,buf,0,len,(n-1)*size);const q=new URLSearchParams([['partNumber',String(n)],['uploadId',init.upload_id]]);const r=await request('PUT',p,{query:q,body:buf});const etag=r.headers.get('etag');if(!etag)throw new Error('R2_UPLOAD_ETAG_MISSING');parts.push({PartNumber:n,ETag:etag});} await this.completeMultipartSession({path:p,uploadId:init.upload_id,parts}); } catch(e){await this.abortMultipartSession({path:p,uploadId:init.upload_id});throw e;} finally {fs.closeSync(fd);} },
    async readBuffer(p) { const r=await request('GET',p); return Buffer.from(await r.arrayBuffer()); },
    async writeBuffer(p,buf,contentType) { await request('PUT',p,{headers:{'content-type':contentType||'application/octet-stream'},body:buf}); },
    async setCors(origins) { const xml=`<CORSConfiguration>${origins.map(o=>`<CORSRule><AllowedOrigin>${o}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedMethod>POST</AllowedMethod><AllowedMethod>DELETE</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule>`).join('')}</CORSConfiguration>`; await request('PUT','',{query:new URLSearchParams([['cors','']]),headers:{'content-type':'application/xml'},body:xml}); return {ok:true}; }
  };
}

/* Магические байты: у MP4/MOV на смещении 4 стоит атом ftyp (у старых MOV — moov/mdat/wide/free/skip) */
function looksLikeIsoVideo(head) { if (!head || head.length < 12) return false; return ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(head.subarray(4, 8).toString("latin1")); }
module.exports = { memoryVideoStorage, localVideoStorage, gcsVideoStorage, r2VideoStorage, looksLikeIsoVideo };
