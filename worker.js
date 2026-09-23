export default {
  async fetch(request, env) {
    // ============================================================
    // 1. CORS
    // ============================================================
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ============================================================
    // 2. Solo permitir POST.
    // ============================================================
    if (request.method !== "POST") {
      return new Response("Método no permitido", {
        status: 405,
        headers: corsHeaders
      });
    }

    try {
      // ==========================================================
      // 3. Verificar Secrets de Telegram
      // ==========================================================
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en Cloudflare"
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders
            }
          }
        );
      }

      // ==========================================================
      // 4. Detectar el tipo de contenido y extraer datos
      // ==========================================================
      const contentType = request.headers.get("content-type") || "";

      let tipo = "";
      let nombre = "No especificado";
      let email = "No especificado";
      let telefono = "No especificado";
      let mensajeUsuario = "Sin contenido";
      let foto = null;

      if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        tipo = formData.get("tipo") || "";
        nombre = formData.get("nombre") || "No especificado";
        email = formData.get("email") || "No especificado";
        telefono = formData.get("telefono") || "No especificado";
        mensajeUsuario = formData.get("mensaje") || "Sin contenido";

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
      } else {
        try {
          const text = await request.text();
          const params = new URLSearchParams(text);
          tipo = params.get("tipo") || "";
          nombre = params.get("nombre") || "No especificado";
          email = params.get("email") || "No especificado";
          telefono = params.get("telefono") || "No especificado";
          mensajeUsuario = params.get("mensaje") || "Sin contenido";
        } catch (e) {}
      }

      // ==========================================================
      // 5. SI ES UN TOQUE DE TIMBRE
      // ==========================================================
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

              return new Response(
                JSON.stringify({
                  success: false,
                  tipo: "timbre",
                  bloqueado: true,
                  minutos_restantes: restanteMinutos,
                  error: `Timbre bloqueado. Faltan ${restanteMinutos} minutos para volver a utilizarlo.`
                }),
                {
                  status: 429,
                  headers: {
                    "Content-Type": "application/json",
                    ...corsHeaders
                  }
                }
              );
            }
            // Ya pasaron los 30 minutos. Reiniciar contador.
            cantidad = 0;
            inicioBloqueo = null;
          }

          // Seguridad: máximo 3 toques
          if (cantidad >= 3) {
            return new Response(
              JSON.stringify({
                success: false,
                tipo: "timbre",
                bloqueado: true,
                minutos_restantes: 30,
                error: "Se alcanzó el límite de 3 toques. El timbre estará disponible nuevamente en 30 minutos."
              }),
              {
                status: 429,
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders
                }
              }
            );
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
                inicioBloqueo: inicioBloqueo
              })
            );
          } catch (e) {
            console.error("Error al guardar en KV:", e);
          }
        } else {
          // Si no está configurado TIMBRE_KV aún, enviar el mensaje sin bloquear la app
          cantidad = 1;
        }

        // ========================================================
        // Mensaje de Telegram formateado con campanitas
        // ========================================================
        let textoTimbre = `🔔🔔🔔🔔🔔🔔🔔🔔🔔\n\n*🔔ESTÁN TOCANDO EL TIMBRE🔔*`;

        if (cantidad === 3) {
          textoTimbre += `\n\n⚠️ Se alcanzó el límite de 3 toques.`;
          textoTimbre += `\n⏳ Podrá volver a tocarse en 30 minutos.`;
        }

        const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

        const response = await fetch(telegramUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: textoTimbre,
            parse_mode: "Markdown"
          })
        });

        const telegramResult = await response.json();

        if (!response.ok) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "Error al enviar el timbre a Telegram",
              telegram_status: response.status,
              telegram_response: telegramResult
            }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders
              }
            }
          );
        }

        return new Response(
          JSON.stringify({
            success: true,
            tipo: "timbre",
            bloqueado: cantidad === 3,
            toques_realizados: cantidad,
            mensaje:
              cantidad === 3
                ? "Timbre sonando. Límite alcanzado. Disponible nuevamente en 30 minutos."
                : "Timbre sonando."
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders
            }
          }
        );
      }

      // ==========================================================
      // 6. SI NO ES TIMBRE → FORMULARIO
      // ==========================================================
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
          body: telegramForm
        });
      } else {
        response = await fetch(`${telegramBaseUrl}/sendMessage`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: textoMensaje
          })
        });
      }

      const telegramResult = await response.json();

      if (!response.ok) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Error al enviar el formulario a Telegram",
            telegram_status: response.status,
            telegram_response: telegramResult
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders
            }
          }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          tipo: "formulario",
          result: telegramResult
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        }
      );

    } catch (error) {
      return new Response(
        JSON.stringify({
          success: false,
          error: error.message
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders
          }
        }
      );
    }
  }
};
