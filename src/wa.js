import fs from 'node:fs'
import pino from 'pino'
import QRCode from 'qrcode'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  normalizeMessageContent,
  useMultiFileAuthState
} from 'baileys'
import { config } from './config.js'
import { addMessage } from './store.js'
import { enqueueWebhook } from './webhook.js'

const logger = pino({ level: config.logLevel })

const state = {
  status: 'starting', // starting | qr | connected | reconnecting | stopped
  qr: null,
  qrDataUrl: null,
  me: null,
  lastError: null,
  connectedAt: null
}

let sock = null
let generation = 0
let retries = 0
let stopping = false

export function getStatus() {
  return {
    status: state.status,
    qr: state.qrDataUrl,
    me: state.me,
    lastError: state.lastError,
    connectedAt: state.connectedAt
  }
}

export async function startWhatsApp() {
  const gen = ++generation
  fs.mkdirSync(config.authDir, { recursive: true })
  const { state: authState, saveCreds } = await useMultiFileAuthState(config.authDir)

  let version
  try {
    ;({ version } = await fetchLatestBaileysVersion())
  } catch {
    version = undefined // usa la versión que trae Baileys
  }

  sock = makeWASocket({
    version,
    auth: authState,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async update => {
    if (gen !== generation) return // evento de un socket viejo
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      state.status = 'qr'
      state.qr = qr
      state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 })
    }

    if (connection === 'open') {
      retries = 0
      state.status = 'connected'
      state.qr = state.qrDataUrl = null
      state.lastError = null
      state.connectedAt = new Date().toISOString()
      state.me = { id: sock.user?.id, name: sock.user?.name || sock.user?.notify || null }
      console.log(`[wa] conectado como ${state.me.id}`)
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      state.lastError = lastDisconnect?.error?.message || null
      state.me = null
      state.connectedAt = null
      if (stopping) return

      if (code === DisconnectReason.loggedOut) {
        console.log('[wa] la sesión fue cerrada desde el teléfono. Se borra y se genera un QR nuevo.')
        clearAuth()
        state.status = 'starting'
        setTimeout(() => startWhatsApp(), 1000)
        return
      }

      retries++
      const delay = Math.min(30000, 1000 * 2 ** Math.min(retries, 5))
      state.status = 'reconnecting'
      console.log(`[wa] conexión cerrada (código ${code}). Reintento en ${delay / 1000}s`)
      setTimeout(() => startWhatsApp(), delay)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (gen !== generation || type !== 'notify') return
    for (const m of messages) {
      try {
        await handleIncoming(m)
      } catch (err) {
        console.error('[wa] error procesando mensaje:', err.message)
      }
    }
  })
}

function extractText(message) {
  const content = normalizeMessageContent(message)
  if (!content) return { kind: 'unknown', text: '' }
  const kind = getContentType(content)
  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  const labels = {
    imageMessage: '[imagen]',
    videoMessage: '[video]',
    audioMessage: '[audio]',
    documentMessage: '[documento]',
    stickerMessage: '[sticker]',
    locationMessage: '[ubicación]',
    contactMessage: '[contacto]'
  }
  return { kind, text: text || labels[kind] || '' }
}

async function handleIncoming(m) {
  if (!m.message || m.key.fromMe) return
  const chat = m.key.remoteJid
  if (!chat || chat === 'status@broadcast') return

  const { kind, text } = extractText(m.message)
  if (!text || kind === 'protocolMessage' || kind === 'reactionMessage') return

  const isGroup = isJidGroup(chat)
  const sender = isGroup ? m.key.participantAlt || m.key.participant : m.key.remoteJidAlt || chat

  const record = {
    id: m.key.id,
    direction: 'in',
    chat,
    chatType: isGroup ? 'group' : 'direct',
    from: sender,
    name: m.pushName || null,
    text,
    timestamp: new Date(Number(m.messageTimestamp) * 1000 || Date.now()).toISOString()
  }
  addMessage(record)
  // Este servicio no decide qué contestar: solo entrega el mensaje al sistema externo.
  enqueueWebhook(record)
}

export function toJid(to) {
  const value = String(to || '').trim()
  if (value.includes('@')) return value
  const digits = value.replace(/\D/g, '')
  if (digits.length < 8) throw new Error('Número inválido: usá formato internacional, ej. 5493511234567')
  return `${digits}@s.whatsapp.net`
}

export async function sendText(to, text, options = {}) {
  if (state.status !== 'connected' || !sock) throw new Error('WhatsApp no está conectado')
  if (!text || !String(text).trim()) throw new Error('El texto está vacío')
  let jid = toJid(to)

  if (jid.endsWith('@s.whatsapp.net')) {
    const [result] = (await sock.onWhatsApp(jid)) || []
    if (!result?.exists) throw new Error('Ese número no tiene WhatsApp')
    jid = result.jid || jid
  }

  const sent = await sock.sendMessage(jid, { text: String(text) }, options)
  addMessage({
    id: sent?.key?.id,
    direction: 'out',
    chat: jid,
    chatType: isJidGroup(jid) ? 'group' : 'direct',
    from: state.me?.id || null,
    name: config.botName,
    text: String(text),
    timestamp: new Date().toISOString()
  })
  return { id: sent?.key?.id, to: jid }
}

export async function requestPairingCode(phone) {
  if (!sock) throw new Error('El socket todavía no arrancó')
  if (state.status === 'connected') throw new Error('Ya hay un número vinculado')
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length < 8) throw new Error('Número inválido: usá formato internacional, ej. 5493511234567')
  return sock.requestPairingCode(digits)
}

export async function listGroups() {
  if (state.status !== 'connected' || !sock) throw new Error('WhatsApp no está conectado')
  const groups = await sock.groupFetchAllParticipating()
  return Object.values(groups).map(g => ({ id: g.id, name: g.subject, participants: g.participants?.length || 0 }))
}

function clearAuth() {
  fs.rmSync(config.authDir, { recursive: true, force: true })
}

export async function logout() {
  generation++ // ignora eventos del socket actual
  try {
    await sock?.logout()
  } catch {
    // si ya estaba desconectado, no importa
  }
  try {
    sock?.end(undefined)
  } catch {}
  clearAuth()
  state.status = 'starting'
  state.me = null
  state.qr = state.qrDataUrl = null
  await startWhatsApp()
}

export async function stopWhatsApp() {
  stopping = true
  try {
    sock?.end(undefined)
  } catch {}
  state.status = 'stopped'
}
