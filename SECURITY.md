# Seguridad

## Reportar una vulnerabilidad

No abras un issue público. Usá **Security → Report a vulnerability** en este repositorio
(reporte privado de GitHub) y describí el problema y cómo reproducirlo.

## Qué nunca debe subirse al repo

- `.env` ni ningún archivo con credenciales reales (`ADMIN_PASSWORD`, `API_KEY`, `WEBHOOK_SECRET`).
- La carpeta `data/`: `data/auth` es la sesión del número de WhatsApp y quien la tenga puede usar esa cuenta;
  `data/messages.json` contiene mensajes de terceros.

Si algo de esto se subió por error, no alcanza con borrarlo en un commit nuevo: rotá las credenciales
y desvinculá el número desde **WhatsApp → Dispositivos vinculados**.

## Recomendaciones de despliegue

- Usá una `ADMIN_PASSWORD` larga y única, y una `API_KEY` aleatoria (por ejemplo `openssl rand -hex 32`).
- Definí `WEBHOOK_SECRET` y validá el header `x-webhook-secret` del lado que recibe el webhook.
- Exponé el servicio solo por HTTPS.
- Usá un número dedicado para el bot.
