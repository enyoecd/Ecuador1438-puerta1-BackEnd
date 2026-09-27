// ============================================================
// Puerta 1 / Ecuador 1438 — Cloudflare Worker (v1.3)
// ------------------------------------------------------------
// 1. Notificaciones por Telegram (timbre, formulario)
// 2. Proxy Realtime SFU de Cloudflare Calls (/calls/*) para la
//    videollamada del citófono. Replica routePartyTracksRequest
//    de partytracks (motor que usa Cloudflare Meet).
// 3. Registro de llamadas cruzadas (pairing) en un Durable
//    Object: estado consistente para la videollamada bidireccional.
// ============================================================

const CALLS_BASE = "https://rtc.live.cloudflare.com/v1";

// ============================================================
// Registro de llamadas cruzadas (pairing) para la videollamada
// bidireccional (WHEP/WHIP simultáneo).
//   clave  → ID estable de puerta (p. ej. "puerta1")
//   valor  → { ret: {session, tracks, at}, stream: {session, tracks, at} }
// El visor publica su sesión de retorno con POST /pair y la
// puerta la consulta con GET /pair-status.
//
// IMPORTANTE: un Worker sin estado puede atender el POST /pair
// y el GET /pair-status en isolates DISTINTOS, así que un Map en
// memoria perdía el emparejamiento de forma intermitente. Por eso
// el estado vive en un Durable Object (un solo isolate, con
// almacenamiento por clave). Mientras el binding no exista
// (migración aún no desplegada) se usa el Map en memoria para no
// romper nada, aceptando la intermitencia.
//
// Rutas:
//   POST   /pair            body {door, session, tracks}      → registra
//   POST   /pair            body {door, streamSession, tracks} → anuncia sesión
//   GET    /pair-status?door=puerta1[&wait=N]                → consulta (long-poll, máx 25 s)
//   POST   /pair-cancel     body {door, session}              → libera (con validación)
//   GET    /stream-status?door=puerta1                       → sesión de emisión vigente
//   POST   /stream-clear    body {door, streamSession}        → la puerta dejó de emitir
// ============================================================
const PAIR_TTL_MS = 12 * 60 * 60 * 1000; // 12 h
const PAIR_WAIT_MAX_MS = 25000; // long-poll máximo
const PAIR_WAIT_POLL_MS = 1000; // corte para reevaluar expiración

// ── Almacén en memoria (fallback si no hay Durable Object) ──
const returnRegistry = new Map();

function pruneExpiredPairs() {
	for (const [key, entry] of returnRegistry) {
		if (isEmptyRecord(freshRecord(entry))) returnRegistry.delete(key);
	}
}

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

function withCors(headers = new Headers()) {
	const h = new Headers(headers);
	h.set("Access-Control-Allow-Origin", "*");
	h.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	h.set("Access-Control-Allow-Headers", "Content-Type");
	return h;
}

function json(status, obj, extraHeaders) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: {
			"Content-Type": "application/json",
			...CORS_HEADERS,
			...(extraHeaders || {}),
		},
	});
}

// Resuelve las credenciales de Calls/SFU permitiendo ambos nombres:
//   ID_app / Token_API   (los que te entregó SFU)
//   CALLS_APP_ID / CALLS_APP_SECRET  (los convencionales de Cloudflare Meet)
function callsEnv(env) {
	return {
		appId: env.CALLS_APP_ID || env.ID_app,
		appSecret: env.CALLS_APP_SECRET || env.Token_API,
		apiBase: env.CALLS_API_URL || CALLS_BASE,
		turnId: env.SFU_TURN_SERVICE_ID || env.TURN_SERVICE_ID,
		turnToken: env.SFU_TURN_SERVICE_TOKEN || env.TURN_SERVICE_TOKEN,
	};
}

