const CAMERA_KV_KEY = 'puerta1_camera_session';
const CAMERA_SESSION_TTL_SECONDS = 7200;
const CALLS_API_BASE = 'https://rtc.live.cloudflare.com/v1/apps';
const CALLS_CLOSE_PATH = '/close';
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonResponse(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin)
    }
  });
}

function buildViewerUrl(requestUrl, sessionId, puerta = '1', token = null, viewerBase = null) {
  const base = viewerBase || requestUrl;
  const url = new URL('/viewer-p1.html', base);
  url.searchParams.set('puerta', String(puerta));
  if (sessionId) {
    url.searchParams.set('sessionId', String(sessionId));
  }
  if (token) {
    url.searchParams.set('token', String(token));
  }
  return url.toString();
}

function createLocalSessionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function escapeHtml(value) {
  const text = String(value ?? '');
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function getActiveCameraSession(kv) {
  if (!kv) return null;
  const raw = await kv.get(CAMERA_KV_KEY);
  if (!raw) return null;

  try {
    const session = JSON.parse(raw);
    if (!session || !session.sessionId || !session.startedAt || !Number.isFinite(Number(session.startedAt))) {
      await kv.delete(CAMERA_KV_KEY).catch(() => {});
      return null;
    }

    const now = Date.now();
    const startedAt = Number(session.startedAt);
    const expiresAt = Number(session.expiresAt || startedAt + CAMERA_SESSION_TTL_SECONDS * 1000);

    if (now > expiresAt || now - startedAt > CAMERA_SESSION_TTL_SECONDS * 1000) {
      await kv.delete(CAMERA_KV_KEY).catch(() => {});
      return null;
    }

    return {
      ...session,
      startedAt,
      expiresAt
    };
  } catch (_) {
    await kv.delete(CAMERA_KV_KEY).catch(() => {});
    return null;
  }
}

async function sendTelegramMessage(env, messageText) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en Cloudflare');
  }

  const url = 'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: messageText,
      parse_mode: 'HTML'
    })
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(result));
  }

  return result;
}

function callsConfig(env) {
  const appId = env.CF_CALLS_APP_ID;
  const appSecret = env.CF_CALLS_APP_SECRET;
  if (!appId || !appSecret) return null;
  return {
    appId,
    headers: {
      Authorization: 'Bearer ' + appSecret,
      'Content-Type': 'application/json'
    }
  };
}

function createRandomToken() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch (_) {}
  return 'vt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

