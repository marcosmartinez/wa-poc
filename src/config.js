import crypto from 'node:crypto'
import path from 'node:path'

// En Railway, si hay un volume montado, se usa automáticamente su mount path.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './data'

let adminPassword = process.env.ADMIN_PASSWORD
if (!adminPassword) {
  adminPassword = crypto.randomBytes(9).toString('base64url')
  console.warn(`[config] ADMIN_PASSWORD no está definida. Contraseña temporal generada: ${adminPassword}`)
  console.warn('[config] Definí ADMIN_PASSWORD en las variables del servicio para que no cambie en cada deploy.')
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  dataDir: DATA_DIR,
  authDir: path.join(DATA_DIR, 'auth'),
  messagesFile: path.join(DATA_DIR, 'messages.json'),
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword,
  apiKey: process.env.API_KEY || '',
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  autoReplyText: process.env.AUTO_REPLY_TEXT || '',
  botName: process.env.BOT_NAME || 'Bot',
  logLevel: process.env.LOG_LEVEL || 'warn'
}