// ------------------------------------------------------------
// Proxy Realtime SFU (equivalente a partytracks/server)
// Enruta cualquier /calls/... hacia la API de Cloudflare Calls,
// inyectando la autorización con el app secret (nunca llega al
// navegador). Mismo protocolo que usa la página de partytracks
// de meet-main: sesiones, tracks (push/pull), renegociación.
// ------------------------------------------------------------
async function proxyCallsRequest(request, url, cf) {
	if (!cf.appId || !cf.appSecret) {
		return json(500, {
			success: false,
			error:
				"Faltan las credenciales de Cloudflare Calls en el Worker: ID_app (o CALLS_APP_ID) y Token_API (o CALLS_APP_SECRET).",
		});
	}

	// Ruta relativa desde el proxy (/calls/...)
	const rest = url.pathname.slice("/calls".length);

	// Servidores ICE para el navegador (STUN público o credenciales TURN)
	if (rest.startsWith("/generate-ice-servers")) {
		if (cf.turnId && cf.turnToken) {
			const turnRes = await fetch(
				`${cf.apiBase}/turn/keys/${cf.turnId}/credentials/generate-ice-servers`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${cf.turnToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ ttl: 86400 }),
				}
			);
			return new Response(await turnRes.text(), {
				status: turnRes.status,
				headers: withCors(turnRes.headers),
			});
		}
		// Sin credenciales TURN solo hay STUN: suficiente en redes de
		// escritorio, pero en 4G/5G (CGNAT) la llamada de respuesta
		// falla de forma intermitente. Publica SFU_TURN_SERVICE_ID y
		// SFU_TURN_SERVICE_TOKEN para evitarlo.
		return json(200, {
			iceServers: [
				{
					urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"],
				},
			],
			warning: "Sin credenciales TURN configuradas: la negociación ICE puede fallar en redes móviles.",
		});
	}

	const target = new URL(`${cf.apiBase}/apps/${cf.appId}${rest}`);
	target.search = url.search;

	const headers = new Headers(request.headers);
	headers.set("Authorization", `Bearer ${cf.appSecret}`);
	headers.set("Content-Type", "application/json");

	const init = { method: request.method, headers };
	if (request.method !== "GET" && request.method !== "HEAD") {
		const body = await request.text();
		if (body) init.body = body;
	}

	const upstream = await fetch(target, init);
	return new Response(await upstream.text(), {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: withCors(upstream.headers),
	});
}

// ------------------------------------------------------------
// Registro cruzado de la llamada (retorno del visor → puerta)
// ------------------------------------------------------------
function normalizeTracks(tracks) {
	if (!Array.isArray(tracks)) return ["video", "audio"];
	const list = tracks.map((t) => String(t).trim()).filter(Boolean);
	return list.length ? list : ["video", "audio"];
}

function readPairBody(request) {
	// Tolera JSON y form-data para no depender de un content-type exacto.
	const ct = request.headers.get("content-type") || "";
	if (ct.includes("application/json")) {
		return request.json().catch(() => ({}));
	}
	if (ct.includes("multipart/form-data") || ct.includes("x-www-form-urlencoded")) {
		return request.formData().then((fd) => ({
			door: fd.get("door"),
			session: fd.get("session"),
			streamSession: fd.get("streamSession"),
			tracks: fd.getAll ? fd.getAll("tracks") : fd.get("tracks"),
		}));
	}
	return request.text().then((text) => {
		try {
			return JSON.parse(text);
		} catch (e) {
			return Object.fromEntries(new URLSearchParams(text));
		}
	});
}

// Estado por puerta: un único registro con dos campos independientes.
//   ret    → sesión de retorno publicada por el visor (contestación)
//   stream → sesión de emisión vigente de la puerta
// Son independientes a propósito: la puerta anuncia su sesión al
// empezar a transmitir, mucho antes de que alguien conteste.
function emptyRecord() {
	return { ret: null, stream: null };
}

function freshRecord(record) {
	const now = Date.now();
	const out = emptyRecord();
	if (record) {
		if (record.ret && now - record.ret.at <= PAIR_TTL_MS) out.ret = record.ret;
		if (record.stream && now - record.stream.at <= PAIR_TTL_MS) out.stream = record.stream;
	}
	return out;
}

