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
| `VIEWER_BASE_URL`   | URL base pública del frontend. Ej. `https://enyoecd.github.io/Ecuador1438`. |
| `CAMERA_STATE`      | Binding KV (opcional) con el estado de la sesión de cámara.       |
| `TIMBRE_KV`         | Binding KV (opcional) para el límite de 3 toques del timbre.      |

### Cargar los secrets

```bash
wrangler secret put ID_app
wrangler secret put Token_API
# TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID ya deberían existir
```

### Enlazar los KV (opcional pero recomendado)

En `wrangler.jsonc` descomenta el bloque `kv_namespaces` con los IDs de los
namespaces `CAMERA_STATE` y `TIMBRE_KV`.

## Endpoints

- `POST tipo=camara&accion=iniciar` → crea la sesión SFU (reserva la cámara).
- `GET tipo=camara&accion=estado` → dice si hay una transmisión activa.
- `POST tipo=camara&accion=tracks-new` → publica/suscribe tracks en el SFU. Cuando el
  publicador conecta su cámara (tracks con `location: local`), se envía
  automáticamente a Telegram **solo la URL pública del visor**
  (`<VIEWER_BASE_URL>/viewer-p1.html`) para poder ver el streaming en vivo desde el chat
  (física: el enlace se manda una vez, al iniciarse la transmisión).
- `POST tipo=camara&accion=renegotiate` → responde a la renegociación del SFU.
- `POST tipo=camara&accion=viewer` → prepara una sesión para el visor.
- `POST tipo=camara&accion=finalizar` → cierra la sesión del publicador.
- `POST tipo=camara&accion=finalizar-viewer` → cierra la sesión del visor.
- `POST tipo=timbre` → notificación de timbre a Telegram.
- `POST tipo=formulario` → reenvío del formulario a Telegram.

## Despliegue

```bash
npx wrangler deploy
```