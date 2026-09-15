# Ecuador1438-BackEnd

Worker de Ecuador1438 — Puerta 1. Gestiona timbre, formulario y la transmisión de
video en tiempo real del timbre usando **Cloudflare Calls (Realtime SFU)**.

## Variables de entorno

| Variable            | Descripción                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `ID_app`            | App ID de Cloudflare Calls (Realtime SFU). **Secreto.**          |
| `Token_API`         | Token (app secret) de Cloudflare Calls. **Secreto.**             |
| `TELEGRAM_BOT_TOKEN`| Token del bot de Telegram (ya existente). **Secreto.**           |
| `TELEGRAM_CHAT_ID`  | Chat de Telegram destino (ya existente).                          |
| `ALLOWED_ORIGINS`   | Origen exacto de Cloudflare Pages (varios valores separados por comas). Requerido para restringir CORS en producción. |
| `CAMERA_STATE`      | Binding KV **obligatorio en producción** para el estado de la sesión de cámara. |
| `TIMBRE_KV`         | Binding KV **obligatorio en producción** para el límite de 3 toques del timbre. |

### Cargar los secrets

```bash
wrangler secret put ID_app
wrangler secret put Token_API
# TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID ya deberían existir
```

### Enlazar los KV (obligatorio en producción)

En `wrangler.jsonc` descomenta el bloque `kv_namespaces` con los IDs reales de
los namespaces `CAMERA_STATE` y `TIMBRE_KV`. Sin ellos, el Worker puede atender
dos solicitudes en instancias distintas y perder el estado de cámara o del
límite de timbre.

Configura también `ALLOWED_ORIGINS` en Cloudflare con el dominio de producción
de Pages. El enlace de Telegram al visor se construye desde el `Origin` HTTPS
de la página de Pages que inició la cámara, sin una URL fija de GitHub o Pages.

## Endpoints

- `POST tipo=camara&accion=iniciar` → crea la sesión SFU vacía (reserva la cámara).
  Usa el patrón canónico de Cloudflare Realtime: **sin** oferta SDP en esta llamada.
  La publicación se hace después con la oferta única en `tracks/new`.
- `GET tipo=camara&accion=estado` → dice si hay una transmisión activa.
- `GET tipo=camara&accion=diagnostico` → valida las credenciales del SFU creando
  y cerrando una sesión vacía de prueba. Devuelve si `ID_app`/`Token_API` son
  válidos, expiraron o no coinciden con el entorno activo, con pasos concretos.
- `POST tipo=camara&accion=tracks-new` → publica/suscribe tracks en el SFU. Cuando el
  publicador conecta su cámara (tracks con `location: local`), se envía
  automáticamente a Telegram **solo la URL pública del visor**
  (`<Origin de Pages>/viewer-p1.html`) para poder ver el streaming en vivo desde el chat
  (física: el enlace se manda una vez, al iniciarse la transmisión).
- `POST tipo=camara&accion=renegotiate` → responde a la renegociación del SFU.
- `POST tipo=camara&accion=viewer` → prepara una sesión para el visor.
- `POST tipo=camara&accion=finalizar` → cierra la sesión del publicador.
- `POST tipo=camara&accion=finalizar-viewer` → cierra la sesión del visor.
- `POST tipo=timbre` → notificación de timbre a Telegram.
- `POST tipo=formulario` → reenvío del formulario a Telegram.

### Errores del SFU

Cuando Cloudflare Calls rechaza una operación, el Worker responde `502` con un
cuerpo entendible (`motivo` + `sugerencia`) que el frontend muestra junto a un
diagnóstico automático. Los principales códigos del SFU y su significado:

| HTTP del SFU | Significado                                    | Solución |
| ------------ | ---------------------------------------------- | -------- |
| `401`        | `Token_API` inválido o expirado                | Regenera el token y actualiza el secret `Token_API` |
| `403`        | `ID_app` y token de apps distintas             | Usa credenciales de la misma app de Calls |
| `404`        | `ID_app` inexistente o de otro entorno         | Verifica el `ID_app` del entorno activo |
| `400`        | Oferta SDP / negociación rechazada             | Reintenta; revisa que la oferta se envíe en `tracks/new` |

## Despliegue

```bash
npx wrangler deploy
```