function isEmptyRecord(record) {
	return !record.ret && !record.stream;
}

// Aplica una acción y devuelve el registro resultante. `record` puede
// venir sin filtrar por TTL.
function applyPairAction(rawRecord, action) {
	const record = freshRecord(rawRecord);
	const now = Date.now();
	let body = { success: true };

	if (action.type === "set") {
		record.ret = { session: action.session, tracks: normalizeTracks(action.tracks), at: now };
		body = { success: true, paired: true };
	} else if (action.type === "stream") {
		// La puerta anuncia en qué sesión está emitiendo para que el
		// visor pueda re-apuntarse si la puerta reconectó.
		record.stream = {
			session: action.streamSession,
			tracks: Array.isArray(action.tracks) && action.tracks.length
				? normalizeTracks(action.tracks)
				: (record.stream && record.stream.tracks) || ["video", "audio"],
			at: now,
		};
		body = {
			success: true,
			streamSession: record.stream.session,
			streamTracks: record.stream.tracks,
		};
	} else if (action.type === "cancel") {
		// Con sesión: solo se borra si sigue siendo la misma. Así una
		// segunda pestaña o un segundo visitante no tumba la llamada
		// del que ya está conectado.
		if (record.ret && action.session && record.ret.session !== action.session) {
			body = { success: true, released: false, reason: "sesión distinta" };
		} else {
			record.ret = null;
			body = { success: true, released: true };
		}
	} else if (action.type === "clearStream") {
		// La puerta terminó de emitir: su anuncio se borra para que un
		// visor con el enlace viejo no se quede apuntando a una sesión
		// muerta. Con sesión, solo si sigue siendo la misma.
		if (record.stream && action.streamSession && record.stream.session !== action.streamSession) {
			body = { success: true, streamCleared: false, reason: "sesión distinta" };
		} else {
			record.stream = null;
			body = { success: true, streamCleared: true };
		}
	}

	return { record: isEmptyRecord(record) ? null : record, body };
}

function pairResponse(record) {
	// Siempre la misma forma de respuesta, haya o haya registro: así
	// el cliente no tiene que distinguir entre "no hay" y "vacío".
	return {
		success: true,
		active: !!(record && record.ret && record.ret.session),
		returnSession: (record && record.ret && record.ret.session) || "",
		tracks: (record && record.ret && record.ret.tracks) || [],
		streamSession: (record && record.stream && record.stream.session) || "",
		streamTracks: (record && record.stream && record.stream.tracks) || [],
	};
}

