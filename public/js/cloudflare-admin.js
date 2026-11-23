(function () {
  'use strict';

  const tokenKey = 'tv013_cf_token';
  let token = localStorage.getItem(tokenKey);
  const byId = (id) => document.getElementById(id);
  const loginCard = byId('loginCard');
  const dashboard = byId('dashboard');
  const message = byId('message');

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && token) logout();
    if (!response.ok) throw new Error(data.error || `Falha HTTP ${response.status}`);
    return data;
  }

  function notify(text, isError = false) {
    message.textContent = text;
    message.className = isError ? 'error' : 'muted';
  }

  function logout() {
    token = null;
    localStorage.removeItem(tokenKey);
    dashboard.classList.add('hidden');
    loginCard.classList.remove('hidden');
  }

  async function refresh() {
    const [state, mediaResponse] = await Promise.all([api('/api/state'), api('/api/media')]);
    const media = mediaResponse.media || [];
    byId('sourceStatus').textContent = state.mode === 'stream'
      ? `CANAL AO VIVO — ${state.source_url}`
      : state.mode === 'ad'
        ? `PROPAGANDA — ${state.media?.original_name || 'mídia indisponível'}`
        : 'PROGRAMAÇÃO NORMAL';
    byId('streamUrl').value = state.mode === 'stream' ? state.source_url || '' : '';
    byId('headlines').value = state.headlines || '';
    byId('adMedia').innerHTML = media.length
      ? media.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.original_name)} (${escapeHtml(item.media_type)})</option>`).join('')
      : '<option value="">Envie uma mídia primeiro</option>';
    byId('startAd').disabled = media.length === 0;
    byId('mediaList').innerHTML = media.length
      ? media.map((item) => `
          <div class="media-row">
            <span>${escapeHtml(item.original_name)} <span class="small">(${escapeHtml(item.media_type)}, ${(item.file_size / 1024 / 1024).toFixed(1)} MB)</span></span>
            <button class="btn red" type="button" data-delete-media="${escapeHtml(item.id)}">Remover</button>
          </div>
        `).join('')
      : '<p class="muted">Nenhuma mídia enviada.</p>';
  }

  async function runAction(action) {
    try {
      await action();
      await refresh();
      notify('Alterações salvas.');
    } catch (error) {
      notify(error.message, true);
    }
  }

  byId('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    byId('loginError').textContent = '';
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: byId('username').value, password: byId('password').value })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível entrar.');
      token = data.token;
      localStorage.setItem(tokenKey, token);
      loginCard.classList.add('hidden');
      dashboard.classList.remove('hidden');
      await refresh();
    } catch (error) {
      byId('loginError').textContent = error.message;
    }
  });

  byId('logout').addEventListener('click', logout);
  byId('streamForm').addEventListener('submit', (event) => {
    event.preventDefault();
    runAction(() => api('/api/studio', {
      method: 'PUT',
      body: JSON.stringify({ mode: 'stream', source_url: byId('streamUrl').value.trim() })
    }));
  });
  byId('adForm').addEventListener('submit', (event) => {
    event.preventDefault();
    runAction(() => api('/api/studio', {
      method: 'PUT',
      body: JSON.stringify({
        mode: 'ad',
        media_id: byId('adMedia').value,
        duration_seconds: Number(byId('adDuration').value)
      })
    }));
  });
  byId('returnProgram').addEventListener('click', () => {
    runAction(() => api('/api/studio', { method: 'PUT', body: JSON.stringify({ mode: 'playlist' }) }));
  });
  byId('saveHeadlines').addEventListener('click', () => {
    runAction(() => api('/api/headlines', {
      method: 'PUT',
      body: JSON.stringify({ headlines: byId('headlines').value })
    }));
  });
  byId('uploadForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const file = byId('mediaFile').files[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    byId('uploadButton').disabled = true;
    runAction(() => api('/api/media', { method: 'POST', body: form }))
      .then(() => { byId('mediaFile').value = ''; })
      .finally(() => { byId('uploadButton').disabled = false; });
  });
  byId('mediaList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete-media]');
    if (!button) return;
    runAction(() => api(`/api/media/${encodeURIComponent(button.dataset.deleteMedia)}`, { method: 'DELETE' }));
  });

  if (token) {
    loginCard.classList.add('hidden');
    dashboard.classList.remove('hidden');
    refresh().catch((error) => {
      logout();
      notify(error.message, true);
    });
  }
})();
