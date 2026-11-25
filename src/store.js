import fs from 'node:fs'
import { config } from './config.js'

const MAX_MESSAGES = 300
let messages = []
let saveTimer = null

export function loadMessages() {
  try {
    messages = JSON.parse(fs.readFileSync(config.messagesFile, 'utf8'))
  } catch {
    messages = []
  }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    fs.promises
      .writeFile(config.messagesFile, JSON.stringify(messages))
      .catch(err => console.error('[store] no se pudo guardar el historial:', err.message))
  }, 1000)
}

export function addMessage(msg) {
  messages.push(msg)
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES)
  scheduleSave()
}

export function listMessages(limit = 100) {
  return messages.slice(-limit).reverse()
}
