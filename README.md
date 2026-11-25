# WhatsApp Bot POC (Baileys + Railway)

Bot de WhatsApp con panel web y API. Cualquier persona con la contraseña puede vincular un número escaneando un QR, ver los mensajes que llegan, mandar mensajes y desvincular el número. Otros sistemas pueden enviar mensajes por API y recibir los entrantes por webhook.

## Qué incluye

- **Panel web** (`/`): estado de la conexión, QR o código de vinculación, envío de mensajes, lista de grupos, últimos 300 mensajes y botón para desvincular. Se protege con usuario y contraseña.
- **Respuestas automáticas**: `ping` → `pong`, `/hora` y `/ayuda`. Si definís `AUTO_REPLY_TEXT`, también contesta ese texto a cualquier mensaje directo. En grupos solo responde a comandos.
- **API REST** para integrar con otros sistemas (ver abajo).
- **Webhook** opcional: hace un POST a tu URL con cada mensaje entrante.
- **Sesión persistente** en un volume: los redeploys no piden escanear de nuevo.
- **Reconexión automática** con backoff. Si se desvincula desde el teléfono, genera un QR nuevo solo.

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
   | `WEBHOOK_URL` | No | URL que recibe cada mensaje entrante |
   | `WEBHOOK_SECRET` | No | Se manda en el header `x-webhook-secret` para validar el webhook |
   | `AUTO_REPLY_TEXT` | No | Respuesta automática para mensajes directos |
   | `BOT_NAME` | No | Nombre del bot en `/ayuda` |
5. **Publicá el servicio**: en **Settings → Networking → Generate Domain**.
6. **Recomendado**, en **Settings → Deploy**:
   - Healthcheck path: `/health`
   - Restart policy: *On failure*
   - Réplicas: **1**. Nunca más de una: dos instancias con la misma sesión se desconectan entre sí.
   - Si está activo *App Sleeping / Serverless*, apagalo. El bot necesita estar siempre conectado.
7. **Vinculá el número**: abrí `https://TU-APP.up.railway.app`, entrá con `admin` y tu contraseña, y escaneá el QR desde **WhatsApp → Dispositivos vinculados → Vincular dispositivo**. Si no podés escanear, usá *Obtener código* y elegí *Vincular con número de teléfono* en el celular.
8. **Probalo**: desde otro teléfono mandale `ping` al número del bot y tiene que contestar `pong`.

## API

Autenticación: header `x-api-key: TU_API_KEY` (o usuario y contraseña del panel).

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Público. `{ ok, whatsapp }` |
| GET | `/api/status` | Estado de la conexión y número vinculado |
| POST | `/api/send` | `{ "to": "5493511234567", "text": "Hola" }`. `to` también acepta un ID de grupo (`...@g.us`) |
| GET | `/api/messages?limit=100` | Últimos mensajes (entrantes y salientes) |
| GET | `/api/groups` | Grupos donde está el número, con su ID |

```bash
curl -X POST https://TU-APP.up.railway.app/api/send \
  -H "x-api-key: TU_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"5493511234567","text":"Hola desde la API"}'
```

Formato del webhook (POST a `WEBHOOK_URL`):
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

## Correr en local

```bash
cp .env.example .env   # y completá ADMIN_PASSWORD
npm install
node --env-file=.env src/index.js
# abrí http://localhost:3000
```
La sesión y el historial se guardan en `./data`. No subas esa carpeta a ningún lado.

## Personalizar el bot

La lógica de respuesta está en `buildReply()` en `src/wa.js`. Ahí podés agregar comandos, llamar a un LLM o consultar tu backend. Si preferís mantener la lógica en otro servicio, usá el webhook más `/api/send`.

## Estructura

```
src/index.js    servidor HTTP, auth y rutas
src/wa.js       conexión de WhatsApp (Baileys), mensajes y reconexión
src/store.js    historial de mensajes en /data/messages.json
src/config.js   variables de entorno
public/         panel web
Dockerfile      imagen que usa Railway
```

## Advertencias

- Baileys **no es la API oficial** de WhatsApp: se conecta como un "dispositivo vinculado", igual que WhatsApp Web. Usá un número dedicado y no hagas envíos masivos a gente que no te escribió, porque WhatsApp puede bloquear el número.
- Para un uso comercial con clientes a escala, lo correcto es la **WhatsApp Cloud API** oficial de Meta.
- La carpeta `/data/auth` es la sesión del número: quien la tenga puede usar esa cuenta. No la compartas.
