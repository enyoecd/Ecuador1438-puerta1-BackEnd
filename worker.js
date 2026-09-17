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
//    ALLOWED_ORIGINS                   → origen/es de Pages autorizados por CORS
//    CAMERA_STATE  (KV binding)        → estado de sesión persistente
//    TIMBRE_KV     (KV binding)        → límite de toques del timbre
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
//  MEMORIA LOCAL (sólo fallback de desarrollo; no usar en producción)
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
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function allowedRequestOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;

  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  // Durante la transición no se bloquea el frontend si aún no se ha cargado
  // la variable. Una vez definida, sólo se acepta la lista explícita.
  if (!allowed.length || allowed.includes(origin)) return origin;
  return null;
}

function jsonResponse(data, status = 200, origin = null) {
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
function buildViewerUrl(request) {
  // Pages siempre envía Origin en estas solicitudes cross-origin. Así el
  // enlace publicado sigue el dominio real de Pages y no el del Worker.
  const origin = request.headers.get('Origin');
  if (origin && /^https:\/\/[^/]+$/i.test(origin)) {
    return origin + '/viewer-p1.html';
  }
  return null;
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
// Error normalizado de la API de Calls: conserva el status HTTP, la operación
// que falló y la respuesta cruda del SFU para poder diagnosticar si el rechazo
// viene de credenciales (401/403/404) o de negociación (400/4xx).
class SfuError extends Error {
  constructor(httpStatus, mensaje, operation, data) {
    super(mensaje);
    this.name = 'SfuError';
    this.httpStatus = httpStatus;
    this.operation = operation;
    this.data = data || null;
  }
}

// Traduce el error del SFU en un mensaje claro y accionable por status HTTP.
function sfuErrorFriendly(httpStatus, data, operation) {
  const rawCode = data && (data.errorCode || data.errorDescription)
    ? String(data.errorCode || '') + (data.errorDescription ? ' — ' + data.errorDescription : '')
    : '';
  let motivo;
  let sugerencia;

  if (httpStatus === 401) {
    motivo = 'El SFU rechazó la conexión: el Token_API es inválido o expiró.';
    sugerencia = 'Regenera el token de la app en dash.cloudflare.com → Calls y actualiza el secret Token_API del Worker (wrangler secret put Token_API).';
  } else if (httpStatus === 403) {
    motivo = 'El SFU rechazó la conexión: el ID_app no está autorizado con el Token_API actual.';
    sugerencia = 'Verifica que ID_app y Token_API pertenezcan a la MISMA app de Cloudflare Calls y que la app siga activa.';
  } else if (httpStatus === 404) {
    motivo = 'El SFU rechazó la conexión: el ID_app no existe o no coincide con el entorno activo.';
    sugerencia = 'Confirma que el secret ID_app del Worker sea exactamente el Application ID de la app ACTIVA (production / dev / preview).';
  } else if (httpStatus === 400) {
    motivo = 'El SFU rechazó la negociación WebRTC (SDP u oferta inválida).';
    sugerencia = 'Vuelve a intentar; si persiste, actualiza el frontend al flujo canónico de Cloudflare Calls (oferta única en tracks/new).';
  } else if (httpStatus === 429) {
    motivo = 'El SFU limitó temporalmente la cantidad de solicitudes.';
    sugerencia = 'Espera unos segundos y vuelve a intentar.';
  } else if (httpStatus > 0) {
    motivo = 'El SFU respondió con error HTTP ' + httpStatus + '.';
    sugerencia = 'Verifica la conectividad del Worker con rtc.live.cloudflare.com y que los secrets ID_app / Token_API del entorno activo sean correctos.';
  } else {
    motivo = 'El SFU no respondió correctamente.';
    sugerencia = 'Revisa que los secrets ID_app y Token_API estén configurados en el Worker y que correspondan al entorno activo de Cloudflare Calls.';
  }

  return {
    ok: false,
    motivo,
    sugerencia,
    sfuStatus: httpStatus,
    sfuOperacion: operation,
    sfuDetalle: rawCode || 'Sin detalle devuelto por el SFU.'
  };
}

// Convierte cualquier error de Calls en una respuesta HTTP 502 con el detalle
// amigable para el frontend (mantiene autenticidad: el cliente solo lee "ok").
function sfuErrorResponse(err, operation, origin) {
  const status = (err && err.httpStatus) || 0;
  const data = err && err.data ? err.data : null;
  const friendly = sfuErrorFriendly(status, data, operation);
  return jsonResponse({ error: friendly.motivo, ...friendly }, 502, origin);
}

async function callsNewSession(cfg, sessionDescription) {
  const options = { method: 'POST', headers: cfg.headers };
  // Sesión vacía (patrón canónico): NO se envía cuerpo. Enviar un JSON "{}"
  // hace que el validador de Calls rechace el body con "decoding_error
  // / Body JSON validation error: sessionDescription". El ejemplo oficial
  // (realtime-examples) crea la sesión también sin cuerpo.
  if (sessionDescription) {
    options.body = JSON.stringify({ sessionDescription });
  }
  const resp = await fetch(CALLS_API_BASE + '/' + cfg.appId + '/sessions/new', options);
  const data = await resp.json().catch(() => ({}));
  // Cloudflare Calls puede responder HTTP 200 con un error en el cuerpo
  // (errorCode/errorDescription), así que siempre se valida el cuerpo también.
  if (data.errorCode) {
    throw new SfuError(0, 'Calls crear sesión devolvió error', 'sessions/new', data);
  }
  if (!resp.ok) {
    throw new SfuError(resp.status, 'Calls crear sesión falló', 'sessions/new', data);
  }
  if (!data.sessionId) {
    throw new SfuError(0, 'Respuesta inválida de Calls (sin sessionId)', 'sessions/new', data);
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
  if (data.errorCode) {
    throw new SfuError(0, 'Calls tracks/new devolvió error', 'tracks/new', data);
  }
  if (!resp.ok) {
    throw new SfuError(resp.status, 'Calls tracks/new falló', 'tracks/new', data);
  }
  if (!data.sessionDescription) {
    throw new SfuError(0, 'Respuesta inválida de Calls (sin sessionDescription)', 'tracks/new', data);
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
    throw new SfuError(resp.status, 'Calls renegotiate falló', 'renegotiate', { errorDescription: text });
  }
  const data = await resp.json().catch(() => ({}));
  if (data.errorCode) {
    throw new SfuError(0, 'Calls renegotiate devolvió error', 'renegotiate', data);
  }
  return data;
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

  // ── DIAGNÓSTICO (GET) — valida credenciales del SFU ──────────
  // Crea (y cierra) una sesión vacía para comprobar que ID_app y Token_API
  // existen, no expiraron y coinciden con el entorno activo, sin interferir
  // con la transmisión en curso. Lo usa el frontend cuando el SFU rechaza.
  if (accion === 'diagnostico') {
    if (!cfg) {
      return jsonResponse({
        ok: false,
        error: 'Cloudflare Calls no configurado.',
        motivo: 'Faltan los secrets ID_app y/o Token_API en el Worker.',
        pasos: [
          'Abre dash.cloudflare.com → Workers & Pages → puerta1-ecuador1438 → Settings → Variables and Secrets.',
          'Define el secret ID_app con el Application ID de Cloudflare Calls.',
          'Define el secret Token_API con el token (app secret) de Cloudflare Calls.',
          'Verifica que ambos secrets pertenezcan al ENTORNO activo que sirve tu página (production o preview).',
          'Despliega el Worker de nuevo (wrangler deploy) para aplicar los cambios.'
        ]
      }, 503, origin);
    }
    try {
      const test = await callsNewSession(cfg, null);
      await closeCallsSession(cfg, test.sessionId);
      return jsonResponse({
        ok: true,
        appIdDefinido: true,
        tokenDefinido: true,
        appId: cfg.appId,
        mensaje: 'Credenciales válidas: el SFU aceptó el ID_app y el Token_API.',
        sesionPrueba: test.sessionId
      }, 200, origin);
    } catch (err) {
      const friendly = sfuErrorFriendly((err && err.httpStatus) || 0, (err && err.data) || null, 'diagnostico');
      return jsonResponse({
        ok: false,
        error: friendly.motivo,
        ...friendly,
        pasos: [
          'Abre dash.cloudflare.com → Calls y confirma que la app siga ACTIVA.',
          'Si el token expiró, regenéralo y actualiza el secret Token_API del Worker.',
          'Confirma que el secret ID_app sea exactamente el Application ID de esa app.',
          'Despliega el Worker (wrangler deploy) tras actualizar los secrets.'
        ]
      }, 502, origin);
    }
  }

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
  // Patrón canónico de Cloudflare Realtime: la sesión se crea SIN oferta SDP
  // (sessions/new vacío) y la publicación se hace después con una oferta ÚNICA
  // en tracks/new. Esto elimina la doble negociación que el SFU rechazaba.
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

    let created;
    try {
      created = await callsNewSession(cfg, null);
    } catch (err) {
      return sfuErrorResponse(err, 'iniciar', origin);
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

    let createdViewer;
    try {
      // Patrón canónico: sesión vacía; la suscripción se hace después en
      // tracks/new, donde el SFU devuelve la oferta a responder.
      createdViewer = await callsNewSession(cfg, null);
    } catch (err) {
      return sfuErrorResponse(err, 'viewer', origin);
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
      viewerUrl: buildViewerUrl(request)
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
          const viewerUrl = buildViewerUrl(request);
          if (!viewerUrl) {
            telegramError = 'No se pudo determinar la URL pública de Cloudflare Pages.';
          } else if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && !active.telegramSent) {
            try {
              await sendTelegramMessage(env, viewerUrl);
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
      return sfuErrorResponse(err, 'tracks-new', origin);
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
      return sfuErrorResponse(err, 'renegotiate', origin);
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
      minutos_restantes: cantidad === 3 ? 30 : 0,
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
// Límites de Telegram que producen rechazos 400 "Bad Request":
//   - sendMessage: 4096 caracteres de texto.
//   - sendPhoto / sendDocument: 1024 caracteres de caption.
// El formulario de Puerta 1 arma un mensaje largo (incluye el motivo de
// contacto y las fechas de ingreso/envío), así que al adjuntar una foto el
// caption podía superar los 1024 y Telegram rechazaba el envío. Estos
// helpers evitan ese rechazo sin perder información: la foto viaja con un
// caption recortado y el texto completo se manda aparte.
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;

function dividirTextoTelegram(texto, limite) {
  const partes = [];
  const total = Math.max(1, Math.ceil(texto.length / limite));
  for (let i = 0; i < total; i++) {
    partes.push(texto.slice(i * limite, (i + 1) * limite));
  }
  return partes;
}

async function enviarTextoTelegram(env, texto) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  let ultimo = null;
  for (const parte of dividirTextoTelegram(texto, TELEGRAM_TEXT_LIMIT)) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: parte })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error('Error al enviar el formulario a Telegram');
      err.telegram_status = resp.status;
      err.telegram_response = data;
      throw err;
    }
    ultimo = data;
  }
  return ultimo;
}

async function enviarArchivoTelegram(env, foto, caption, metodo) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${metodo}`;
  const telegramForm = new FormData();
  telegramForm.append('chat_id', env.TELEGRAM_CHAT_ID);
  telegramForm.append('caption', caption);
  telegramForm.append(metodo === 'sendDocument' ? 'document' : 'photo', foto, foto.name || 'foto.jpg');
  const resp = await fetch(url, { method: 'POST', body: telegramForm });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

function recortarCaptionTelegram(texto) {
  if (texto.length <= TELEGRAM_CAPTION_LIMIT) return texto;
  let corte = TELEGRAM_CAPTION_LIMIT - 1; // espacio para el carácter de corte
  const anterior = texto.charCodeAt(corte - 1);
  if (anterior >= 0xd800 && anterior <= 0xdbff) {
    corte -= 1; // no partir un par sustituto (emojis)
  }
  return texto.slice(0, corte) + '…';
}

async function enviarFormularioTelegram(env, foto, textoMensaje) {
  const recortado = textoMensaje.length > TELEGRAM_CAPTION_LIMIT;
  const caption = recortarCaptionTelegram(textoMensaje);

  if (foto) {
    // sendPhoto recomprime la imagen y acepta hasta 10 MB; si la imagen no es
    // válida para Telegram o excede ese tamaño, se reintenta como documento
    // (hasta 50 MB) para no perder el adjunto.
    let envio = await enviarArchivoTelegram(env, foto, caption, 'sendPhoto');
    if (!envio.ok) {
      envio = await enviarArchivoTelegram(env, foto, caption, 'sendDocument');
    }
    if (!envio.ok) {
      const err = new Error('Error al enviar el formulario a Telegram');
      err.telegram_status = envio.status;
      err.telegram_response = envio.data;
      throw err;
    }
    // El mensaje completo no cupo en el caption: se envía como texto aparte.
    if (recortado) {
      await enviarTextoTelegram(env, textoMensaje);
    }
    return envio.data;
  }

  return await enviarTextoTelegram(env, textoMensaje);
}

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

  try {
    const telegramResult = await enviarFormularioTelegram(env, foto, textoMensaje);
    return jsonResponse({
      success: true,
      tipo: 'formulario',
      result: telegramResult
    }, 200, origin);
  } catch (error) {
    return jsonResponse({
      success: false,
      error: error.message,
      telegram_status: error.telegram_status,
      telegram_response: error.telegram_response,
      tipo: 'formulario'
    }, 500, origin);
  }
}

// ═══════════════════════════════════════════════════════════════
//  EXPORT PRINCIPAL
// ═══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const requestedOrigin = request.headers.get('Origin');
    const origin = allowedRequestOrigin(request, env);

    if (requestedOrigin && !origin) {
      return jsonResponse({ error: 'Origin no autorizado' }, 403);
    }

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
