interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
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
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  JWT_SECRET?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

const base64UrlEncode = (value: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const base64UrlDecode = (value: string): string =>
  atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));

function uuid(): string {
  return crypto.randomUUID();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signToken(user: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  }));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}`;
}

async function authenticatedUser(request: Request, env: Env): Promise<Record<string, unknown> | null> {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const secret = env.JWT_SECRET || 'tvcorporativa_secret_jwt_key_2026_super_secure';
  if (!token) return null;
  try {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) return null;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      'HMAC', key,
      Uint8Array.from(base64UrlDecode(signature), (char) => char.charCodeAt(0)),
      new TextEncoder().encode(`${header}.${payload}`)
    );
    if (!valid) return null;
    const user = JSON.parse(base64UrlDecode(payload));
    return user.exp > Math.floor(Date.now() / 1000) ? user : null;
  } catch {
    return null;
  }
}

async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  return await authenticatedUser(request, env)
    ? null
    : json({ error: 'Acesso negado. Token de autenticação inválido ou expirado.' }, 401);
}

async function settings(env: Env): Promise<Record<string, string>> {
  const rows = await env.DB.prepare(
    'SELECT key, value FROM system_settings'
  ).all<{ key: string; value: string }>();
  const values: Record<string, string> = {};
  for (const row of rows.results) values[row.key] = row.value;
  return values;
}

async function studio(env: Env): Promise<Record<string, unknown>> {
  let state = await env.DB.prepare('SELECT * FROM studio_state WHERE id = 1')
    .first<Record<string, unknown>>();
  if (!state) state = { id: 1, mode: 'playlist', source_url: null, media_id: null, ad_ends_at: null, headlines: '' };

  if (state.mode === 'ad' && state.ad_ends_at && Date.parse(String(state.ad_ends_at)) <= Date.now()) {
    await env.DB.prepare(`
      UPDATE studio_state SET mode='playlist', source_url=NULL, media_id=NULL, ad_ends_at=NULL
      WHERE id=1
    `).run();
    state = await env.DB.prepare('SELECT * FROM studio_state WHERE id = 1')
      .first<Record<string, unknown>>() ?? state;
  }

  let media = null;
  if (state.media_id) {
    media = await env.DB.prepare(`
      SELECT id, object_key, filename, original_name, media_type, mime_type, file_size,
             duration_seconds, storage_path, source_url
      FROM media WHERE id=?
    `).bind(state.media_id).first();
  }
  return { ...state, media };
}

async function serveMedia(request: Request, env: Env, key: string): Promise<Response> {
  const row = await env.DB.prepare(`
    SELECT object_key, mime_type, file_size
    FROM media
    WHERE id=? OR object_key=? OR filename=? OR storage_path=? LIMIT 1
  `).bind(key, key, key, key).first<{ object_key: string; mime_type: string; file_size: number }>();
  if (!row) return new Response('Arquivo não encontrado.', { status: 404 });

  const object = await env.MEDIA.get(row.object_key);
  if (!object) return new Response('Arquivo não encontrado.', { status: 404 });

  const headers = new Headers({
    'Content-Type': row.mime_type || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600'
  });
  const range = request.headers.get('Range');
  if (!range) {
    headers.set('Content-Length', String(object.size));
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return new Response(null, { status: 416 });
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), object.size - 1) : object.size - 1;
  if (start >= object.size || end < start) {
    headers.set('Content-Range', `bytes */${object.size}`);
    return new Response(null, { status: 416, headers });
  }
  const ranged = await env.MEDIA.get(row.object_key, { range: { offset: start, length: end - start + 1 } });
  if (!ranged) return new Response(null, { status: 404 });
  headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(request.method === 'HEAD' ? null : ranged.body, { status: 206, headers });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  if (path === '/api/health') {
    return json({ status: 'healthy', timestamp: new Date().toISOString(), uptime: 0, version: '2.0.0' });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const body = await request.json() as { username?: string; password?: string };
    if (!body.username || !body.password) return json({ error: 'Usuário e senha são obrigatórios.' }, 400);

    let user = await env.DB.prepare(
      'SELECT id, name, username, password_hash, role FROM users WHERE username=?'
    ).bind(body.username).first<Record<string, unknown>>();

    if (!user && env.ADMIN_USER === body.username && env.ADMIN_PASSWORD === body.password) {
      user = { id: 'admin', name: 'Administrador', username: env.ADMIN_USER, password_hash: '', role: 'admin' };
    }

    if (!user) return json({ error: 'Credenciais inválidas.' }, 401);
    const hash = await sha256(body.password);
    const secret = env.JWT_SECRET || 'tvcorporativa_secret_jwt_key_2026_super_secure';
    if (String(user.password_hash) && String(user.password_hash) !== hash) {
      return json({ error: 'Credenciais inválidas.' }, 401);
    }
    if (!String(user.password_hash) && !(env.ADMIN_USER === body.username && env.ADMIN_PASSWORD === body.password)) {
      return json({ error: 'Credenciais inválidas.' }, 401);
    }
    return json({
      message: 'Autenticação realizada com sucesso.',
      token: await signToken(user, secret),
      user: { id: user.id, name: user.name, username: user.username, role: user.role }
    });
  }

  if (path === '/api/auth/me' && method === 'GET') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const user = await authenticatedUser(request, env);
    return json({ user });
  }

  if (path === '/api/displays' && method === 'GET') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const result = await env.DB.prepare(`
      SELECT d.*, l.name AS layout_name, l.aspect_ratio, p.name AS playlist_name
      FROM displays d
      LEFT JOIN layouts l ON d.layout_id=l.id
      LEFT JOIN playlists p ON d.playlist_id=p.id
      ORDER BY d.code
    `).all();
    return json({ displays: result.results });
  }

  if (path.startsWith('/api/displays/code/') && method === 'GET') {
    const code = decodeURIComponent(path.split('/').pop() || '').trim().toUpperCase();
    const display = await env.DB.prepare(`
      SELECT d.*, l.name AS layout_name, l.aspect_ratio, l.config_json
      FROM displays d LEFT JOIN layouts l ON d.layout_id=l.id
      WHERE UPPER(d.code)=?
    `).bind(code).first<any>();
    if (!display) return json({ error: `Tela com código "${code}" não encontrada.` }, 404);

    let layoutConfig = null;
    try { layoutConfig = display.config_json ? JSON.parse(display.config_json) : null; } catch {}
    let playlist = display.playlist_id
      ? await env.DB.prepare('SELECT * FROM playlists WHERE id=?').bind(display.playlist_id).first<any>()
      : null;
    if (!playlist) playlist = await env.DB.prepare('SELECT * FROM playlists LIMIT 1').first<any>();
    const items = playlist
      ? (await env.DB.prepare(`
          SELECT pi.*, m.filename, m.original_name, m.media_type, m.mime_type, m.storage_path,
                 m.source_url, m.duration_seconds AS media_duration, m.file_size
          FROM playlist_items pi LEFT JOIN media m ON pi.media_id=m.id
          WHERE pi.playlist_id=? AND pi.is_active=1
          ORDER BY pi.order_num
        `).bind(playlist.id).all()).results
      : [];
    const settingsRows = await env.DB.prepare('SELECT key, value FROM system_settings').all<{ key: string; value: string }>();
    const settingsMap: Record<string, string> = {};
    for (const row of settingsRows.results) settingsMap[row.key] = row.value;

    await env.DB.prepare("UPDATE displays SET status='online', last_ping=CURRENT_TIMESTAMP WHERE id=?")
      .bind(display.id).run();

    return json({
      display: {
        id: display.id, name: display.name, code: display.code, layout_id: display.layout_id,
        playlist_id: playlist?.id || null, orientation: display.orientation, resolution: display.resolution,
        location: display.location, show_header: display.show_header !== undefined ? Boolean(display.show_header) : true,
        status: 'online'
      },
      layout: { id: display.layout_id, name: display.layout_name, aspect_ratio: display.aspect_ratio, config: layoutConfig },
      playlist: { id: playlist?.id || null, name: playlist?.name || 'Nenhuma playlist', items },
      studio: await studio(env),
      settings: settingsMap
    });
  }

  if (path === '/api/displays' && method === 'POST') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const body = await request.json() as Record<string, unknown>;
    const name = String(body.name || '').trim();
    const code = String(body.code || '').trim().toUpperCase();
    if (!name || !code) return json({ error: 'Nome e código da tela são obrigatórios.' }, 400);
    const existing = await env.DB.prepare('SELECT id FROM displays WHERE UPPER(code)=?').bind(code).first();
    if (existing) return json({ error: `O código de tela "${code}" já está em uso.` }, 400);
    const id = uuid();
    await env.DB.prepare(`
      INSERT INTO displays (id,name,code,layout_id,playlist_id,orientation,resolution,location,show_header,status)
      VALUES (?,?,?,?,?,?,?,?,?, 'offline')
    `).bind(id, name, code, body.layout_id || 'layout-corporate-news',
      body.playlist_id || 'playlist-default', body.orientation || 'landscape',
      body.resolution || '1920x1080', body.location || '', body.show_header === false ? 0 : 1).run();
    const display = await env.DB.prepare('SELECT * FROM displays WHERE id=?').bind(id).first();
    return json({ message: 'Tela cadastrada com sucesso.', display }, 201);
  }

  const displayIdMatch = /^\/api\/displays\/([^/]+)$/.exec(path);
  if (displayIdMatch && ['GET', 'PUT', 'DELETE'].includes(method)) {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const id = decodeURIComponent(displayIdMatch[1]);
    const display = await env.DB.prepare('SELECT * FROM displays WHERE id=?').bind(id).first<any>();
    if (!display) return json({ error: 'Tela não encontrada.' }, 404);
    if (method === 'GET') return json({ display });
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM displays WHERE id=?').bind(id).run();
      return json({ message: 'Tela removida com sucesso.' });
    }
    const body = await request.json() as Record<string, unknown>;
    const cleanCode = body.code ? String(body.code).trim().toUpperCase() : display.code;
    await env.DB.prepare(`
      UPDATE displays SET name=?, code=?, layout_id=?, playlist_id=?, orientation=?, resolution=?, location=?, show_header=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(
      body.name ? String(body.name).trim() : display.name,
      cleanCode,
      body.layout_id !== undefined ? body.layout_id : display.layout_id,
      body.playlist_id !== undefined ? body.playlist_id : display.playlist_id,
      body.orientation || display.orientation,
      body.resolution || display.resolution,
      body.location !== undefined ? body.location : display.location,
      body.show_header !== undefined ? (body.show_header ? 1 : 0) : display.show_header,
      id
    ).run();
    const updated = await env.DB.prepare('SELECT * FROM displays WHERE id=?').bind(id).first();
    return json({ message: 'Tela atualizada com sucesso.', display: updated });
  }

  if (path === '/api/layouts' && method === 'GET') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const rows = await env.DB.prepare('SELECT * FROM layouts ORDER BY name').all<any>();
    return json({ layouts: rows.results.map((layout) => ({
      ...layout,
      config: layout.config_json ? JSON.parse(layout.config_json) : null
    })) });
  }

  const layoutMatch = /^\/api\/layouts(?:\/([^/]+))?$/.exec(path);
  if (layoutMatch && ['POST', 'GET', 'PUT', 'DELETE'].includes(method)) {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const id = layoutMatch[1];
    if (method === 'GET' && id) {
      const layout = await env.DB.prepare('SELECT * FROM layouts WHERE id=?').bind(decodeURIComponent(id)).first<any>();
      return layout
        ? json({ layout: { ...layout, config: JSON.parse(layout.config_json) } })
        : json({ error: 'Layout não encontrado.' }, 404);
    }
    if (method === 'POST') {
      const body = await request.json() as any;
      if (!body.name || !body.config) return json({ error: 'Nome e configuração do layout são obrigatórios.' }, 400);
      const layoutId = uuid();
      const configJson = typeof body.config === 'string' ? body.config : JSON.stringify(body.config);
      await env.DB.prepare(
        'INSERT INTO layouts (id,name,aspect_ratio,description,config_json) VALUES (?,?,?,?,?)'
      ).bind(layoutId, body.name, body.aspect_ratio || '16:9', body.description || '', configJson).run();
      const layout = await env.DB.prepare('SELECT * FROM layouts WHERE id=?').bind(layoutId).first<any>();
      return json({ message: 'Layout criado com sucesso.', layout: { ...layout, config: JSON.parse(layout.config_json) } }, 201);
    }
    if (id && method === 'PUT') {
      const existing = await env.DB.prepare('SELECT * FROM layouts WHERE id=?').bind(decodeURIComponent(id)).first<any>();
      if (!existing) return json({ error: 'Layout não encontrado.' }, 404);
      const body = await request.json() as any;
      const configJson = typeof body.config === 'string' ? body.config : JSON.stringify(body.config || existing.config_json);
      await env.DB.prepare(`
        UPDATE layouts SET name=?,aspect_ratio=?,description=?,config_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).bind(body.name || existing.name, body.aspect_ratio || '16:9', body.description || '', configJson, decodeURIComponent(id)).run();
      const layout = await env.DB.prepare('SELECT * FROM layouts WHERE id=?').bind(decodeURIComponent(id)).first<any>();
      return json({ message: 'Layout atualizado com sucesso.', layout: { ...layout, config: JSON.parse(layout.config_json) } });
    }
    if (id && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM layouts WHERE id=?').bind(decodeURIComponent(id)).run();
      return json({ message: 'Layout removido com sucesso.' });
    }
  }

  if (path === '/api/playlists' && method === 'GET') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const result = await env.DB.prepare(`
      SELECT p.*, COUNT(pi.id) AS item_count
      FROM playlists p LEFT JOIN playlist_items pi ON pi.playlist_id=p.id
      GROUP BY p.id ORDER BY p.name
    `).all();
    return json({ playlists: result.results });
  }

  if (path === '/api/playlists' && method === 'POST') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const body = await request.json() as any;
    if (!body.name) return json({ error: 'O nome da playlist é obrigatório.' }, 400);
    const id = uuid();
    await env.DB.prepare('INSERT INTO playlists (id,name,description) VALUES (?,?,?)')
      .bind(id, body.name.trim(), body.description || '').run();
    const playlist = await env.DB.prepare('SELECT * FROM playlists WHERE id=?').bind(id).first();
    return json({ message: 'Playlist criada com sucesso.', playlist }, 201);
  }

  const playlistMatch = /^\/api\/playlists\/([^/]+)(?:\/(items|reorder))?$/.exec(path);
  if (playlistMatch && ['GET', 'POST', 'DELETE', 'PUT'].includes(method)) {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const id = decodeURIComponent(playlistMatch[1]);
    const action = playlistMatch[2];
    if (action === 'items' && method === 'POST') {
      const body = await request.json() as any;
      const itemId = uuid();
      const maxRow = await env.DB.prepare('SELECT COALESCE(MAX(order_num),0) AS max_order FROM playlist_items WHERE playlist_id=?')
        .bind(id).first<{ max_order: number }>();
      await env.DB.prepare(`
        INSERT INTO playlist_items (id,playlist_id,media_id,widget_type,widget_config_json,order_num,duration_seconds,is_active)
        VALUES (?,?,?,?,?,?,?,?)
      `).bind(itemId, id, body.media_id || null, body.widget_type || null,
        body.widget_config ? JSON.stringify(body.widget_config) : null,
        (maxRow?.max_order || 0) + 1, body.duration_seconds ? Number(body.duration_seconds) : 10,
        body.is_active === false ? 0 : 1).run();
      const item = await env.DB.prepare('SELECT * FROM playlist_items WHERE id=?').bind(itemId).first();
      return json({ message: 'Item adicionado à playlist com sucesso.', item }, 201);
    }
    if (action === 'reorder' && method === 'POST') {
      const body = await request.json() as { itemIds?: string[] };
      if (!Array.isArray(body.itemIds)) return json({ error: 'Lista de IDs de itens inválida.' }, 400);
      for (let i = 0; i < body.itemIds.length; i++) {
        await env.DB.prepare('UPDATE playlist_items SET order_num=? WHERE id=? AND playlist_id=?')
          .bind(i + 1, body.itemIds[i], id).run();
      }
      return json({ message: 'Itens reordenados com sucesso.' });
    }
    if (!action && method === 'GET') {
      const playlist = await env.DB.prepare('SELECT * FROM playlists WHERE id=?').bind(id).first<any>();
      if (!playlist) return json({ error: 'Playlist não encontrada.' }, 404);
      const items = await env.DB.prepare(`
        SELECT pi.*, m.filename,m.original_name,m.media_type,m.mime_type,m.duration_seconds AS media_duration,m.file_size,m.source_url,m.storage_path
        FROM playlist_items pi LEFT JOIN media m ON pi.media_id=m.id
        WHERE pi.playlist_id=? ORDER BY pi.order_num
      `).bind(id).all();
      return json({ playlist: { ...playlist, items: items.results } });
    }
    if (!action && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM playlists WHERE id=?').bind(id).run();
      return json({ message: 'Playlist removida com sucesso.' });
    }
  }

  const playlistItemMatch = /^\/api\/playlists\/items\/([^/]+)$/.exec(path);
  if (playlistItemMatch && ['PUT', 'DELETE'].includes(method)) {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const id = decodeURIComponent(playlistItemMatch[1]);
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM playlist_items WHERE id=?').bind(id).run();
      return json({ message: 'Item removido da playlist com sucesso.' });
    }
    const body = await request.json() as any;
    const item = await env.DB.prepare('SELECT * FROM playlist_items WHERE id=?').bind(id).first<any>();
    if (!item) return json({ error: 'Item não encontrado.' }, 404);
    await env.DB.prepare(`
      UPDATE playlist_items SET duration_seconds=?,is_active=?,order_num=? WHERE id=?
    `).bind(
      body.duration_seconds !== undefined ? Number(body.duration_seconds) : item.duration_seconds,
      body.is_active !== undefined ? (body.is_active ? 1 : 0) : item.is_active,
      body.order_num !== undefined ? Number(body.order_num) : item.order_num,
      id
    ).run();
    return json({ message: 'Item atualizado com sucesso.' });
  }

  if (path === '/api/media' && method === 'GET') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const result = await env.DB.prepare('SELECT * FROM media ORDER BY created_at DESC').all();
    return json({ media: result.results });
  }

  if ((path === '/api/media/upload' || path === '/api/media') && method === 'POST') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const form = await request.formData();
    const file = form.get('file');
    const sourceUrl = String(form.get('source_url') || '').trim();
    if (!file && !sourceUrl) return json({ error: 'Envie um arquivo ou informe uma URL de streaming.' }, 400);
    const id = uuid();
    if (file && file instanceof File) {
      if (file.size < 1 || file.size > 500 * 1024 * 1024) {
        return json({ error: 'O arquivo deve ter entre 1 byte e 500 MB.' }, 413);
      }
      const objectKey = `${id}/${file.name.replace(/[^\w.-]/g, '_') || 'media'}`;
      await env.MEDIA.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
      const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
      await env.DB.prepare(`
        INSERT INTO media (id,object_key,filename,original_name,media_type,mime_type,file_size,duration_seconds,storage_path,source_url)
        VALUES (?,?,?,?,?,?,?,?,?,NULL)
      `).bind(id, objectKey, objectKey, String(form.get('name') || file.name).trim(), mediaType,
        file.type || 'application/octet-stream', file.size,
        Number(form.get('duration_seconds') || (mediaType === 'video' ? 15 : 10)),
        objectKey).run();
      const media = await env.DB.prepare('SELECT * FROM media WHERE id=?').bind(id).first();
      return json({ message: 'Arquivo enviado com sucesso.', media, url: `/media/${encodeURIComponent(objectKey)}` }, 201);
    }
    try {
      const parsed = new URL(sourceUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      return json({ error: 'Informe uma URL válida de streaming.' }, 400);
    }
    await env.DB.prepare(`
      INSERT INTO media (id,object_key,filename,original_name,media_type,mime_type,file_size,duration_seconds,storage_path,source_url)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).bind(id, `stream/${id}`, 'stream-url', String(form.get('name') || 'Canal de streaming').trim(),
      'video', 'text/stream-url', 0, Number(form.get('duration_seconds') || 15), sourceUrl, sourceUrl).run();
    const media = await env.DB.prepare('SELECT * FROM media WHERE id=?').bind(id).first();
    return json({ message: 'Arquivo enviado com sucesso.', media, url: sourceUrl }, 201);
  }

  const mediaMatch = /^\/api\/media\/([^/]+)$/.exec(path);
  if (mediaMatch && ['PUT', 'DELETE'].includes(method)) {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const id = decodeURIComponent(mediaMatch[1]);
    const media = await env.DB.prepare('SELECT * FROM media WHERE id=?').bind(id).first<any>();
    if (!media) return json({ error: 'Mídia não encontrada.' }, 404);
    if (method === 'DELETE') {
      if (media.object_key && !media.object_key.startsWith('stream/')) await env.MEDIA.delete(media.object_key);
      await env.DB.prepare('DELETE FROM media WHERE id=?').bind(id).run();
      return json({ message: 'Arquivo de mídia removido com sucesso.' });
    }
    const body = await request.json() as any;
    await env.DB.prepare(`
      UPDATE media SET original_name=?,duration_seconds=?,source_url=? WHERE id=?
    `).bind(body.original_name || media.original_name,
      body.duration_seconds ? Number(body.duration_seconds) : (media.duration_seconds || 10),
      body.source_url !== undefined ? body.source_url : (media.source_url || null), id).run();
    const updated = await env.DB.prepare('SELECT * FROM media WHERE id=?').bind(id).first();
    return json({ message: 'Mídia atualizada com sucesso.', media: updated });
  }

  if (path === '/api/queue/recent' && method === 'GET') {
    const calls = await env.DB.prepare(`
      SELECT * FROM queue_calls WHERE status='active' ORDER BY called_at DESC LIMIT 12
    `).all();
    const waiting = await env.DB.prepare(`
      SELECT * FROM queue_calls WHERE status='waiting'
      ORDER BY CASE WHEN service_type='Prioritário' THEN 0 ELSE 1 END, created_at
    `).all();
    const desks = await env.DB.prepare(`
      SELECT * FROM service_desks WHERE is_active=1 ORDER BY category,name
    `).all();
    const services = await env.DB.prepare(`
      SELECT * FROM service_types ORDER BY is_priority DESC,name
    `).all();
    return json({ calls: calls.results, waiting: waiting.results, desks: desks.results, services: services.results });
  }

  if (path === '/api/queue/generate' && method === 'POST') {
    const body = await request.json() as any;
    let service = body.service_id
      ? await env.DB.prepare('SELECT * FROM service_types WHERE id=?').bind(body.service_id).first<any>()
      : await env.DB.prepare('SELECT * FROM service_types LIMIT 1').first<any>();
    if (!service) return json({ error: 'Nenhum tipo de atendimento configurado.' }, 400);
    const nextSeq = Number(service.current_seq || 100) + 1;
    await env.DB.prepare('UPDATE service_types SET current_seq=? WHERE id=?').bind(nextSeq, service.id).run();
    const ticketNumber = `${service.prefix}-${String(nextSeq).padStart(3, '0')}`;
    const id = uuid();
    await env.DB.prepare(`
      INSERT INTO queue_calls (id,ticket_number,location,service_type,service_name,patient_name,status,created_at)
      VALUES (?,?,?,?,?,?, 'waiting', CURRENT_TIMESTAMP)
    `).bind(id, ticketNumber,
      body.preferred_location ? String(body.preferred_location).trim() : 'Aguardando Guichê/Consultório',
      service.is_priority ? 'Prioritário' : 'Normal', service.name,
      body.patient_name ? String(body.patient_name).trim() : null).run();
    const ticket = await env.DB.prepare('SELECT * FROM queue_calls WHERE id=?').bind(id).first();
    return json({ message: `Senha ${ticketNumber} gerada com sucesso!`, ticket }, 201);
  }

  if (path === '/api/queue/call' && method === 'POST') {
    const body = await request.json() as any;
    if (!body.location) return json({ error: 'Local / Guichê / Consultório é obrigatório.' }, 400);
    let called: any;
    if (body.ticket_id || body.call_next) {
      const waiting = body.ticket_id
        ? await env.DB.prepare('SELECT * FROM queue_calls WHERE id=?').bind(body.ticket_id).first<any>()
        : await env.DB.prepare(`
            SELECT * FROM queue_calls WHERE status='waiting'
            ORDER BY CASE WHEN service_type='Prioritário' THEN 0 ELSE 1 END, created_at LIMIT 1
          `).first<any>();
      if (!waiting) return json({ error: 'Nenhuma senha aguardando na fila de espera.' }, 404);
      await env.DB.prepare(`
        UPDATE queue_calls SET location=?,service_name=COALESCE(?,service_name),
          patient_name=COALESCE(?,patient_name),status='active',called_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).bind(body.location.trim(), body.service_name || null, body.patient_name || null, waiting.id).run();
      called = await env.DB.prepare('SELECT * FROM queue_calls WHERE id=?').bind(waiting.id).first();
    } else {
      if (!body.ticket_number) return json({ error: 'Número da senha e local são obrigatórios.' }, 400);
      const id = uuid();
      await env.DB.prepare(`
        INSERT INTO queue_calls (id,ticket_number,location,service_type,service_name,patient_name,status,called_at)
        VALUES (?,?,?,?,?,?, 'active', CURRENT_TIMESTAMP)
      `).bind(id, body.ticket_number.trim().toUpperCase(), body.location.trim(),
        body.service_type || 'Normal', body.service_name || 'Atendimento Geral',
        body.patient_name ? body.patient_name.trim() : null).run();
      called = await env.DB.prepare('SELECT * FROM queue_calls WHERE id=?').bind(id).first();
    }
    return json({ message: `Senha ${called.ticket_number} chamada para ${called.location}!`, call: called }, 201);
  }

  const recallMatch = /^\/api\/queue\/recall\/([^/]+)$/.exec(path);
  if (recallMatch && method === 'POST') {
    const id = decodeURIComponent(recallMatch[1]);
    const existing = await env.DB.prepare('SELECT * FROM queue_calls WHERE id=?').bind(id).first<any>();
    if (!existing) return json({ error: 'Senha não encontrada.' }, 404);
    await env.DB.prepare("UPDATE queue_calls SET called_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
    const called = await env.DB.prepare('SELECT * FROM queue_calls WHERE id=?').bind(id).first();
    return json({ message: 'Senha rechamada com sucesso.', call: called });
  }

  if (path === '/api/queue/desks' && method === 'POST') {
    const body = await request.json() as any;
    if (!body.name) return json({ error: 'Nome do guichê ou consultório é obrigatório.' }, 400);
    const id = uuid();
    await env.DB.prepare('INSERT INTO service_desks (id,name,category,is_active) VALUES (?,?,?,1)')
      .bind(id, body.name.trim(), body.category || 'Consultório').run();
    const desk = await env.DB.prepare('SELECT * FROM service_desks WHERE id=?').bind(id).first();
    return json({ message: 'Guichê/Consultório cadastrado.', desk }, 201);
  }

  const deskMatch = /^\/api\/queue\/desks\/([^/]+)$/.exec(path);
  if (deskMatch && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM service_desks WHERE id=?').bind(decodeURIComponent(deskMatch[1])).run();
    return json({ message: 'Guichê/Consultório removido.' });
  }

  if (path === '/api/queue/services' && method === 'POST') {
    const body = await request.json() as any;
    if (!body.name || !body.prefix) return json({ error: 'Nome do atendimento e prefixo da senha são obrigatórios.' }, 400);
    const id = uuid();
    await env.DB.prepare('INSERT INTO service_types (id,name,prefix,is_priority,current_seq) VALUES (?,?,?,?,100)')
      .bind(id, body.name.trim(), body.prefix.trim().toUpperCase(), body.is_priority ? 1 : 0).run();
    const service = await env.DB.prepare('SELECT * FROM service_types WHERE id=?').bind(id).first();
    return json({ message: 'Tipo de atendimento cadastrado.', service }, 201);
  }

  const serviceMatch = /^\/api\/queue\/services\/([^/]+)$/.exec(path);
  if (serviceMatch && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM service_types WHERE id=?').bind(decodeURIComponent(serviceMatch[1])).run();
    return json({ message: 'Tipo de atendimento removido.' });
  }

  if (path === '/api/queue/clear' && method === 'POST') {
    await env.DB.prepare('DELETE FROM queue_calls').run();
    return json({ message: 'Histórico e fila de senhas limpos com sucesso.' });
  }

  if (path === '/api/settings' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT key,value,description FROM system_settings').all();
    const values: Record<string, string> = {};
    for (const row of rows.results as any[]) values[row.key] = row.value;
    return json({ settings: values, list: rows.results });
  }

  if (path === '/api/settings' && method === 'PUT') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const body = await request.json() as any;
    const values = body.settings && typeof body.settings === 'object' ? body.settings : body;
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length === 0) {
      return json({ error: 'Objeto de configurações inválido.' }, 400);
    }
    for (const [key, value] of Object.entries(values)) {
      await env.DB.prepare(`
        INSERT INTO system_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP
      `).bind(key, String(value ?? '')).run();
    }
    return json({ message: 'Configurações atualizadas com sucesso.' });
  }

  if (path === '/api/settings/reload-screens' && method === 'POST') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    return json({ message: 'Sinal de atualização enviado para as telas.' });
  }

  if (path === '/api/studio/state' && method === 'GET') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    return json({ studio: await studio(env) });
  }

  if (path === '/api/studio/state' && method === 'PUT') {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const body = await request.json() as any;
    if (!['playlist', 'stream', 'ad', 'blank'].includes(body.mode)) {
      return json({ error: 'Modo inválido. Use playlist, stream, ad ou blank.' }, 400);
    }
    if (body.mode === 'playlist' || body.mode === 'blank') {
      await env.DB.prepare(`
        UPDATE studio_state SET mode=?,source_url=NULL,media_id=NULL,ad_ends_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=1
      `).bind(body.mode).run();
    } else if (body.mode === 'stream') {
      try {
        const parsed = new URL(String(body.source_url || '').trim());
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
        await env.DB.prepare(`
          UPDATE studio_state SET mode='stream',source_url=?,media_id=NULL,ad_ends_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=1
        `).bind(parsed.toString()).run();
      } catch {
        return json({ error: 'Informe uma URL válida para o canal ou stream.' }, 400);
      }
    } else {
      const duration = Number(body.duration_seconds);
      if (!body.media_id || !Number.isInteger(duration) || duration < 5 || duration > 3600) {
        return json({ error: 'Selecione uma mídia e informe uma duração entre 5 e 3600 segundos.' }, 400);
      }
      const media = await env.DB.prepare('SELECT id FROM media WHERE id=?').bind(body.media_id).first();
      if (!media) return json({ error: 'Mídia de propaganda não encontrada.' }, 404);
      await env.DB.prepare(`
        UPDATE studio_state SET mode='ad',source_url=NULL,media_id=?,ad_ends_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=1
      `).bind(body.media_id, new Date(Date.now() + duration * 1000).toISOString()).run();
    }
    return json({ message: 'Transmissão atualizada.', studio: await studio(env) });
  }

  if (path === '/api/widgets/weather' && method === 'GET') {
    const s = await settings(env);
    const city = String(url.searchParams.get('city') || s.weather_city || 'São Paulo');
    const lat = String(url.searchParams.get('lat') || s.weather_latitude || '-23.5505');
    const lon = String(url.searchParams.get('lon') || s.weather_longitude || '-46.6333');
    try {
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (!response.ok) throw new Error();
      const data = await response.json() as any;
      const current = data.current || {};
      const code = Number(current.weather_code ?? 0);
      let condition = 'Céu Limpo';
      let icon = '☀️';
      if (code >= 1 && code <= 3) { condition = 'Parcialmente Nublado'; icon = '⛅'; }
      else if (code >= 45 && code <= 48) { condition = 'Nevoeiro'; icon = '🌫️'; }
      else if (code >= 51 && code <= 67) { condition = 'Chuva Leve'; icon = '🌧️'; }
      else if (code >= 71 && code <= 77) { condition = 'Frio Intenso'; icon = '❄️'; }
      else if (code >= 80 && code <= 82) { condition = 'Pancadas de Chuva'; icon = '🌦️'; }
      else if (code >= 95) { condition = 'Tempestade'; icon = '⛈️'; }
      return json({
        city,
        temperature: Math.round(current.temperature_2m ?? 24),
        apparent_temperature: Math.round(current.apparent_temperature ?? 25),
        humidity: current.relative_humidity_2m ?? 60,
        wind_speed: current.wind_speed_10m ?? 10,
        condition,
        icon
      });
    } catch {
      return json({ city, temperature: 24, apparent_temperature: 25, humidity: 65, wind_speed: 12, condition: 'Parcialmente Nublado', icon: '⛅' });
    }
  }

  if (path === '/api/widgets/rss' && method === 'GET') {
    const s = await settings(env);
    const feedUrl = url.searchParams.get('url') || s.rss_feed_url || '';
    const items: any[] = [];
    for (const candidate of feedUrl.split(',').slice(0, 4)) {
      if (!candidate.trim()) continue;
      try {
        const response = await fetch(candidate.trim(), { signal: AbortSignal.timeout(6000) });
        if (!response.ok) continue;
        const xml = await response.text();
        const chunks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
        for (const chunk of chunks.slice(0, 8)) {
          const title = chunk.match(/<(?:title)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:title)>/i)?.[1]
            || chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
          const link = chunk.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]
            || chunk.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1];
          if (title) items.push({ title: title.replace(/<[^>]+>/g, '').trim(), link: link?.trim() || '' });
        }
      } catch {}
    }
    return json({ feedUrl, items });
  }

  return json({ error: 'Endpoint não encontrado.' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);

      const mediaMatch = /^\/media\/(.+)$/.exec(url.pathname);
      if (mediaMatch && (request.method === 'GET' || request.method === 'HEAD')) {
        return await serveMedia(request, env, decodeURIComponent(mediaMatch[1]));
      }

      let assetPath = url.pathname;
      if (url.pathname === '/' || url.pathname === '/admin') assetPath = '/index.html';
      if (url.pathname === '/player') assetPath = '/player.html';
      const assetUrl = new URL(request.url);
      assetUrl.pathname = assetPath;
      return await env.ASSETS.fetch(new Request(assetUrl, request));
    } catch (error) {
      console.error('[Worker]', error);
      return json({ error: 'Erro interno ao processar a solicitação.' }, 500);
    }
  }
};