async function handlePair(request, url, env) {
	const method = request.method.toUpperCase();
	const path = url.pathname;

	// ── Registro del stream de retorno (POST /pair) ──
	if (path === "/pair" && method === "POST") {
		const data = await readPairBody(request);
		const door = String(data.door || "").trim();
		if (!door) return json(400, { success: false, error: "Falta door en /pair" });

		const streamSession = String(data.streamSession || "").trim();
		if (streamSession) {
			const res = await pairCommand(env, door, {
				type: "stream",
				streamSession,
				tracks: data.tracks,
			});
			return json(200, res.body);
		}

		const session = String(data.session || "").trim();
		if (!session) {
			return json(400, { success: false, error: "Faltan door y/o session en /pair" });
		}
		const res = await pairCommand(env, door, {
			type: "set",
			session,
			tracks: normalizeTracks(data.tracks),
		});
		return json(200, { ...res.body, door });
	}

	// ── Liberación (POST /pair-cancel) ──
	if (path === "/pair-cancel") {
		let door = url.searchParams.get("door") || "";
		let session = url.searchParams.get("session") || "";
		if (method !== "GET" && method !== "HEAD") {
			const data = await readPairBody(request).catch(() => ({}));
			door = door || String(data.door || "").trim();
			session = session || String(data.session || "").trim();
		}
		if (!door) return json(400, { success: false, error: "Falta door en /pair-cancel" });
		const res = await pairCommand(env, door, { type: "cancel", session });
		return json(200, { ...res.body, door });
	}

	// ── La puerta deja de emitir (POST /stream-clear) ──
	if (path === "/stream-clear") {
		let door = url.searchParams.get("door") || "";
		let session = url.searchParams.get("streamSession") || "";
		if (method !== "GET" && method !== "HEAD") {
			const data = await readPairBody(request).catch(() => ({}));
			door = door || String(data.door || "").trim();
			session = session || String(data.streamSession || "").trim();
		}
		if (!door) return json(400, { success: false, error: "Falta door en /stream-clear" });
		const res = await pairCommand(env, door, { type: "clearStream", streamSession: session });
		return json(200, { ...res.body, door });
	}

	// ── Consulta desde la puerta (GET /pair-status, con long-poll) ──
	if (path === "/pair-status") {
		const door = url.searchParams.get("door") || "";
		if (!door) return json(400, { success: false, error: "Falta door en /pair-status" });
		const wait = Math.min(
			Math.max(Number(url.searchParams.get("wait")) || 0, 0),
			PAIR_WAIT_MAX_MS
		);
		const res = await pairCommand(env, door, { type: "get" }, wait);
		return json(200, pairResponse(res.record));
	}

	// ── Sesión de emisión vigente (GET /stream-status) ──
	if (path === "/stream-status") {
		const door = url.searchParams.get("door") || "";
		if (!door) return json(400, { success: false, error: "Falta door en /stream-status" });
		const res = await pairCommand(env, door, { type: "get" });
		return json(200, {
			success: true,
			active: !!(res.record && res.record.stream),
			streamSession: (res.record && res.record.stream && res.record.stream.session) || "",
			streamTracks: (res.record && res.record.stream && res.record.stream.tracks) || [],
		});
	}

	return json(404, { success: false, error: "Ruta de pairing no encontrada" });
}

// ── Acceso al estado: Durable Object si está bound, si no memoria ──
function hasDurablePairing(env) {
	return !!(env && env.PAIRING && typeof env.PAIRING.get === "function");
}

async function pairCommand(env, door, action, waitMs) {
	if (hasDurablePairing(env)) {
		const id = env.PAIRING.idFromName(door);
		const stub = env.PAIRING.get(id);
		const res = await stub.fetch("https://pairing.internal/cmd", {
			method: "POST",
			body: JSON.stringify({ door, action, waitMs: waitMs || 0 }),
		});
		const data = await res.json().catch(() => ({ success: true }));
		return { ...data, record: data.record || null };
	}
	return pairCommandMemory(door, action, waitMs);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// Fallback sin Durable Object: mismo comportamiento, pero el estado
// vive en el isolate (intermitente si hay varias instancias).
async function pairCommandMemory(door, action, waitMs) {
	pruneExpiredPairs();
	let current = returnRegistry.get(door) || null;

	const hasReturn = (rec) => !!(rec && rec.ret && rec.ret.session);

	// Long-poll: espera a que el visor registre el retorno.
	if (action.type === "get" && waitMs > 0 && !hasReturn(current)) {
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			await sleep(PAIR_WAIT_POLL_MS);
			current = returnRegistry.get(door) || null;
			if (hasReturn(current)) break;
		}
		return { record: freshRecord(current), body: { success: true } };
	}

	const res = applyPairAction(current, action);
	if (res.record) returnRegistry.set(door, res.record);
	else returnRegistry.delete(door);
	return res;
}

