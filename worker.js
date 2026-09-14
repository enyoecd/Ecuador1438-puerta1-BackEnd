// ═══════════════════════════════════════════════════════════════
//  Worker: puerta1-ecuador1438  (Ecuador1438 — Puerta 1)
//
//  Integra Cloudflare Calls (Realtime SFU) para la transmisión de
//  video en vivo del timbre. Usa las variables de entorno YA
//  existentes en Cloudflare:
//      env.ID_app     → App ID de Cloudflare Calls
//      env.Token_API  → Token (app secret) de Cloudflare Calls
//
//  Endpoints:
//    GET/POST tipo=camara (accion=estado) → estado de la sesión
//    POST tipo=camara (accion=iniciar)    → crea sesión SFU y envía
//                                            el enlace del visor a Telegram
//    POST tipo=camara (accion=tracks-new) → publica/suscribe tracks en el SFU
//    POST tipo=camara (accion=renegotiate)→ responde a renegociación del SFU
//    POST tipo=camara (accion=latido)     → renueva el lease del emisor activo
//    POST tipo=camara (accion=finalizar)  → cierra la sesión del publicador
//    POST tipo=camara (accion=finalizar-viewer) → cierra sesión del visor
//    POST tipo=camara (accion=viewer)     → prepara sesión para el visor
//    POST tipo=timbre                     → notificación de timbre a Telegram
//    POST tipo=formulario                 → reenvío de formulario a Telegram
//
//  Variables de entorno:
//    ID_app, Token_API                 → Cloudflare Calls (requeridas)
//    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID → Telegram (ya existentes)
//    VIEWER_BASE_URL                   → host público del frontend
//                                        (ej. https://enyoecd.github.io/Ecuador1438)
//    CAMERA_STATE  (KV binding, opcional) → estado de sesión persistente
//    TIMBRE_KV     (KV binding, opcional) → límite de toques del timbre
// ═══════════════════════════════════════════════════════════════

const CAMERA_KV_KEY = 'puerta1_camera_session';
// Tope duro de vida útil de la sesión: las transmisiones duran máximo 5:00 y a
// eso se le suma el cooldown de 1 min, así que una sesión real nunca pasa de 6
// minutos. Este límite solo actúa como red de seguridad si el lease (1 min,
// renovado por "latido") no se pudiera limpiar por un fallo.
const CAMERA_SESSION_TTL_SECONDS = 6 * 60;
// Lease renovable por el emisor mientras transmite. Si la página se cierra sin
// avisar, este lease expira y el estado "en uso" se libera solo (sin bloqueo
// fantasma). El emisor renueva cada ~20 s con la acción "latido".
const CAMERA_LEASE_MS = 60 * 1000;
// TTL con el que se escriben/renuevan las claves en KV (un poco mayor que el
// lease para que KV limpie solo los restos).
const CAMERA_KV_EXPIRATION_TTL = 180;
const CALLS_API_BASE = 'https://rtc.live.cloudflare.com/v1/apps';
const CALLS_CLOSE_PATH = '/close';

// ═══════════════════════════════════════════════════════════════
//  MEMORIA LOCAL (fallback si no hay binding KV)
// ═══════════════════════════════════════════════════════════════
const memoStore = new Map();

async function getCameraSession(env) {
  const ttlMs = CAMERA_SESSION_TTL_SECONDS * 1000;
  let raw = null;
  if (env.CAMERA_STATE) {
    raw = await env.CAMERA_STATE.get(CAMERA_KV_KEY).catch(() => null);
  } else {
    raw = memoStore.get(CAMERA_KV_KEY) || null;
  }
  if (!raw) return null;

  let session = null;
  try {
    session = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    await deleteCameraSession(env);
    return null;
  }

  const now = Date.now();
  // `expiresAt` es un lease corto renovado por el emisor (latido); si expiró,
  // la sesión se considera libre y se limpia. Como respaldo duro también se
  // valida contra el límite absoluto de 6 minutos desde el inicio (máximo real
  // de una transmisión: 5:00 + cooldown de 1 min).
  if (
    !session ||
    !session.sessionId ||
    !Number.isFinite(Number(session.startedAt)) ||
    now > (Number(session.expiresAt) || Number(session.startedAt) + ttlMs)
  ) {
    await deleteCameraSession(env);
    return null;
  }
  return session;
}

