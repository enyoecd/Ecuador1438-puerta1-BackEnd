# Ecuador1438-BackEnd
Worker Cloudflare para Ecuador 1438 (timbre, formulario y cámara WebRTC).

## Desplegar

```bash
npx wrangler deploy
```

## Configuración requerida (cámara en vivo)

Para que la transmisión funcione desde **cualquier red** (datos móviles,
otra WiFi), el Worker debe crear sesiones reales en **Cloudflare Calls SFU**.
Configúralo una sola vez:

### 1. Crear la app Calls

Dashboard Cloudflare → **Realtime → Calls SFU → Create App** (nombre sugerido:
`puerta1-ecuador1438-sfu`). Anota:

- **App ID** → será el secret `ID_app`
- **App Secret** → será el secret `Token_API`

### 2. Namespaces KV

Dashboard → **Workers & Pages → KV → Create namespace**:

- `CAMERA_STATE` (estado de la sesión activa de cámara)
- `TIMBRE_KV` (bloqueo del timbre)

Luego agrega los bindings en `wrangler.jsonc` (descomenta `kv_namespaces`) o vía
Dashboard → Worker → Settings → Variables → KV Namespace Bindings:
`CAMERA_STATE` y `TIMBRE_KV`.

### 3. Secrets

```bash
npx wrangler secret put ID_app      # App ID del Calls SFU (puerta1-ecuador1438-sfu)
npx wrangler secret put Token_API   # App Secret / Token del Calls SFU
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

### 4. Servir el frontend

El enlace "🔗 Ver transmisión" que llega a Telegram apunta a `viewer-p1.html`.
Para que abra correctamente:

- **Opción A (recomendada):** sirve el frontend desde este mismo Worker
  (`index.html`, `Puerta1.html`, `Puerta2.html`, `viewer-p1.html`, `timbre.js`,
  `style.css`, `imagenes/` en una carpeta `public/` y agrega
  `assets = { directory = "./public" }` en `wrangler.jsonc`).
- **Opción B:** hostea el frontend en GitHub Pages / Vercel / Netlify y define
  la base pública:

  ```bash
  npx wrangler secret put VIEWER_BASE_URL   # ej: https://tu-dominio-publico
  ```

  (o `"vars": { "VIEWER_BASE_URL": "https://..." }` en `wrangler.jsonc`).

## Endpoints de la cámara (contrato SFU)

Todo el signaling pasa por el Worker (el secret nunca viaja al navegador):

| Acción | Método | Params | Descripción |
| --- | --- | --- | --- |
| `estado` | GET | `?tipo=camara&accion=estado` | ¿Hay sesión activa? (para polling del botón) |
| `iniciar` | POST | `tipo=camara&accion=iniciar` | Crea sesión SFU, reserva KV, devuelve `sessionId`+`viewerToken` |
| `enviar-enlace` | POST | `tipo=camara&accion=enviar-enlace` | Envía a Telegram solo la URL pública del visor de la sesión activa |
| `viewer` | POST | `tipo=camara&accion=viewer` + `token` | Crea sesión SFU del viewer, devuelve `viewerSessionId`+`sourceTracks` |
| `tracks-new` | POST | JSON `{sessionId, sessionDescription?, tracks}` | Proxy a Calls (`tracks/new`) |
| `renegotiate` | POST | JSON `{sessionId, sessionDescription}` | Proxy a Calls (`renegotiate`) |
| `finalizar` | POST | JSON `{sessionId?}` | Libera KV y cierra el SFU del transmisor |
| `finalizar-viewer` | POST | JSON `{sessionId}` | Cierra el SFU de un viewer |

Sin Call calls configurado, el Worker responde `localMode: true` (solo funciona
en el mismo navegador/origen) para no romper el desarrollo local.