async function callsNewSession(cfg) {
  const resp = await fetch(CALLS_API_BASE + '/' + cfg.appId + '/sessions/new', {
    method: 'POST',
    headers: cfg.headers,
    body: '{}'
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.sessionId) {
    throw new Error('Calls crear sesión falló (' + resp.status + '): ' + JSON.stringify(data));
  }
  return data.sessionId;
}

async function callsTracksNew(cfg, sessionId, body) {
  const payload = { tracks: Array.isArray(body.tracks) ? body.tracks : [] };
  if (body.sessionDescription) payload.sessionDescription = body.sessionDescription;
  const resp = await fetch(CALLS_API_BASE + '/' + cfg.appId + '/sessions/' + sessionId + '/tracks/new', {
    method: 'POST',
    headers: cfg.headers,
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error('Calls tracks/new falló (' + resp.status + '): ' + JSON.stringify(data));
  }
  return data;
}

async function callsRenegotiate(cfg, sessionId, sessionDescription) {
  const resp = await fetch(CALLS_API_BASE + '/' + cfg.appId + '/sessions/' + sessionId + '/renegotiate', {
    method: 'PUT',
    headers: cfg.headers,
    body: JSON.stringify({ sessionDescription })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('Calls renegotiate falló (' + resp.status + '): ' + text);
  }
  return resp.json().catch(() => ({}));
}

async function closeCallsSession(cfg, sessionId) {
  if (!cfg || !sessionId) return;
  await fetch(CALLS_API_BASE + '/' + cfg.appId + '/sessions/' + sessionId + CALLS_CLOSE_PATH, {
    method: 'PUT',
    headers: cfg.headers,
    body: JSON.stringify({ sessionDescription: { type: 'unspecified' } })
  }).catch(() => {});
}

function localModeResponse(sessionId, origin) {
  return jsonResponse({
    ok: true,
    localMode: true,
    sessionId: sessionId || createLocalSessionId(),
    appId: null,
    sessionDescription: null,
    tracks: [],
    mensaje: 'Se usa modo local sin negociación WebRTC.'
  }, 200, origin);
}

async function handleCamera(request, env, accion, formData, bodyJson, origin) {
  const kv = env.CAMERA_STATE;

  // helper to extract token from query/form/body
  function extractToken() {
    try {
      const url = new URL(request.url);
      const q = url.searchParams.get('token');
      if (q) return q;
    } catch (_) {}
    if (formData && formData.get) {
      const t = formData.get('token');
      if (t) return t;
    }
    if (bodyJson && bodyJson.token) return bodyJson.token;
    return null;
  }

  if (accion === 'estado') {
    const active = await getActiveCameraSession(kv);
    if (!active) {
      return jsonResponse({ ocupado: false }, 200, origin);
    }

    return jsonResponse({
      ocupado: true,
      iniciadoHace: Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000)),
      modo: active.mode || (callsConfig(env) ? 'sfu' : 'local')
    }, 200, origin);
  }

  if (accion === 'iniciar') {
    const active = await getActiveCameraSession(kv);
    if (active) {
      return jsonResponse({
        ocupado: true,
        mensaje: 'La cámara ya está siendo utilizada. Intenta de nuevo más tarde.',
        sessionId: active.sessionId,
        appId: callsConfig(env) ? callsConfig(env).appId : null,
        localMode: (active.mode !== 'sfu')
      }, 409, origin);
    }

    const startedAt = Date.now();
    const viewerToken = createRandomToken();
    const cfg = callsConfig(env);

    let sessionId;
    let mode;
    if (cfg) {
      try {
        sessionId = await callsNewSession(cfg);
        mode = 'sfu';
      } catch (err) {
        return jsonResponse({ error: err.message }, 502, origin);
      }
    } else {
      sessionId = createLocalSessionId();
      mode = 'local';
    }

    const sessionData = {
      sessionId,
      startedAt,
      expiresAt: startedAt + CAMERA_SESSION_TTL_SECONDS * 1000,
      mode,
      viewerToken,
      tracks: []
    };

    if (kv) {
      await kv.put(CAMERA_KV_KEY, JSON.stringify(sessionData), {
        expirationTtl: CAMERA_SESSION_TTL_SECONDS
      }).catch(() => {});
    }

    const responseBody = {
      ok: true,
      ocupado: false,
      sessionId,
      appId: cfg ? cfg.appId : null,
      viewerToken,
      viewerUrl: buildViewerUrl(request.url, sessionId, '1', viewerToken, env.VIEWER_BASE_URL)
    };
    if (mode === 'local') {
      responseBody.localMode = true;
      responseBody.mensaje = 'Transmisión local activa.';
    }
    return jsonResponse(responseBody, 200, origin);
  }

  if (accion === 'viewer') {
    const active = await getActiveCameraSession(kv);
    if (!active) {
      return jsonResponse({ ocupado: false, mensaje: 'Sin sesión activa de cámara' }, 200, origin);
    }

    // Require token for viewer initialization if session has viewerToken
    if (active.viewerToken) {
      const token = extractToken();
      if (!token || token !== active.viewerToken) {
        return jsonResponse({ error: 'invalid_token' }, 401, origin);
      }
    }

    const cfg = callsConfig(env);
    if (!cfg || active.mode !== 'sfu') {
      return jsonResponse({
        ok: true,
        ocupado: true,
        sessionId: active.sessionId,
        appId: null,
        localMode: true,
        viewerUrl: buildViewerUrl(request.url, active.sessionId, '1', active.viewerToken, env.VIEWER_BASE_URL)
      }, 200, origin);
    }

    let viewerSessionId;
    try {
      viewerSessionId = await callsNewSession(cfg);
    } catch (err) {
      return jsonResponse({ error: err.message }, 502, origin);
    }

    return jsonResponse({
      ok: true,
      ocupado: true,
      sourceSessionId: active.sessionId,
      viewerSessionId,
      appId: cfg.appId,
      sourceTracks: active.tracks || [],
      expiresAt: active.expiresAt,
      viewerUrl: buildViewerUrl(request.url, active.sessionId, '1', active.viewerToken, env.VIEWER_BASE_URL)
    }, 200, origin);
  }

  if (accion === 'tracks-new') {
    const cfg = callsConfig(env);
    const payload = bodyJson || {};
    const sessionId = payload.sessionId || (formData && formData.get('sessionId')) || null;
    const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
    const sessionDescription = payload.sessionDescription || null;

    if (!cfg || !sessionId) {
      return localModeResponse(sessionId, origin);
    }

    try {
      const result = await callsTracksNew(cfg, sessionId, { tracks, sessionDescription });

      const active = await getActiveCameraSession(kv);
      const isPush = tracks.some((t) => (t.location || '') === 'local');
      if (kv && active && isPush && sessionId === active.sessionId && Array.isArray(result.tracks)) {
        active.tracks = result.tracks;
        await kv.put(CAMERA_KV_KEY, JSON.stringify(active), {
          expirationTtl: CAMERA_SESSION_TTL_SECONDS
        }).catch(() => {});
      }

      return jsonResponse(result, 200, origin);
    } catch (err) {
      return jsonResponse({ error: err.message }, 502, origin);
    }
  }

  if (accion === 'renegotiate') {
    const cfg = callsConfig(env);
    const payload = bodyJson || {};
    const sessionId = payload.sessionId || (formData && formData.get('sessionId')) || null;
    const sessionDescription = payload.sessionDescription || null;

    if (!cfg || !sessionId || !sessionDescription) {
      return jsonResponse({
        ok: true,
        localMode: true,
        sessionId: sessionId || createLocalSessionId(),
        mensaje: 'Renegociación omitida en modo local.'
      }, 200, origin);
    }

    try {
      await callsRenegotiate(cfg, sessionId, sessionDescription);
      return jsonResponse({ ok: true, sessionId }, 200, origin);
    } catch (err) {
      return jsonResponse({ error: err.message }, 502, origin);
    }
  }

  if (accion === 'finalizar') {
    const sessionId = (bodyJson && bodyJson.sessionId) || (formData && formData.get('sessionId')) || null;
    const active = await getActiveCameraSession(kv);
    const sid = sessionId || (active && active.sessionId) || null;

    if (sid) {
      await closeCallsSession(callsConfig(env), sid);
      await kv?.delete(CAMERA_KV_KEY).catch(() => {});
      return jsonResponse({ ok: true, sessionId: sid }, 200, origin);
    }

    return jsonResponse({ ok: true }, 200, origin);
  }

  if (accion === 'finalizar-viewer') {
    const sessionId = (bodyJson && bodyJson.sessionId) || (formData && formData.get('sessionId')) || null;
    await closeCallsSession(callsConfig(env), sessionId);
    return jsonResponse({ ok: true, sessionId }, 200, origin);
  }

  return jsonResponse({ error: 'Acción de cámara no reconocida' }, 400, origin);
}

async function handleFormulario(request, env, formData, bodyJson, origin) {
  const nombre = (formData && formData.get('nombre')) || (bodyJson && bodyJson.nombre) || 'No especificado';
  const email = (formData && formData.get('email')) || (bodyJson && bodyJson.email) || 'No especificado';
  const telefono = (formData && formData.get('telefono')) || (bodyJson && bodyJson.telefono) || 'No especificado';
  const motivo = (formData && formData.get('motivo')) || (bodyJson && bodyJson.motivo) || 'No especificado';
  const mensaje = (formData && formData.get('mensaje')) || (bodyJson && bodyJson.mensaje) || 'Sin contenido';
  const puerta = (formData && formData.get('puerta')) || (bodyJson && bodyJson.puerta) || 'Puerta 1';
  const viewerUrl = (formData && formData.get('viewer_url')) || (bodyJson && bodyJson.viewer_url) || '';
  const sessionId = (formData && formData.get('session_id')) || (bodyJson && bodyJson.session_id) || '';

  let activeSessionId = sessionId || '';
  if (!activeSessionId && env.CAMERA_STATE) {
    const active = await getActiveCameraSession(env.CAMERA_STATE);
    if (active && active.sessionId) {
      activeSessionId = active.sessionId;
    }
  }

  const active = env.CAMERA_STATE ? await getActiveCameraSession(env.CAMERA_STATE) : null;
  const tokenForUrl = active && active.viewerToken ? active.viewerToken : null;
  const baseViewerUrl = viewerUrl || (activeSessionId ? buildViewerUrl(request.url, activeSessionId, '1', tokenForUrl, env.VIEWER_BASE_URL) : '');

  const text = [
    '🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽',
    '',
    '📩 NUEVO MENSAJE',
    '',
    '🏠 Puerta: ' + escapeHtml(puerta),
    '👤 Nombre: ' + escapeHtml(nombre),
    '📧 Email: ' + escapeHtml(email),
    '📱 Teléfono: ' + escapeHtml(telefono),
    '📌 Motivo: ' + escapeHtml(motivo),
    '',
    '💬 Mensaje:',
    escapeHtml(mensaje),
    ''
  ];

  if (baseViewerUrl) {
    text.push('🔗 Ver transmisión: <a href="' + escapeHtml(baseViewerUrl) + '">Abrir visor de cámara</a>');
  }

  try {
    const result = await sendTelegramMessage(env, text.join('\n'));
    return jsonResponse({
      success: true,
      tipo: 'formulario',
      viewer_url: baseViewerUrl,
      result
    }, 200, origin);
  } catch (err) {
    return jsonResponse({
      success: false,
      error: err.message || 'Error al enviar el formulario a Telegram',
      tipo: 'formulario'
    }, 500, origin);
  }
}

async function handleTimbre(env, origin, bodyJson, formData) {
  const now = Date.now();
  const clave = 'puerta1_timbre';
  const treintaMinutos = 30 * 60 * 1000;

  let cantidad = 0;
  let inicioBloqueo = null;

  if (env.TIMBRE_KV) {
    try {
      const estado = await env.TIMBRE_KV.get(clave, 'json');
      if (estado) {
        cantidad = estado.cantidad || 0;
        inicioBloqueo = estado.inicioBloqueo || null;
      }
    } catch (e) {
      console.error('Error al leer de KV:', e);
    }

    if (inicioBloqueo) {
      const transcurrido = now - inicioBloqueo;
      if (transcurrido < treintaMinutos) {
        const restanteMs = treintaMinutos - transcurrido;
        const restanteMinutos = Math.ceil(restanteMs / 60000);
        return jsonResponse({
          success: false,
          tipo: 'timbre',
          bloqueado: true,
          minutos_restantes: restanteMinutos,
          error: 'Timbre bloqueado. Faltan ' + restanteMinutos + ' minutos para volver a utilizarlo.'
        }, 429, origin);
      }
      cantidad = 0;
      inicioBloqueo = null;
    }

    if (cantidad >= 3) {
      return jsonResponse({
        success: false,
        tipo: 'timbre',
        bloqueado: true,
        minutos_restantes: 30,
        error: 'Se alcanzó el límite de 3 toques. El timbre estará disponible nuevamente en 30 minutos.'
      }, 429, origin);
    }

    cantidad += 1;
    if (cantidad === 3) {
      inicioBloqueo = now;
    }

    try {
      await env.TIMBRE_KV.put(clave, JSON.stringify({ cantidad, inicioBloqueo }));
    } catch (e) {
      console.error('Error al guardar en KV:', e);
    }
  }

  const textoTimbre = [
    '🔔🔔🔔🔔🔔🔔🔔🔔🔔',
    '',
    '*🔔ESTÁN TOCANDO EL TIMBRE🔔*',
    cantidad === 3 ? '\n⚠️ Se alcanzó el límite de 3 toques.\n⏳ Podrá volver a tocarse en 30 minutos.' : ''
  ].join('\n');

  try {
    const telegramResponse = await sendTelegramMessage(env, textoTimbre);
    return jsonResponse({
      success: true,
      tipo: 'timbre',
      bloqueado: cantidad === 3,
      toques_realizados: cantidad,
      result: telegramResponse
    }, 200, origin);
  } catch (err) {
    return jsonResponse({
      success: false,
      error: err.message || 'Error al enviar el timbre a Telegram',
      tipo: 'timbre'
    }, 500, origin);
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '*';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    let tipo = url.searchParams.get('tipo') || '';
    let accion = url.searchParams.get('accion') || '';

    let formData = null;
    let bodyJson = null;

    if (request.method === 'POST' || request.method === 'PUT') {
      const contentType = request.headers.get('Content-Type') || '';

      if (contentType.includes('application/json')) {
        try {
          bodyJson = await request.json();
        } catch (_) {}
      }

      if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
        try {
          formData = await request.formData();
        } catch (_) {}
      }

      if (!bodyJson && !formData) {
        try {
          const text = await request.text();
          if (text) {
            try {
              bodyJson = JSON.parse(text);
            } catch (_) {
              const parsed = new URLSearchParams(text);
              if (parsed.size) {
                bodyJson = Object.fromEntries(parsed.entries());
              }
            }
          }
        } catch (_) {}
      }

      if (formData) {
        tipo = tipo || formData.get('tipo') || '';
        accion = accion || formData.get('accion') || '';
      }
      if (bodyJson) {
        tipo = tipo || bodyJson.tipo || '';
        accion = accion || bodyJson.accion || '';
      }
    }

    if (request.method === 'GET') {
      tipo = tipo || url.searchParams.get('tipo') || '';
      accion = accion || url.searchParams.get('accion') || '';
    }

    if (tipo === 'camara') {
      return handleCamera(request, env, accion, formData, bodyJson, origin);
    }

    if (tipo === 'timbre') {
      return handleTimbre(env, origin, bodyJson, formData);
    }

    if (tipo === 'formulario') {
      return handleFormulario(request, env, formData, bodyJson, origin);
    }

    if (request.method === 'GET') {
      return jsonResponse({
        ok: true,
        mensaje: 'Worker activo',
        tipo,
        accion
      }, 200, origin);
    }

    return jsonResponse({ error: 'Solicitud no reconocida' }, 400, origin);
  }
};
