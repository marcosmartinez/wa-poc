# WhatsApp Gateway POC (Baileys + Railway)

Puente entre WhatsApp y tu sistema. Este servicio solo mantiene la conexión con WhatsApp: entrega cada mensaje entrante a tu sistema por webhook y envía los mensajes que tu sistema le pide por API. **No tiene lógica de negocio**: qué contestar, comandos, LLMs y flujos viven en otra aplicación (por ejemplo, una desplegada en Vercel).

```
WhatsApp ⇄ este servicio (Railway) ── webhook firmado ──▶ tu app (Vercel, etc.)
                                   ◀── POST /api/send ───
```

Incluye un panel web donde cualquier persona con la contraseña puede vincular un número escaneando un QR, ver los mensajes, mandar mensajes de prueba y desvincular el número.

## Qué incluye

- **Panel web** (`/`): estado de la conexión, QR o código de vinculación, envío de mensajes, lista de grupos, últimos 300 mensajes y botón para desvincular. Se protege con usuario y contraseña.
- **Webhook** de mensajes entrantes: POST a tu URL, firmado con HMAC, con reintentos y cola persistente.
- **API REST** para que tu sistema envíe mensajes (ver abajo).
- **Sesión persistente** en un volume: los redeploys no piden escanear de nuevo.
- **Reconexión automática** con backoff. Si se desvincula desde el teléfono, genera un QR nuevo solo.

## Instalación guiada

```bash
npm run setup
```

El asistente revisa los requisitos (Node, dependencias), pregunta la configuración, genera las claves (`ADMIN_PASSWORD`, `API_KEY`, `WEBHOOK_SECRET`) y la deja aplicada:

- **En local**: escribe el `.env` y ofrece iniciar el servicio.
- **En Railway**: si tenés el [CLI de Railway](https://docs.railway.com/guides/cli) y la carpeta vinculada (`railway link`), carga las variables en el servicio después de pedirte confirmación. Si no, te deja el bloque listo para pegar en el *Raw Editor*.

Al final muestra lo que falta hacer a mano (volume, dominio, escanear el QR). Se puede volver a correr cuando quieras: en local mantiene los valores que ya tenías. Los pasos de abajo son lo mismo, hecho a mano.

## Deploy en Railway (10 minutos)

1. **Subí el código a GitHub**
   ```bash
   git init && git add . && git commit -m "WhatsApp bot POC"
   git remote add origin git@github.com:TU-ORG/wa-bot.git
   git push -u origin main
   ```
2. **Creá el proyecto**: en Railway elegís **New Project → Deploy from GitHub repo** y seleccionás el repo. Railway detecta el `Dockerfile` y lo usa.
3. **Agregá un volume**: con clic derecho en el canvas (o ⌘K) elegís **Volume**, lo conectás al servicio y ponés como mount path **`/data`**. La app detecta el volume sola con `RAILWAY_VOLUME_MOUNT_PATH`.
4. **Cargá las variables** en el servicio (pestaña *Variables*):
   | Variable | Obligatoria | Para qué |
   |---|---|---|
   | `ADMIN_PASSWORD` | Sí | Contraseña del panel (el usuario es `admin`, o el que pongas en `ADMIN_USER`) |
   | `API_KEY` | No | Habilita `/api/*` con el header `x-api-key` |
   | `WEBHOOK_URL` | No | URL de tu sistema que recibe cada mensaje entrante |
   | `WEBHOOK_SECRET` | No (recomendada) | Clave con la que se firma cada webhook (`openssl rand -hex 32`) |
   | `BOT_NAME` | No | Nombre con el que se muestran los mensajes salientes en el panel |
5. **Publicá el servicio**: en **Settings → Networking → Generate Domain**.
6. **Recomendado**, en **Settings → Deploy**:
   - Healthcheck path: `/health`
   - Restart policy: *On failure*
   - Réplicas: **1**. Nunca más de una: dos instancias con la misma sesión se desconectan entre sí.
   - Si está activo *App Sleeping / Serverless*, apagalo. El bot necesita estar siempre conectado.
7. **Vinculá el número**: abrí `https://TU-APP.up.railway.app`, entrá con `admin` y tu contraseña, y escaneá el QR desde **WhatsApp → Dispositivos vinculados → Vincular dispositivo**. Si no podés escanear, usá *Obtener código* y elegí *Vincular con número de teléfono* en el celular.
8. **Probalo**: desde otro teléfono mandale un mensaje al número vinculado. Tiene que aparecer en el panel y llegar a tu `WEBHOOK_URL`. El servicio no contesta nada por su cuenta.

## API

Autenticación: header `x-api-key: TU_API_KEY` (o usuario y contraseña del panel).

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Público. `{ ok, whatsapp }` |
| GET | `/api/status` | Estado de la conexión, número vinculado y estado del webhook (`pending` = mensajes en cola) |
| POST | `/api/send` | `{ "to": "5493511234567", "text": "Hola" }`. `to` también acepta un ID de grupo (`...@g.us`) |
| GET | `/api/messages?limit=100` | Últimos mensajes (entrantes y salientes) |
| GET | `/api/groups` | Grupos donde está el número, con su ID |

```bash
curl -X POST https://TU-APP.up.railway.app/api/send \
  -H "x-api-key: TU_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"5493511234567","text":"Hola desde la API"}'
```

## Webhook de mensajes entrantes

Por cada mensaje entrante se hace un POST a `WEBHOOK_URL` con este cuerpo:

```json
{
  "event": "message",
  "id": "3EB0...",
  "direction": "in",
  "chat": "5493517654321@s.whatsapp.net",
  "chatType": "direct",
  "from": "5493517654321@s.whatsapp.net",
  "name": "Juan",
  "text": "Hola",
  "timestamp": "2026-11-25T12:41:00.000Z"
}
```

Para contestar, usá `chat` como `to` en `/api/send`.

| Header | Contenido |
|---|---|
| `x-webhook-id` | ID del mensaje. Usalo para descartar duplicados |
| `x-webhook-timestamp` | Momento del envío, en segundos Unix |
| `x-webhook-attempt` | Número de intento (1 a 6) |
| `x-webhook-signature` | `sha256=` + HMAC-SHA256 de `"<timestamp>.<cuerpo>"` con `WEBHOOK_SECRET`. Solo si la definiste |

**Entrega y reintentos**

- Tu endpoint tiene que responder un código 2xx en menos de 10 segundos. Respondé rápido y procesá después si la lógica tarda (por ejemplo, una llamada a un LLM).
- Si falla, se reintenta a los 2 s, 10 s, 30 s, 2 min y 10 min. Tras 6 intentos fallidos el mensaje se descarta y queda en el log.
- Los mensajes se entregan en orden: mientras uno se reintenta, los siguientes esperan en la cola (máximo 1000).
- La cola se guarda en el volume (`webhook-queue.json`), así que sobrevive a los redeploys.
- Un mensaje puede llegar más de una vez (por ejemplo, si tu respuesta se perdió). Usá `x-webhook-id` para ignorar repetidos.

**Verificar la firma** (ejemplo para un Route Handler de Next.js en Vercel):

```js
import crypto from 'node:crypto'

export async function POST(req) {
  const body = await req.text() // el cuerpo crudo, sin parsear
  const timestamp = req.headers.get('x-webhook-timestamp') || ''
  const signature = req.headers.get('x-webhook-signature') || ''
  const expected =
    'sha256=' + crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex')

  const valid =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) &&
    Math.abs(Date.now() / 1000 - Number(timestamp)) < 300 // rechaza envíos viejos
  if (!valid) return new Response('firma inválida', { status: 401 })

  const message = JSON.parse(body)
  // … tu lógica: decidir la respuesta y llamar a POST /api/send con to = message.chat
  return Response.json({ ok: true })
}
```

## Correr en local

```bash
npm run setup          # crea el .env y ofrece iniciar el servicio
```

O a mano:

```bash
cp .env.example .env   # y completá ADMIN_PASSWORD
npm install
npm run start:local
# abrí http://localhost:3000
```
La sesión y el historial se guardan en `./data`. No subas esa carpeta a ningún lado.

## Dónde va la lógica

En tu aplicación, no acá. Tu app recibe el webhook, decide qué hacer (comandos, LLM, consultas a tu backend) y contesta con `POST /api/send`. Este servicio se mantiene mínimo a propósito: es la única pieza que tiene que estar siempre conectada, y cuanto menos cambie, menos se corta la sesión de WhatsApp.

## Estructura

```
src/index.js    servidor HTTP, auth y rutas
src/wa.js       conexión de WhatsApp (Baileys), mensajes y reconexión
src/webhook.js  entrega de mensajes entrantes: firma, cola y reintentos
src/store.js    historial de mensajes en /data/messages.json
src/config.js   variables de entorno
scripts/setup.js  asistente de instalación (`npm run setup`)
public/         panel web
Dockerfile      imagen que usa Railway
```

## Advertencias

- Baileys **no es la API oficial** de WhatsApp: se conecta como un "dispositivo vinculado", igual que WhatsApp Web. Usá un número dedicado y no hagas envíos masivos a gente que no te escribió, porque WhatsApp puede bloquear el número.
- Para un uso comercial con clientes a escala, lo correcto es la **WhatsApp Cloud API** oficial de Meta.
- La cola de webhooks y el historial guardan texto de mensajes de terceros en `/data`.
- La carpeta `/data/auth` es la sesión del número: quien la tenga puede usar esa cuenta. No la compartas.

## Licencia

[MIT](LICENSE) © 2026 Fligoo.
