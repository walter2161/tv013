(function () {
  'use strict';
  const stage = document.getElementById('stage');
  const headlinesEl = document.getElementById('headlines');
  let media = [];
  let index = 0;
  let timer = null;
  let adTimer = null;
  let fingerprint = '';
  let audioEnabled = false;

  function streamElement(url) {
    const source = String(url || '');
    let parsed;
    try {
      parsed = new URL(source);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('protocolo');
    } catch {
      return null;
    }
    let videoId = '';
    if (parsed.hostname === 'youtu.be') videoId = parsed.pathname.slice(1);
    if (parsed.hostname.endsWith('youtube.com')) videoId = parsed.searchParams.get('v') || parsed.pathname.match(/\/(?:live|embed)\/([^/]+)/)?.[1] || '';
    if (videoId) {
      const frame = document.createElement('iframe');
      frame.src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&mute=${audioEnabled ? 0 : 1}&rel=0`;
      frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      frame.allowFullscreen = true;
      return frame;
    }
    if (/\.(mp4|webm|m3u8|ogg)(?:$|[?#])/i.test(source)) {
      const video = document.createElement('video');
      video.src = source;
      video.autoplay = true;
      video.controls = false;
      video.playsInline = true;
      video.muted = !audioEnabled;
      return video;
    }
    const frame = document.createElement('iframe');
    frame.src = source;
    frame.allow = 'autoplay; encrypted-media; fullscreen';
    frame.allowFullscreen = true;
    return frame;
  }

  function showMedia(item, onEnd) {
    stage.replaceChildren();
    if (!item) {
      const placeholder = document.createElement('div');
      placeholder.id = 'message';
      placeholder.textContent = 'Nenhuma mídia cadastrada.';
      stage.appendChild(placeholder);
      return;
    }
    const element = item.media_type === 'video' ? document.createElement('video') : document.createElement('img');
    element.src = `/media/${encodeURIComponent(item.id)}`;
    if (element.tagName === 'VIDEO') {
      element.autoplay = true;
      element.playsInline = true;
      element.controls = false;
      element.muted = !audioEnabled;
      element.addEventListener('ended', onEnd, { once: true });
      element.addEventListener('error', onEnd, { once: true });
      element.play().catch(() => {});
    } else {
      clearTimeout(timer);
      timer = setTimeout(onEnd, 10000);
    }
    stage.replaceChildren(element);
  }

  function render(state) {
    clearTimeout(timer);
    clearTimeout(adTimer);
    media = state.media_library || [];
    headlinesEl.textContent = (state.headlines || '').split('\n').filter(Boolean).join('     •     ');
    if (state.mode === 'stream') {
      const element = streamElement(state.source_url);
      stage.replaceChildren(element || Object.assign(document.createElement('div'), { id: 'message', textContent: 'URL de stream inválida.' }));
      return;
    }
    if (state.mode === 'ad') {
      showMedia(state.media, () => {});
      const remaining = Date.parse(state.ad_ends_at || '') - Date.now();
      if (Number.isFinite(remaining)) adTimer = setTimeout(loadState, Math.max(0, remaining));
      return;
    }
    index = media.length ? index % media.length : 0;
    const next = () => {
      if (!media.length) return showMedia(null, () => {});
      index = (index + 1) % media.length;
      showMedia(media[index], next);
    };
    showMedia(media[index], next);
  }

  async function loadState() {
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const state = await response.json();
      const nextFingerprint = JSON.stringify([
        state.mode, state.source_url, state.media_id, state.ad_ends_at, state.updated_at, state.headlines,
        (state.media_library || []).map((item) => `${item.id}:${item.created_at}`)
      ]);
      if (nextFingerprint !== fingerprint) {
        fingerprint = nextFingerprint;
        render(state);
      } else if (state.mode === 'ad' && !adTimer) {
        const remaining = Date.parse(state.ad_ends_at || '') - Date.now();
        if (Number.isFinite(remaining)) adTimer = setTimeout(loadState, Math.max(0, remaining));
      }
    } catch (error) {
      console.error('[Player] Falha ao consultar transmissão:', error);
    }
  }

  document.getElementById('audioButton').addEventListener('click', () => {
    audioEnabled = !audioEnabled;
    document.getElementById('audioButton').textContent = audioEnabled ? 'Áudio ativado' : 'Ativar áudio';
    fingerprint = '';
    loadState();
  });
  loadState();
  setInterval(loadState, 15000);
})();
