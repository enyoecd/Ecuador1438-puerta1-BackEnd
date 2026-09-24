// ============================================================
// Puerta 1 / Ecuador 1438 — Cloudflare Worker (v1.2)
// ------------------------------------------------------------
// 1. Notificaciones por Telegram (timbre, formulario)
// 2. Proxy Realtime SFU de Cloudflare Calls (/calls/*) para la
//    videollamada del citófono. Replica routePartyTracksRequest
//    de partytracks (motor que usa Cloudflare Meet).
// ============================================================

const CALLS_BASE = "https://rtc.live.cloudflare.com/v1";

// ============================================================
// Registro en memoria de llamadas cruzadas (pairing) para la
// videollamada bidireccional (WHEP/WHIP simultáneo).
//   clave  → ID estable de puerta (p. ej. "puerta1")
//   valor  → { returnSession, tracks, at }
// El visor publica su sesión de retorno con POST /pair y la
// puerta la consulta (long-poll simple) con GET /pair-status.
// El estado es en memoria: suficiente para una puerta. Si se
// necesita durabilidad real, migra esto a un Durable Object.
// ============================================================
const returnRegistry = new Map();
const PAIR_TTL_MS = 12 * 60 * 60 * 1000; // 12 h

function pruneExpiredPairs() {
	const now = Date.now();
	for (const [key, entry] of returnRegistry) {
		if (now - entry.at > PAIR_TTL_MS) returnRegistry.delete(key);
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
		return json(200, {
			iceServers: [
				{
					urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"],
				},
			],
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
async function handlePair(request, url) {
	pruneExpiredPairs();

	if (url.pathname === "/pair" && request.method === "POST") {
		// El visor que contestó publica su sesión de retorno.
		// body: { door: "puerta1", session: "<sessionId retorno>", tracks: ["video","audio"] }
		let data = {};
		try {
			data = await request.json();
		} catch (e) {
			return json(400, { success: false, error: "JSON inválido en /pair" });
		}
		const door = String(data.door || "").trim();
		const session = String(data.session || "").trim();
		if (!door || !session) {
			return json(400, {
				success: false,
				error: "Faltan door y/o session en /pair",
			});
		}
		const tracks = Array.isArray(data.tracks) ? data.tracks.map(String) : ["video", "audio"];
		returnRegistry.set(door, { returnSession: session, tracks, at: Date.now() });
		return json(200, { success: true, door, paired: true });
	}

	if (url.pathname === "/pair-status") {
		// La puerta consulta si el visor ya contestó.
		const door = url.searchParams.get("door");
		if (door) {
			const entry = returnRegistry.get(door);
			if (entry && Date.now() - entry.at <= PAIR_TTL_MS) {
				return json(200, {
					success: true,
					active: true,
					returnSession: entry.returnSession,
					tracks: entry.tracks || ["video", "audio"],
				});
			}
			returnRegistry.delete(door);
		}
		return json(200, { success: true, active: false });
	}

	if (url.pathname === "/pair-cancel") {
		// La puerta libera la sesión de retorno al terminar la llamada.
		const door = url.searchParams.get("door");
		if (door) returnRegistry.delete(door);
		return json(200, { success: true, released: true });
	}

	return json(404, { success: false, error: "Ruta de pairing no encontrada" });
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
		// ==========================================================
		if (
			url.pathname === "/pair" ||
			url.pathname === "/pair-status" ||
			url.pathname === "/pair-cancel"
		) {
			return handlePair(request, url);
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