async function setCameraSession(env, data) {
  const value = JSON.stringify(data);
  if (env.CAMERA_STATE) {
    await env.CAMERA_STATE.put(CAMERA_KV_KEY, value, {
      expirationTtl: CAMERA_KV_EXPIRATION_TTL
    }).catch(() => {});
  } else {
    memoStore.set(CAMERA_KV_KEY, value);
  }
}

async function deleteCameraSession(env) {
  if (env.CAMERA_STATE) {
    await env.CAMERA_STATE.delete(CAMERA_KV_KEY).catch(() => {});
  } else {
    memoStore.delete(CAMERA_KV_KEY);
  }
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS HTTP
// ═══════════════════════════════════════════════════════════════
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
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

function createLocalSessionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

// ═══════════════════════════════════════════════════════════════
//  CONFIGURACIÓN CLOUDFLARE CALLS (env.ID_app / env.Token_API)
// ═══════════════════════════════════════════════════════════════
function callsConfig(env) {
  const appId = env.ID_app;
  const appSecret = env.Token_API;
  if (!appId || !appSecret) return null;
  return {
    appId,
    headers: {
      Authorization: 'Bearer ' + appSecret,
      'Content-Type': 'application/json'
    }
  };
}

// ═══════════════════════════════════════════════════════════════
//  URL PÚBLICA DEL VISOR
// ═══════════════════════════════════════════════════════════════
function buildViewerUrl(request, env) {
  const base = String(env.VIEWER_BASE_URL || '').replace(/\/+$/, '');
  if (base) {
    return base + '/viewer-p1.html';
  }
  return new URL('/viewer-p1.html', request.url).toString();
}

// ═══════════════════════════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════════════════════════
async function sendTelegramMessage(env, text, parseMode = null) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en Cloudflare');
  }
  const url = 'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage';
  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: text
  };
  if (parseMode) payload.parse_mode = parseMode;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(result));
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
//  CLOUDFLARE CALLS SFU — API
// ═══════════════════════════════════════════════════════════════
async function callsNewSession(cfg, sessionDescription) {
  const body = sessionDescription ? { sessionDescription } : {};
  const resp = await fetch(CALLS_API_BASE + '/' + cfg.appId + '/sessions/new', {
    method: 'POST',
    headers: cfg.headers,
    body: JSON.stringify(body)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.sessionId) {
    throw new Error('Calls crear sesión falló (' + resp.status + '): ' + JSON.stringify(data));
  }
  return data;
}

async function callsTracksNew(cfg, sessionId, payload) {
  const body = { tracks: Array.isArray(payload.tracks) ? payload.tracks : [] };
  if (payload.sessionDescription) body.sessionDescription = payload.sessionDescription;
  const resp = await fetch(CALLS_API_BASE + '/' + cfg.appId + '/sessions/' + sessionId + '/tracks/new', {
    method: 'POST',
    headers: cfg.headers,
    body: JSON.stringify(body)
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
    body: '{}'
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
//  HANDLER CÁMARA.
// ═══════════════════════════════════════════════════════════════
async function handleCamera(request, env, accion, formData, bodyJson, origin) {
  const cfg = callsConfig(env);

  // ── ESTADO (GET) ──────────────────────────────────────────────
  if (accion === 'estado') {
    const active = await getCameraSession(env);
    if (!active) {
      return jsonResponse({ ocupado: false }, 200, origin);
    }
    return jsonResponse({
      ocupado: true,
      iniciadoHace: Math.max(0, Math.floor((Date.now() - Number(active.startedAt)) / 1000)),
      sessionId: active.sessionId
    }, 200, origin);
  }

  // ── INICIAR (POST) ────────────────────────────────────────────
  if (accion === 'iniciar') {
    if (!cfg) {
      return jsonResponse({
        error: 'Cloudflare Calls no configurado. Agrega ID_app y Token_API como secrets del Worker.'
      }, 503, origin);
    }

    const active = await getCameraSession(env);
    if (active) {
      return jsonResponse({
        ocupado: true,
        mensaje: 'La cámara ya está siendo utilizada. Intenta de nuevo más tarde.',
        sessionId: active.sessionId,
        appId: cfg.appId
      }, 409, origin);
    }

    const clientOffer = (bodyJson && bodyJson.sessionDescription) || null;
    let created;
    try {
      created = await callsNewSession(cfg, clientOffer);
    } catch (err) {
      return jsonResponse({ error: 'Error creando sesión de video: ' + err.message }, 502, origin);
    }
    const sessionId = created.sessionId;

    const startedAt = Date.now();
    await setCameraSession(env, {
      sessionId,
      startedAt,
      expiresAt: startedAt + CAMERA_LEASE_MS,
      tracks: [],
      telegramSent: false
    });

    return jsonResponse({
      ok: true,
      ocupado: false,
      sessionId,
      sessionDescription: created.sessionDescription || null,
      appId: cfg.appId
    }, 200, origin);
  }

  // ── PREPARAR VISOR (POST) ─────────────────────────────────────
  if (accion === 'viewer') {
    const active = await getCameraSession(env);
    if (!active) {
      return jsonResponse({ ocupado: false, mensaje: 'Sin transmisión activa' }, 200, origin);
    }
    if (!cfg) {
      return jsonResponse({
        error: 'Cloudflare Calls no configurado. Agrega ID_app y Token_API como secrets del Worker.'
      }, 503, origin);
    }

    const viewerOffer = (bodyJson && bodyJson.sessionDescription) || null;
    let createdViewer;
    try {
      createdViewer = await callsNewSession(cfg, viewerOffer);
    } catch (err) {
      return jsonResponse({ error: err.message }, 502, origin);
    }
    const viewerSessionId = createdViewer.sessionId;

    return jsonResponse({
      ok: true,
      ocupado: true,
      sourceSessionId: active.sessionId,
      viewerSessionId,
      sessionDescription: createdViewer.sessionDescription || null,
      appId: cfg.appId,
      sourceTracks:
        Array.isArray(active.tracks) && active.tracks.length
          ? active.tracks
          : [{ trackName: 'video' }, { trackName: 'audio' }],
      viewerUrl: buildViewerUrl(request, env)
    }, 200, origin);
  }

  // ── PUBLICAR / SUSCRIBIR TRACKS (POST) ────────────────────────
  if (accion === 'tracks-new') {
    const payload = bodyJson || {};
    const sessionId = payload.sessionId || (formData && formData.get('sessionId')) || null;
    if (!cfg) {
      return jsonResponse({
        error: 'Cloudflare Calls no configurado. Agrega ID_app y Token_API como secrets del Worker.'
      }, 503, origin);
    }
    if (!sessionId) {
      return jsonResponse({ error: 'Falta sessionId' }, 400, origin);
    }

    try {
      const result = await callsTracksNew(cfg, sessionId, {
        sessionDescription: payload.sessionDescription || null,
        tracks: Array.isArray(payload.tracks) ? payload.tracks : []
      });

      const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
      const localTracks = tracks.filter((t) => (t.location || '') === 'local');
      const isPush = localTracks.length > 0;

      // El publicador acaba de conectar su cámara al SFU:
      // guardar tracks publicados y enviar automáticamente a Telegram
      // la URL pública del visor (SOLO la URL), para que el destinatario
      // abra el enlace desde el chat y vea el streaming en vivo.
      const active = await getCameraSession(env);
      if (active && sessionId === active.sessionId) {
        if (isPush) {
          // Reconstruir la lista de tracks publicados garantizando que el visor
          // reciba SIEMPRE video y audio. Evita que una respuesta incompleta del
          // SFU (solo audio) deje el video en negro en el visor.
          const porNombre = {};
          (Array.isArray(active.tracks) ? active.tracks : [])
            .concat(localTracks)
            .forEach(function (t) {
              if (t && t.trackName && t.mid) porNombre[t.trackName] = t;
            });
          ['video', 'audio'].forEach(function (n) {
            if (!porNombre[n]) porNombre[n] = { location: 'local', mid: String(n), trackName: n };
          });
          active.tracks = Object.keys(porNombre).map(function (n) { return porNombre[n]; });
        } else if (Array.isArray(result.tracks) && result.tracks.length) {
          active.tracks = result.tracks;
        }
        // Cualquier actividad del emisor renueva el lease de la sesión.
        active.expiresAt = Date.now() + CAMERA_LEASE_MS;

        if (isPush) {
          let telegramEnviado = false;
          let telegramError = null;
          if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && !active.telegramSent) {
            try {
              await sendTelegramMessage(env, buildViewerUrl(request, env));
              telegramEnviado = true;
              active.telegramSent = true;
            } catch (err) {
              telegramError = err.message || 'Error al enviar a Telegram';
              console.error('Error al enviar el enlace del visor a Telegram:', telegramError);
            }
          }
          await setCameraSession(env, active);
          return jsonResponse({ ...result, telegramEnviado, telegramError }, 200, origin);
        }
        await setCameraSession(env, active);
      }

      return jsonResponse(result, 200, origin);
    } catch (err) {
      return jsonResponse({ error: err.message }, 502, origin);
    }
  }

  // ── RENEGOCIAR (POST) ─────────────────────────────────────────
  if (accion === 'renegotiate') {
    const payload = bodyJson || {};
    const sessionId = payload.sessionId || (formData && formData.get('sessionId')) || null;
    const sessionDescription = payload.sessionDescription || null;
    if (!cfg) {
      return jsonResponse({
        error: 'Cloudflare Calls no configurado. Agrega ID_app y Token_API como secrets del Worker.'
      }, 503, origin);
    }
    if (!sessionId || !sessionDescription) {
      return jsonResponse({ error: 'Faltan sessionId o sessionDescription' }, 400, origin);
    }

    try {
      await callsRenegotiate(cfg, sessionId, sessionDescription);
      return jsonResponse({ ok: true, sessionId }, 200, origin);
    } catch (err) {
      return jsonResponse({ error: err.message }, 502, origin);
    }
  }

  // ── LATIDO (heartbeat del emisor) ──────────────────────────────
  // Renueva el lease corto de la sesión mientras la página emisora sigue
  // transmitiendo. Si el emisor desaparece (cierra la pestaña o cae sin avisar),
  // el lease expira y "estado" deja de reportar "ocupado".
  if (accion === 'latido') {
    const active = await getCameraSession(env);
    if (!active) {
      return jsonResponse({ ok: true, ocupado: false }, 200, origin);
    }
    const sid =
      (bodyJson && bodyJson.sessionId) ||
      (formData && formData.get('sessionId')) || null;
    if (!sid || sid !== active.sessionId) {
      return jsonResponse({ ok: true, ocupado: false }, 200, origin);
    }
    active.expiresAt = Date.now() + CAMERA_LEASE_MS;
    await setCameraSession(env, active);
    return jsonResponse({ ok: true, ocupado: true }, 200, origin);
  }

  // ── FINALIZAR PUBLICADOR (POST) ───────────────────────────────
  if (accion === 'finalizar') {
    const sessionId =
      (bodyJson && bodyJson.sessionId) ||
      (formData && formData.get('sessionId')) || null;
    const active = await getCameraSession(env);
    const sid = sessionId || (active && active.sessionId) || null;

    if (sid) {
      await closeCallsSession(cfg, sid);
      await deleteCameraSession(env);
      return jsonResponse({ ok: true, sessionId: sid }, 200, origin);
    }
    return jsonResponse({ ok: true }, 200, origin);
  }

  // ── FINALIZAR VISOR (POST) ────────────────────────────────────
  if (accion === 'finalizar-viewer') {
    const sessionId =
      (bodyJson && bodyJson.sessionId) ||
      (formData && formData.get('sessionId')) || null;
    await closeCallsSession(cfg, sessionId);
    return jsonResponse({ ok: true, sessionId }, 200, origin);
  }

  return jsonResponse({ error: 'Acción de cámara no reconocida' }, 400, origin);
}

// ═══════════════════════════════════════════════════════════════
//  TIMBRE (comportamiento original preservado)
// ═══════════════════════════════════════════════════════════════
async function handleTimbre(request, env, origin, bodyJson, formData) {
  const ahora = Date.now();
  const clave = 'puerta1_timbre';
  let cantidad = 0;
  let inicioBloqueo = null;
  const treintaMinutos = 30 * 60 * 1000;

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
      const transcurrido = ahora - inicioBloqueo;
      if (transcurrido < treintaMinutos) {
        const restanteMinutos = Math.ceil((treintaMinutos - transcurrido) / 60000);
        return jsonResponse({
          success: false,
          tipo: 'timbre',
          bloqueado: true,
          minutos_restantes: restanteMinutos,
          error: `Timbre bloqueado. Faltan ${restanteMinutos} minutos para volver a utilizarlo.`
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

    cantidad++;
    if (cantidad === 3) {
      inicioBloqueo = ahora;
    }

    try {
      await env.TIMBRE_KV.put(clave, JSON.stringify({ cantidad, inicioBloqueo }));
    } catch (e) {
      console.error('Error al guardar en KV:', e);
    }
  } else {
    cantidad = 1;
  }

  let textoTimbre = `🔔🔔🔔🔔🔔🔔🔔🔔🔔\n\n*🔔ESTÁN TOCANDO EL TIMBRE🔔*`;
  if (cantidad === 3) {
    textoTimbre += `\n\n⚠️ Se alcanzó el límite de 3 toques.`;
    textoTimbre += `\n⏳ Podrá volver a tocarse en 30 minutos.`;
  }

  try {
    const telegramResult = await sendTelegramMessage(env, textoTimbre, 'Markdown');
    return jsonResponse({
      success: true,
      tipo: 'timbre',
      bloqueado: cantidad === 3,
      toques_realizados: cantidad,
      result: telegramResult
    }, 200, origin);
  } catch (err) {
    return jsonResponse({
      success: false,
      error: err.message || 'Error al enviar el timbre a Telegram',
      tipo: 'timbre'
    }, 500, origin);
  }
}

// ═══════════════════════════════════════════════════════════════
//  FORMULARIO (comportamiento original preservado)
// ═══════════════════════════════════════════════════════════════
async function handleFormulario(request, env, origin, bodyJson, formData) {
  let nombre = 'No especificado';
  let email = 'No especificado';
  let telefono = 'No especificado';
  let mensajeUsuario = 'Sin contenido';
  let foto = null;

  if (formData) {
    nombre = formData.get('nombre') || 'No especificado';
    email = formData.get('email') || 'No especificado';
    telefono = formData.get('telefono') || 'No especificado';
    mensajeUsuario = formData.get('mensaje') || 'Sin contenido';
    const archivo = formData.get('foto');
    if (archivo instanceof File && archivo.size > 0) {
      foto = archivo;
    }
  } else if (bodyJson) {
    nombre = bodyJson.nombre || 'No especificado';
    email = bodyJson.email || 'No especificado';
    telefono = bodyJson.telefono || 'No especificado';
    mensajeUsuario = bodyJson.mensaje || 'Sin contenido';
  }

  const textoMensaje = `🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽

📩 NUEVO MENSAJE

👤 Nombre: ${nombre}

📧 Email: ${email}

📱 Teléfono: ${telefono}

💬 Mensaje:

${mensajeUsuario}`;

  const telegramBaseUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  let response;

  try {
    if (foto) {
      const telegramForm = new FormData();
      telegramForm.append('chat_id', env.TELEGRAM_CHAT_ID);
      telegramForm.append('caption', textoMensaje);
      telegramForm.append('photo', foto, foto.name || 'foto.jpg');
      response = await fetch(`${telegramBaseUrl}/sendPhoto`, {
        method: 'POST',
        body: telegramForm
      });
    } else {
      response = await fetch(`${telegramBaseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: textoMensaje
        })
      });
    }

    const telegramResult = await response.json();
    if (!response.ok) {
      return jsonResponse({
        success: false,
        error: 'Error al enviar el formulario a Telegram',
        telegram_status: response.status,
        telegram_response: telegramResult
      }, 500, origin);
    }

    return jsonResponse({
      success: true,
      tipo: 'formulario',
      result: telegramResult
    }, 200, origin);
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error.message,
      tipo: 'formulario'
    }, 500, origin);
  }
}

// ═══════════════════════════════════════════════════════════════
//  EXPORT PRINCIPAL
// ═══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    let tipo = url.searchParams.get('tipo') || '';
    let accion = url.searchParams.get('accion') || '';

    let formData = null;
    let bodyJson = null;

    if (request.method === 'POST' || request.method === 'PUT') {
      const contentType = request.headers.get('Content-Type') || '';

      if (contentType.includes('application/json')) {
        try { bodyJson = await request.json(); } catch (_) {}
      } else if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
        try { formData = await request.formData(); } catch (_) {}
      } else {
        try {
          const text = await request.text();
          if (text) {
            try {
              bodyJson = JSON.parse(text);
            } catch (_) {
              const parsed = new URLSearchParams(text);
              if (parsed.size) bodyJson = Object.fromEntries(parsed.entries());
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

    // GET con query params (ej. ?tipo=camara&accion=estado)
    tipo = tipo || url.searchParams.get('tipo') || '';
    accion = accion || url.searchParams.get('accion') || '';

    if (tipo === 'camara') {
      return handleCamera(request, env, accion, formData, bodyJson, origin);
    }

    if (tipo === 'timbre') {
      return handleTimbre(request, env, origin, bodyJson, formData);
    }

    if (tipo === 'formulario') {
      return handleFormulario(request, env, origin, bodyJson, formData);
    }

    if (request.method === 'GET') {
      return jsonResponse({ ok: true, mensaje: 'Worker activo', tipo, accion }, 200, origin);
    }

    return jsonResponse({ error: 'Solicitud no reconocida' }, 400, origin);
  }
};