import crypto from 'node:crypto'
import fs from 'node:fs'
import { config } from './config.js'

// Entrega de mensajes entrantes al sistema externo (el que tiene la lógica).
// Cola en orden, persistida en disco para sobrevivir redeploys, con reintentos.

const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000, 600_000] // 6 intentos en total
const MAX_QUEUE = 1000
const TIMEOUT_MS = 10_000

let queue = []
let running = false
let timer = null

export function loadWebhookQueue() {
  try {
    const saved = JSON.parse(fs.readFileSync(config.webhookQueueFile, 'utf8'))
    queue = Array.isArray(saved) ? saved : []
  } catch {
    queue = []
  }
  if (queue.length) drain()
}

function persist() {
  try {
    fs.writeFileSync(config.webhookQueueFile, JSON.stringify(queue))
  } catch (err) {
    console.error('[webhook] no se pudo guardar la cola:', err.message)
  }
}

export function getWebhookStatus() {
  return { enabled: Boolean(config.webhookUrl), signed: Boolean(config.webhookSecret), pending: queue.length }
}

export function enqueueWebhook(record) {
  if (!config.webhookUrl) return
  if (queue.length >= MAX_QUEUE) {
    const dropped = queue.splice(running ? 1 : 0, 1)[0]
    console.error(`[webhook] cola llena: se descarta el mensaje ${dropped?.id}`)
  }
  queue.push({ id: record.id, body: JSON.stringify({ event: 'message', ...record }), attempts: 0 })
  persist()
  drain()
}

export function sign(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

async function deliver(item) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const headers = {
    'Content-Type': 'application/json',
    'x-webhook-id': String(item.id || ''),
    'x-webhook-timestamp': timestamp,
    'x-webhook-attempt': String(item.attempts + 1)
  }
  if (config.webhookSecret) headers['x-webhook-signature'] = sign(config.webhookSecret, timestamp, item.body)

  const res = await fetch(config.webhookUrl, {
    method: 'POST',
    headers,
    body: item.body,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

async function drain() {
  if (running || timer) return
  running = true
  try {
    while (queue.length) {
      const item = queue[0]
      try {
        await deliver(item)
        queue.shift()
        persist()
        continue
      } catch (err) {
        item.attempts++
        const delay = RETRY_DELAYS_MS[item.attempts - 1]
        if (delay === undefined) {
          console.error(`[webhook] se descarta el mensaje ${item.id} tras ${item.attempts} intentos: ${err.message}`)
          queue.shift()
          persist()
          continue
        }
        console.error(`[webhook] falló el envío de ${item.id} (intento ${item.attempts}): ${err.message}. Reintento en ${delay / 1000}s`)
        persist()
        timer = setTimeout(() => {
          timer = null
          drain()
        }, delay)
        timer.unref()
        break
      }
    }
  } finally {
    running = false
  }
}