// ------------------------------------------------------------
// Durable Object del pairing: una única instancia por puerta,
// con almacenamiento consistente (fuera de memoria del isolate).
// ------------------------------------------------------------
export class Pairing {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.waiters = new Map(); // door → [resolve]
	}

	async load(door) {
		const raw = await this.state.storage.get(door);
		if (!raw) return null;
		const record = freshRecord(raw);
		if (isEmptyRecord(record)) {
			await this.state.storage.delete(door);
			return null;
		}
		return record;
	}

	async save(door, record) {
		if (record) await this.state.storage.put(door, record);
		else await this.state.storage.delete(door);
		// Despierta a quien esté esperando en long-poll.
		const list = this.waiters.get(door);
		if (list && list.length) {
			this.waiters.delete(door);
			for (const resolve of list) resolve(record);
		}
	}

	async fetch(request) {
		let payload = {};
		try {
			payload = await request.json();
		} catch (e) {
			return json(400, { success: false, error: "JSON inválido" });
		}
		const door = String(payload.door || "").trim();
		const action = payload.action || { type: "get" };
		if (!door) return json(400, { success: false, error: "Falta door" });

		const current = await this.load(door);
		const hasReturn = !!(current && current.ret && current.ret.session);

		if (action.type === "get" && !hasReturn) {
			const waitMs = Math.min(Number(payload.waitMs) || 0, PAIR_WAIT_MAX_MS);
			if (waitMs > 0) {
				const record = await new Promise((resolve) => {
					const list = this.waiters.get(door) || [];
					list.push(resolve);
					this.waiters.set(door, list);
					this.state.storage.setAlarm(Date.now() + waitMs + 1000);
				});
				return json(200, { success: true, record: record || null });
			}
		}

		const res = applyPairAction(current, action);
		await this.save(door, res.record);
		return json(200, { success: true, ...res.body, record: res.record || null });
	}

	// Despierta los long-poll cuando vence la alarma de seguridad.
	async alarm() {
		for (const [door, list] of this.waiters) {
			this.waiters.delete(door);
			const record = await this.load(door);
			for (const resolve of list) resolve(record);
		}
	}
}

