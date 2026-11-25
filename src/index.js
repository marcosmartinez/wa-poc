import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { config } from './config.js'
import { listMessages, loadMessages } from './store.js'
import {
  getStatus,
  listGroups,
  logout,
  requestPairingCode,
  sendText,
  startWhatsApp,
  stopWhatsApp
} from './wa.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
fs.mkdirSync(config.dataDir, { recursive: true })
loadMessages()

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '100kb' }))

function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

function isAdmin(req) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Basic ')) return false
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':')
  return safeEqual(user, config.adminUser) && safeEqual(rest.join(':'), config.adminPassword)
}

function hasApiKey(req) {
  return Boolean(config.apiKey) && safeEqual(req.headers['x-api-key'] || '', config.apiKey)
}

// Panel: usuario y contraseña (Basic Auth del navegador)
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next()
  res.set('WWW-Authenticate', 'Basic realm="WhatsApp Bot", charset="UTF-8"')
  res.status(401).send('Autenticación requerida')
}

// API: contraseña del panel o API key
function requireAdminOrKey(req, res, next) {
  if (isAdmin(req) || hasApiKey(req)) return next()
  res.status(401).json({ error: 'No autorizado: mandá x-api-key o usuario/contraseña' })
}

const wrap = fn => (req, res) =>
  Promise.resolve(fn(req, res)).catch(err => res.status(400).json({ error: err.message }))

// Healthcheck público (Railway lo usa para saber si el deploy está vivo)
app.get('/health', (req, res) => res.json({ ok: true, whatsapp: getStatus().status }))

// API
app.get('/api/status', requireAdminOrKey, (req, res) => res.json(getStatus()))

app.get('/api/messages', requireAdminOrKey, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 300)
  res.json(listMessages(limit))
})

app.post('/api/send', requireAdminOrKey, wrap(async (req, res) => {
  const { to, text } = req.body || {}
  res.json({ sent: true, ...(await sendText(to, text)) })
}))

app.get('/api/groups', requireAdminOrKey, wrap(async (req, res) => res.json(await listGroups())))

app.post('/api/pairing-code', requireAdmin, wrap(async (req, res) => {
  res.json({ code: await requestPairingCode(req.body?.phone) })
}))

app.post('/api/logout', requireAdmin, wrap(async (req, res) => {
  await logout()
  res.json({ ok: true })
}))

// Panel web
app.use('/', requireAdmin, express.static(path.join(__dirname, '..', 'public')))

const server = app.listen(config.port, () => {
  console.log(`[http] escuchando en el puerto ${config.port}`)
  console.log(`[http] datos en ${path.resolve(config.dataDir)}`)
})

startWhatsApp().catch(err => {
  console.error('[wa] no se pudo iniciar:', err)
})

async function shutdown(signal) {
  console.log(`[app] ${signal} recibido, cerrando…`)
  await stopWhatsApp()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
