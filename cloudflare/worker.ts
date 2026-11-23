interface D1Result<T> {
  results: T[];
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1Statement;
}

interface R2ObjectBody {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
}

interface R2Bucket {
  put(key: string, value: ReadableStream, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
  get(key: string, options?: { range: { offset: number; length: number } }): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
}

interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ADMIN_USER: string;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
}

interface StudioRow {
  mode: 'playlist' | 'stream' | 'ad';
  source_url: string | null;
  media_id: string | null;
  ad_ends_at: string | null;
  headlines: string;
  updated_at: string;
}

interface MediaRow {
  id: string;
  object_key: string;
  original_name: string;
  media_type: 'image' | 'video';
  mime_type: string;
  file_size: number;
  created_at: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

const base64UrlEncode = (value: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

const base64UrlDecode = (value: string): string => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return atob(padded);
};

async function signToken(user: string, secret: string): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({ sub: user, exp: Math.floor(Date.now() / 1000) + 43200 }));
  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${data}.${encodedSignature}`;
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || !env.JWT_SECRET) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const signature = Uint8Array.from(base64UrlDecode(parts[2]), (char) => char.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return false;
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return payload.sub === env.ADMIN_USER && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  return await isAuthorized(request, env) ? null : json({ error: 'Sessão inválida ou expirada.' }, 401);
}

async function currentState(env: Env): Promise<Record<string, unknown>> {
  let state = await env.DB.prepare('SELECT * FROM studio_state WHERE id = 1').first<StudioRow>();
  if (!state) throw new Error('Estado de transmissão não inicializado. Aplique as migrations D1.');

  if (state.mode === 'ad' && state.ad_ends_at && Date.parse(state.ad_ends_at) <= Date.now()) {
    await env.DB.prepare(`
      UPDATE studio_state
      SET mode = 'playlist', media_id = NULL, ad_ends_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1 AND mode = 'ad' AND ad_ends_at = ?
    `).bind(state.ad_ends_at).run();
    state = await env.DB.prepare('SELECT * FROM studio_state WHERE id = 1').first<StudioRow>();
    if (!state) throw new Error('Não foi possível carregar o estado de transmissão.');
  }

  const media = state.mode === 'ad' && state.media_id
    ? await env.DB.prepare(`
        SELECT id, original_name, media_type, mime_type, file_size
        FROM media WHERE id = ?
      `).bind(state.media_id).first()
    : null;
  const allMedia = await env.DB.prepare(`
    SELECT id, original_name, media_type, mime_type, file_size, created_at
    FROM media ORDER BY created_at, id
  `).all();
  return { ...state, media, media_library: allMedia.results };
}

async function serveMedia(request: Request, env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT object_key, mime_type FROM media WHERE id = ?').bind(id).first<{
    object_key: string;
    mime_type: string;
  }>();
  if (!row) return new Response('Mídia não encontrada.', { status: 404 });

  const rangeHeader = request.headers.get('Range');
  let object: R2ObjectBody | null;
  let status = 200;
  const headers = new Headers({
    'Content-Type': row.mime_type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600'
  });

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match) return new Response(null, { status: 416 });
    const start = match[1] ? Number(match[1]) : null;
    const requestedEnd = match[2] ? Number(match[2]) : null;
    const head = await env.MEDIA.get(row.object_key);
    if (!head) return new Response('Arquivo não encontrado.', { status: 404 });
    const offset = start === null ? Math.max(0, head.size - (requestedEnd || 0)) : start;
    const end = start === null ? head.size - 1 : Math.min(requestedEnd ?? head.size - 1, head.size - 1);
    if (offset >= head.size || end < offset) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
    }
    object = await env.MEDIA.get(row.object_key, { range: { offset, length: end - offset + 1 } });
    if (!object) return new Response('Arquivo não encontrado.', { status: 404 });
    headers.set('Content-Range', `bytes ${offset}-${end}/${head.size}`);
    headers.set('Content-Length', String(end - offset + 1));
    status = 206;
  } else {
    object = await env.MEDIA.get(row.object_key);
    if (!object) return new Response('Arquivo não encontrado.', { status: 404 });
    headers.set('Content-Length', String(object.size));
  }

  return new Response(request.method === 'HEAD' ? null : object.body, { status, headers });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    if (!env.ADMIN_USER || !env.ADMIN_PASSWORD || !env.JWT_SECRET) {
      return json({ error: 'Configure ADMIN_USER, ADMIN_PASSWORD e JWT_SECRET como secrets do Worker.' }, 503);
    }
    const body = await request.json() as { username?: string; password?: string };
    if (body.username !== env.ADMIN_USER || body.password !== env.ADMIN_PASSWORD) {
      return json({ error: 'Usuário ou senha incorretos.' }, 401);
    }
    return json({ token: await signToken(env.ADMIN_USER, env.JWT_SECRET) });
  }

  if (url.pathname === '/api/state' && request.method === 'GET') {
    try {
      return json(await currentState(env));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Falha ao carregar o estado.' }, 503);
    }
  }

  if (url.pathname === '/api/media' && request.method === 'GET') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const result = await env.DB.prepare(`
      SELECT id, original_name, media_type, mime_type, file_size, created_at
      FROM media ORDER BY created_at DESC
    `).all();
    return json({ media: result.results });
  }

  if (url.pathname === '/api/media' && request.method === 'POST') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return json({ error: 'Selecione um arquivo de imagem ou vídeo.' }, 400);
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      return json({ error: 'Apenas arquivos de imagem e vídeo são aceitos.' }, 400);
    }
    if (file.size < 1 || file.size > 50 * 1024 * 1024) {
      return json({ error: 'O arquivo deve ter até 50 MB no plano gratuito.' }, 413);
    }
    const id = crypto.randomUUID();
    const objectKey = `${id}/${file.name.replace(/[^\w.-]/g, '_').slice(-100) || 'media'}`;
    const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
    await env.MEDIA.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type } });
    try {
      await env.DB.prepare(`
        INSERT INTO media (id, object_key, original_name, media_type, mime_type, file_size)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(id, objectKey, file.name, mediaType, file.type, file.size).run();
    } catch (error) {
      await env.MEDIA.delete(objectKey);
      throw error;
    }
    return json({ message: 'Mídia enviada.', media: { id, original_name: file.name, media_type: mediaType, file_size: file.size } }, 201);
  }

  const mediaId = /^\/api\/media\/([0-9a-f-]+)$/i.exec(url.pathname)?.[1];
  if (mediaId && request.method === 'DELETE') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const media = await env.DB.prepare('SELECT object_key FROM media WHERE id = ?').bind(mediaId).first<{ object_key: string }>();
    if (!media) return json({ error: 'Mídia não encontrada.' }, 404);
    await env.MEDIA.delete(media.object_key);
    await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(mediaId).run();
    return json({ message: 'Mídia removida.' });
  }

  if (url.pathname === '/api/studio' && request.method === 'PUT') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const body = await request.json() as { mode?: string; source_url?: string; media_id?: string; duration_seconds?: number };
    if (body.mode === 'playlist') {
      await env.DB.prepare(`
        UPDATE studio_state
        SET mode = 'playlist', source_url = NULL, media_id = NULL, ad_ends_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run();
    } else if (body.mode === 'stream') {
      let source: URL;
      try {
        source = new URL(String(body.source_url || '').trim());
      } catch {
        return json({ error: 'Informe uma URL válida para o canal ou stream.' }, 400);
      }
      if (!['https:', 'http:'].includes(source.protocol)) {
        return json({ error: 'O stream deve usar HTTP ou HTTPS.' }, 400);
      }
      await env.DB.prepare(`
        UPDATE studio_state
        SET mode = 'stream', source_url = ?, media_id = NULL, ad_ends_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).bind(source.toString()).run();
    } else if (body.mode === 'ad') {
      const duration = Number(body.duration_seconds);
      if (!body.media_id || !Number.isInteger(duration) || duration < 5 || duration > 3600) {
        return json({ error: 'Selecione uma mídia e defina duração entre 5 e 3600 segundos.' }, 400);
      }
      const media = await env.DB.prepare('SELECT id FROM media WHERE id = ?').bind(body.media_id).first();
      if (!media) return json({ error: 'Mídia de propaganda não encontrada.' }, 404);
      const adEndsAt = new Date(Date.now() + duration * 1000).toISOString();
      await env.DB.prepare(`
        UPDATE studio_state
        SET mode = 'ad', source_url = NULL, media_id = ?, ad_ends_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).bind(body.media_id, adEndsAt).run();
    } else {
      return json({ error: 'Modo inválido. Use playlist, stream ou ad.' }, 400);
    }
    return json({ message: 'Transmissão atualizada.', state: await currentState(env) });
  }

  if (url.pathname === '/api/headlines' && request.method === 'PUT') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const body = await request.json() as { headlines?: unknown };
    if (typeof body.headlines !== 'string' || body.headlines.length > 5000) {
      return json({ error: 'Informe as manchetes em texto (até 5000 caracteres).' }, 400);
    }
    await env.DB.prepare(`
      UPDATE studio_state SET headlines = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1
    `).bind(body.headlines.trim()).run();
    return json({ message: 'Manchetes atualizadas.' });
  }

  return json({ error: 'Endpoint não encontrado.' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);

      const mediaId = /^\/media\/([0-9a-f-]+)$/i.exec(url.pathname)?.[1];
      if (mediaId && (request.method === 'GET' || request.method === 'HEAD')) {
        return await serveMedia(request, env, mediaId);
      }

      const assetPath = url.pathname === '/' || url.pathname === '/admin'
        ? '/cloudflare-admin.html'
        : url.pathname === '/player'
          ? '/cloudflare-player.html'
          : url.pathname;
      const assetUrl = new URL(request.url);
      assetUrl.pathname = assetPath;
      return await env.ASSETS.fetch(new Request(assetUrl, request));
    } catch (error) {
      console.error('[Worker]', error);
      return json({ error: 'Erro interno ao processar a solicitação.' }, 500);
    }
  }
};