// ------------------------------------------------------------
// Envío de mensajes a Telegram (con botón de enlace opcional)
// ------------------------------------------------------------
async function sendTelegram(env, text, opts = {}) {
	const payload = { chat_id: env.TELEGRAM_CHAT_ID, text };
	if (opts.parseMode) payload.parse_mode = opts.parseMode;
	if (opts.url) {
		payload.reply_markup = {
			inline_keyboard: [[{ text: "🎥 Ver cámara en vivo", url: opts.url }]],
		};
	}
	return fetch(
		`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		}
	);
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// ==========================================================
		// 0. CORS v1.2
		// ==========================================================
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: withCors() });
		}

		// ==========================================================
		// 1. Registro de llamada bidireccional (retorno del visor)
		//    /pair · /pair-status · /pair-cancel · /stream-status
		// ==========================================================
		if (
			url.pathname === "/pair" ||
			url.pathname === "/pair-status" ||
			url.pathname === "/pair-cancel" ||
			url.pathname === "/stream-status" ||
			url.pathname === "/stream-clear"
		) {
			return handlePair(request, url, env);
		}

		// ==========================================================
		// 2. Proxy Realtime SFU (Cloudflare Calls)
		// ==========================================================
		if (url.pathname.startsWith("/calls/")) {
			return proxyCallsRequest(request, url, callsEnv(env));
		}

		// ==========================================================
		// 3. Solo permitir POST (resto de endpoints).
		// ==========================================================
		if (request.method !== "POST") {
			return new Response("Método no permitido", {
				status: 405,
				headers: withCors(),
			});
		}

		try {
			// ========================================================
			// 3. Verificar Secrets de Telegram
			// ========================================================
			if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
				return json(500, {
					success: false,
					error: "Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en Cloudflare",
				});
			}

			// ========================================================
			// 4. Detectar el tipo de contenido y extraer datos
			// ========================================================
			const contentType = request.headers.get("content-type") || "";

			let tipo = "";
			let nombre = "No especificado";
			let email = "No especificado";
			let telefono = "No especificado";
			let mensajeUsuario = "Sin contenido";
			let foto = null;
			let viewUrl = "";
			let puertaForm = "";

			if (contentType.includes("multipart/form-data")) {
				const formData = await request.formData();
				tipo = formData.get("tipo") || "";
				nombre = formData.get("nombre") || "No especificado";
				email = formData.get("email") || "No especificado";
				telefono = formData.get("telefono") || "No especificado";
				mensajeUsuario = formData.get("mensaje") || "Sin contenido";
				viewUrl = formData.get("viewUrl") || "";
				puertaForm = formData.get("puerta") || "";

				const archivo = formData.get("foto");
				if (archivo instanceof File && archivo.size > 0) {
					foto = archivo;
				}
			} else if (contentType.includes("application/json")) {
				const data = await request.json();
				tipo = data.tipo || "";
				nombre = data.nombre || "No especificado";
				email = data.email || "No especificado";
				telefono = data.telefono || "No especificado";
				mensajeUsuario = data.mensaje || "Sin contenido";
				viewUrl = data.viewUrl || "";
				puertaForm = data.puerta || "";
			} else {
				try {
					const text = await request.text();
					const params = new URLSearchParams(text);
					tipo = params.get("tipo") || "";
					nombre = params.get("nombre") || "No especificado";
					email = params.get("email") || "No especificado";
					telefono = params.get("telefono") || "No especificado";
					mensajeUsuario = params.get("mensaje") || "Sin contenido";
					viewUrl = params.get("viewUrl") || "";
					puertaForm = params.get("puerta") || "";
				} catch (e) {}
			}

			const puerta = url.searchParams.get("puerta") || puertaForm || "1";

			// ========================================================
			// 5. SI ES UN TOQUE DE TIMBRE
			// ========================================================
			if (tipo === "timbre") {
				const ahora = Date.now();
				const clave = "puerta1_timbre";
				let cantidad = 0;
				let inicioBloqueo = null;
				const treintaMinutos = 30 * 60 * 1000;

				// Si TIMBRE_KV está configurado en Cloudflare, gestionar límites
				if (env.TIMBRE_KV) {
					try {
						const estado = await env.TIMBRE_KV.get(clave, "json");
						if (estado) {
							cantidad = estado.cantidad || 0;
							inicioBloqueo = estado.inicioBloqueo || null;
						}
					} catch (e) {
						console.error("Error al leer de KV:", e);
					}

					// Comprobar si todavía está dentro de los 30 minutos de bloqueo
					if (inicioBloqueo) {
						const transcurrido = ahora - inicioBloqueo;
						if (transcurrido < treintaMinutos) {
							const restanteMs = treintaMinutos - transcurrido;
							const restanteMinutos = Math.ceil(restanteMs / 60000);

							return json(429, {
								success: false,
								tipo: "timbre",
								bloqueado: true,
								minutos_restantes: restanteMinutos,
								error: `Timbre bloqueado. Faltan ${restanteMinutos} minutos para volver a utilizarlo.`,
							});
						}
						// Ya pasaron los 30 minutos. Reiniciar contador.
						cantidad = 0;
						inicioBloqueo = null;
					}

					// Seguridad: máximo 3 toques
					if (cantidad >= 3) {
						return json(429, {
							success: false,
							tipo: "timbre",
							bloqueado: true,
							minutos_restantes: 30,
							error:
								"Se alcanzó el límite de 3 toques. El timbre estará disponible nuevamente en 30 minutos.",
						});
					}

					// Registrar el nuevo toque
					cantidad++;
					if (cantidad === 3) {
						inicioBloqueo = ahora;
					}

					try {
						await env.TIMBRE_KV.put(
							clave,
							JSON.stringify({
								cantidad: cantidad,
								inicioBloqueo: inicioBloqueo,
							})
						);
					} catch (e) {
						console.error("Error al guardar en KV:", e);
					}
				} else {
					// Si no está configurado TIMBRE_KV aún, enviar el mensaje sin bloquear la app
					cantidad = 1;
				}

				// ====================================================
				// Mensaje de Telegram formateado con campanitas
				// ====================================================
				let textoTimbre = `🔔🔔🔔🔔🔔🔔🔔🔔🔔\n\n*🔔ESTÁN TOCANDO EL TIMBRE🔔*`;

				if (cantidad === 3) {
					textoTimbre += `\n\n⚠️ Se alcanzó el límite de 3 toques.`;
					textoTimbre += `\n⏳ Podrá volver a tocarse en 30 minutos.`;
				}

				// Si hay una cámara transmitiendo, adjuntar el enlace
				const telegramOpts = { parseMode: "Markdown" };
				if (viewUrl) {
					textoTimbre += `\n\n🎥 *Cámara de la puerta:*
${viewUrl}`;
					telegramOpts.url = viewUrl;
				}

				const response = await sendTelegram(env, textoTimbre, telegramOpts);
				const telegramResult = await response.json();

				if (!response.ok) {
					return json(500, {
						success: false,
						error: "Error al enviar el timbre a Telegram",
						telegram_status: response.status,
						telegram_response: telegramResult,
					});
				}

				return json(200, {
					success: true,
					tipo: "timbre",
					bloqueado: cantidad === 3,
					toques_realizados: cantidad,
					mensaje:
						cantidad === 3
							? "Timbre sonando. Límite alcanzado. Disponible nuevamente en 30 minutos."
							: "Timbre sonando.",
				});
			}

			// ========================================================
			// 6. SI ES UNA TRANSMISIÓN EN VIVO (aviso de cámara)
			// ========================================================
			if (tipo === "transmision") {
				let textoTransmision = `📡📡📡📡📡📡📡

*🔴 TRANSMISIÓN EN VIVO — Puerta ${puerta}*

🎥 La cámara está transmitiendo. Haz clic en el botón de abajo para verla al instante.`;

				const telegramOpts = { parseMode: "Markdown" };
				if (viewUrl) {
					textoTransmision += `\n\n📎 Enlace: ${viewUrl}`;
					telegramOpts.url = viewUrl;
				}

				const response = await sendTelegram(env, textoTransmision, telegramOpts);
				const telegramResult = await response.json();

				if (!response.ok) {
					return json(500, {
						success: false,
						error: "Error al enviar la transmisión a Telegram",
						telegram_status: response.status,
						telegram_response: telegramResult,
					});
				}

				return json(200, {
					success: true,
					tipo: "transmision",
					viewUrl,
					result: telegramResult,
				});
			}

			// ========================================================
			// 7. SI NO ES TIMBRE NI TRANSMISIÓN → FORMULARIO
			// ========================================================
			const textoMensaje = `🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽🔽

📩 NUEVO MENSAJE

👤 Nombre: ${nombre}

📧 Email: ${email}

📱 Teléfono: ${telefono}

💬 Mensaje:

${mensajeUsuario}`;

			const telegramBaseUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
			let response;

			if (foto) {
				const telegramForm = new FormData();
				telegramForm.append("chat_id", env.TELEGRAM_CHAT_ID);
				telegramForm.append("caption", textoMensaje);
				telegramForm.append("photo", foto, foto.name || "foto.jpg");

				response = await fetch(`${telegramBaseUrl}/sendPhoto`, {
					method: "POST",
					body: telegramForm,
				});
			} else {
				response = await fetch(`${telegramBaseUrl}/sendMessage`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						chat_id: env.TELEGRAM_CHAT_ID,
						text: textoMensaje,
					}),
				});
			}

			const telegramResult = await response.json();

			if (!response.ok) {
				return json(500, {
					success: false,
					error: "Error al enviar el formulario a Telegram",
					telegram_status: response.status,
					telegram_response: telegramResult,
				});
			}

			return json(200, {
				success: true,
				tipo: "formulario",
				result: telegramResult,
			});
		} catch (error) {
			return json(500, {
				success: false,
				error: error.message,
			});
		}
	},
};