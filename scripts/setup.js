#!/usr/bin/env node
// Asistente de instalación: `npm run setup`.
// Revisa los requisitos, pregunta la configuración, genera las claves y la deja lista
// para correr en local (.env) o en Railway (variables del servicio).
// No usa dependencias: tiene que poder correr antes de `npm install`.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = path.join(ROOT, '.env')
const MIN_NODE = 22
const KNOWN_KEYS = ['ADMIN_USER', 'ADMIN_PASSWORD', 'API_KEY', 'WEBHOOK_URL', 'WEBHOOK_SECRET', 'BOT_NAME']

// ---------- salida ----------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const bold = paint(1)
const dim = paint(2)
const green = paint(32)
const yellow = paint(33)
const red = paint(31)
const cyan = paint(36)

const say = (line = '') => console.log(line)
const ok = (line) => say(`  ${green('✓')} ${line}`)
const warn = (line) => say(`  ${yellow('!')} ${line}`)
const fail = (line) => say(`  ${red('✗')} ${line}`)
const step = (n, title) => say(`\n${bold(cyan(`[${n}/4]`))} ${bold(title)}`)

// ---------- entrada ----------

// Las líneas se encolan para que el asistente funcione igual con una terminal
// que con respuestas por un pipe (por ejemplo, en una prueba automatizada).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
const lines = []
const waiters = []
let finished = false

rl.on('line', (line) => (waiters.length ? waiters.shift()(line) : lines.push(line)))
rl.on('SIGINT', () => {
  say('\n\nCancelado. No se guardó nada más.')
  process.exit(130)
})
rl.on('close', () => {
  if (finished) return
  if (lines.length === 0 && waiters.length > 0) {
    say('\n\nSe cerró la entrada antes de terminar.')
    process.exit(1)
  }
})

function readLine(prompt) {
  rl.setPrompt(prompt)
  rl.prompt()
  if (lines.length) {
    const line = lines.shift()
    if (!process.stdin.isTTY) say(line)
    return Promise.resolve(line)
  }
  return new Promise((resolve) =>
    waiters.push((line) => {
      if (!process.stdin.isTTY) say(line)
      resolve(line)
    })
  )
}

async function ask(question, { fallback = '', hint = '', validate } = {}) {
  const suffix = hint || (fallback ? dim(` (${fallback})`) : '')
  for (;;) {
    const answer = (await readLine(`  ${question}${suffix}: `)).trim() || fallback
    const problem = validate?.(answer)
    if (!problem) return answer
    warn(problem)
  }
}

async function confirm(question, fallback = true) {
  for (;;) {
    const answer = (await readLine(`  ${question} ${dim(fallback ? '(S/n)' : '(s/N)')}: `)).trim().toLowerCase()
    if (!answer) return fallback
    if (['s', 'si', 'sí', 'y', 'yes'].includes(answer)) return true
    if (['n', 'no'].includes(answer)) return false
    warn('Respondé s o n.')
  }
}

async function choose(question, options) {
  say(`  ${question}`)
  options.forEach((option, i) => say(`    ${bold(i + 1)}) ${option}`))
  for (;;) {
    const answer = (await readLine(`  Opción ${dim('(1)')}: `)).trim() || '1'
    const index = Number(answer) - 1
    if (Number.isInteger(index) && options[index]) return index
    warn(`Elegí un número del 1 al ${options.length}.`)
  }
}

// ---------- utilidades ----------

const secret = (bytes) => crypto.randomBytes(bytes).toString('base64url')

function run(command, args, options = {}) {
  rl.pause()
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
  rl.resume()
  return result
}

function readExistingEnv() {
  try {
    return parseEnv(fs.readFileSync(ENV_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function envLine(key, value) {
  if (/^[\w.:/@%+=,-]*$/.test(value)) return `${key}=${value}`
  if (!value.includes("'")) return `${key}='${value}'`
  return `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function validateUrl(value) {
  if (!value) return ''
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return 'La URL tiene que empezar con http:// o https://'
    return ''
  } catch {
    return 'No parece una URL válida. Ejemplo: https://mi-app.vercel.app/api/whatsapp'
  }
}

// ---------- pasos ----------

async function checkRequirements() {
  step(1, 'Requisitos')

  const major = Number(process.versions.node.split('.')[0])
  if (major < MIN_NODE) {
    fail(`Node ${process.versions.node}: hace falta Node ${MIN_NODE} o superior (el proyecto usa la ${fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim()}).`)
    say('    Instalalo con nvm (`nvm install`) o desde https://nodejs.org y volvé a correr `npm run setup`.')
    process.exit(1)
  }
  ok(`Node ${process.versions.node}`)

  if (fs.existsSync(path.join(ROOT, 'node_modules', 'baileys'))) {
    ok('Dependencias instaladas')
    return
  }
  warn('Faltan las dependencias.')
  if (await confirm('¿Corro `npm install` ahora?')) {
    const result = run('npm', ['install'], { shell: process.platform === 'win32' })
    if (result.status !== 0) {
      fail('`npm install` falló. Revisá el error de arriba y volvé a correr `npm run setup`.')
      process.exit(1)
    }
    ok('Dependencias instaladas')
  } else {
    warn('Acordate de correr `npm install` antes de iniciar el servicio en local.')
  }
}

async function collectValues(target) {
  step(2, 'Configuración')

  // Las claves de local no se proponen para Railway: cada entorno con las suyas.
  const existing = target === 'local' ? readExistingEnv() : {}
  if (Object.keys(existing).length) say(dim('  Encontré un .env: Enter mantiene el valor actual.'))
  const values = { ...existing }

  say(`\n  ${bold('Panel web')}`)
  values.ADMIN_USER = await ask('Usuario del panel', { fallback: existing.ADMIN_USER || 'admin' })
  const currentPassword = existing.ADMIN_PASSWORD && existing.ADMIN_PASSWORD !== 'cambiame' ? existing.ADMIN_PASSWORD : ''
  values.ADMIN_PASSWORD =
    (await ask('Contraseña del panel', {
      hint: dim(currentPassword ? ' (Enter = mantener la actual)' : ' (Enter = generar una)'),
      validate: (v) => (v && v.length < 8 ? 'Usá al menos 8 caracteres, o Enter para generar una.' : '')
    })) ||
    currentPassword ||
    secret(12)

  say(`\n  ${bold('API de envío')} ${dim('— para que tu sistema mande mensajes con POST /api/send')}`)
  if (await confirm('¿Habilitar la API con una API key?', true)) {
    values.API_KEY = existing.API_KEY || secret(24)
    ok(existing.API_KEY ? 'Se mantiene la API key actual.' : 'API key generada.')
  } else {
    values.API_KEY = ''
  }

  say(`\n  ${bold('Webhook')} ${dim('— la URL de tu app que recibe cada mensaje entrante')}`)
  values.WEBHOOK_URL = await ask('URL del webhook', {
    fallback: existing.WEBHOOK_URL || '',
    hint: existing.WEBHOOK_URL ? '' : dim(' (Enter = configurarlo después)'),
    validate: validateUrl
  })
  if (values.WEBHOOK_URL) {
    const { hostname } = new URL(values.WEBHOOK_URL)
    if (target === 'railway' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
      warn('Esa URL apunta a tu máquina: desde Railway no se va a poder alcanzar.')
    }
    values.WEBHOOK_SECRET = existing.WEBHOOK_SECRET || secret(32)
    ok(existing.WEBHOOK_SECRET ? 'Se mantiene la clave de firma actual.' : 'Clave de firma generada (WEBHOOK_SECRET).')
  } else {
    values.WEBHOOK_SECRET = existing.WEBHOOK_SECRET || ''
    say(dim('    Sin webhook, los mensajes solo se ven en el panel.'))
  }

  say(`\n  ${bold('Panel')}`)
  values.BOT_NAME = await ask('Nombre para los mensajes salientes', { fallback: existing.BOT_NAME || 'Bot' })

  return values
}

async function applyLocal(values) {
  step(3, 'Guardar la configuración local')

  if (fs.existsSync(ENV_FILE) && !(await confirm('Ya existe un .env. ¿Lo reemplazo?', true))) {
    warn('No se tocó el .env. Los valores quedan en el resumen de abajo.')
    return false
  }

  const extras = Object.entries(values).filter(([key]) => !KNOWN_KEYS.includes(key))
  const content = [
    '# Generado por `npm run setup`. Solo para pruebas locales: no lo subas a ningún lado.',
    '',
    '# Panel web',
    envLine('ADMIN_USER', values.ADMIN_USER),
    envLine('ADMIN_PASSWORD', values.ADMIN_PASSWORD),
    '',
    '# API de envío (header x-api-key)',
    envLine('API_KEY', values.API_KEY),
    '',
    '# Webhook de mensajes entrantes',
    envLine('WEBHOOK_URL', values.WEBHOOK_URL),
    envLine('WEBHOOK_SECRET', values.WEBHOOK_SECRET),
    '',
    envLine('BOT_NAME', values.BOT_NAME),
    ...(extras.length ? ['', '# Otras variables que ya tenías', ...extras.map(([k, v]) => envLine(k, v))] : []),
    ''
  ].join('\n')

  fs.writeFileSync(ENV_FILE, content, { mode: 0o600 })
  fs.chmodSync(ENV_FILE, 0o600)
  ok('.env guardado (solo lo puede leer tu usuario).')
  return true
}

function railwayEntries(values) {
  return KNOWN_KEYS.map((key) => [key, values[key]]).filter(
    ([key, value]) => value && !(key === 'ADMIN_USER' && value === 'admin') && !(key === 'BOT_NAME' && value === 'Bot')
  )
}

async function applyRailway(values) {
  step(3, 'Cargar las variables en Railway')
  const entries = railwayEntries(values)

  const hasCli = spawnSync('railway', ['--version'], { stdio: 'ignore' }).status === 0
  if (!hasCli) {
    warn('No encontré el CLI de Railway, así que las variables se cargan a mano (abajo te dejo el bloque para pegar).')
    say(dim('    Con el CLI (https://docs.railway.com/guides/cli) este paso se hace solo.'))
    return false
  }

  say(dim('  Proyecto vinculado en esta carpeta:\n'))
  const status = run('railway', ['status'])
  say()
  if (status.status !== 0) {
    warn('Esta carpeta no está vinculada a un proyecto de Railway.')
    say('    Creá el proyecto (New Project → Deploy from GitHub repo), corré `railway link` acá')
    say('    y volvé a correr `npm run setup`. O cargá las variables a mano con el bloque de abajo.')
    return false
  }
  if (!(await confirm(`¿Cargo ${entries.length} variables en ese servicio? Dispara un redeploy.`, false))) {
    warn('No se cargó nada en Railway.')
    return false
  }

  for (const [index, [key, value]] of entries.entries()) {
    // El valor va por stdin para que no quede en la lista de procesos ni en el historial.
    // Solo la última variable dispara el deploy.
    const args = ['variable', 'set', key, '--stdin']
    if (index < entries.length - 1) args.push('--skip-deploys')
    const result = spawnSync('railway', args, { cwd: ROOT, input: value, encoding: 'utf8' })
    if (result.status !== 0) {
      fail(`No se pudo cargar ${key}: ${(result.stderr || result.stdout || '').trim()}`)
      say('    Cargá las variables a mano con el bloque de abajo.')
      return false
    }
    ok(key)
  }
  return true
}

function summary(target, values, applied) {
  step(4, 'Resumen')

  say(`\n  ${bold('Acceso al panel')}`)
  say(`    Usuario:     ${values.ADMIN_USER}`)
  say(`    Contraseña:  ${values.ADMIN_PASSWORD}`)

  if (target === 'railway' && !applied) {
    say(`\n  ${bold('Variables para Railway')} ${dim('— pestaña Variables → Raw Editor, pegá esto:')}\n`)
    for (const [key, value] of railwayEntries(values)) say(`    ${envLine(key, value)}`)
  }

  if (values.API_KEY || values.WEBHOOK_SECRET) {
    say(`\n  ${bold('Para tu app')} ${dim('(la que tiene la lógica, por ejemplo en Vercel)')}`)
    if (values.API_KEY) say(`    API key ${dim('(header x-api-key)')}:  ${values.API_KEY}`)
    if (values.WEBHOOK_SECRET) say(`    WEBHOOK_SECRET ${dim('(para verificar la firma)')}:  ${values.WEBHOOK_SECRET}`)
  }
  say(dim('\n  Guardá estas claves en un gestor de contraseñas: no se vuelven a mostrar.'))

  say(`\n  ${bold('Lo que falta')}`)
  if (target === 'local') {
    say('    1. Iniciá el servicio:  npm run start:local')
    say('    2. Abrí http://localhost:3000 y entrá con el usuario y la contraseña de arriba.')
    say('    3. Escaneá el QR desde WhatsApp → Dispositivos vinculados → Vincular dispositivo.')
    say('    4. Mandale un mensaje al número desde otro teléfono: tiene que aparecer en el panel.')
    return
  }
  const todo = [
    'Volume montado en /data (guarda la sesión de WhatsApp):  railway volume add --mount-path /data',
    'Dominio público:  railway domain',
    'En Settings → Deploy: healthcheck en /health, restart "On failure", 1 sola réplica y App Sleeping apagado.',
    'Abrí el dominio, entrá con el usuario y la contraseña de arriba y escaneá el QR desde',
    'Mandale un mensaje al número desde otro teléfono: tiene que aparecer en el panel' +
      (values.WEBHOOK_URL ? ' y llegar a tu webhook.' : '.')
  ]
  todo[3] += ' WhatsApp → Dispositivos vinculados → Vincular dispositivo.'
  if (!applied) todo.unshift('Cargá las variables de arriba en el servicio.')
  todo.forEach((item, i) => say(`    ${i + 1}. ${item}`))
  say(dim('\n  El detalle de cada paso está en el README, sección "Deploy en Railway".'))
}

// ---------- principal ----------

say(bold('\nWhatsApp Gateway — asistente de instalación'))
say(dim('Enter acepta el valor entre paréntesis. Ctrl+C cancela en cualquier momento.'))

await checkRequirements()

say()
const target = ['local', 'railway'][
  await choose('¿Dónde lo vas a correr?', [
    `En esta máquina ${dim('— para probarlo; escribe un archivo .env')}`,
    `En Railway ${dim('— producción; carga las variables del servicio')}`
  ])
]

const values = await collectValues(target)
const applied = target === 'local' ? await applyLocal(values) : await applyRailway(values)
summary(target, values, applied)

const canStart = target === 'local' && applied && fs.existsSync(path.join(ROOT, 'node_modules', 'baileys'))
if (canStart) say()
const startNow = canStart && (await confirm('¿Lo inicio ahora?', true))
finished = true
rl.close()

if (startNow) {
  say(dim('\n  Iniciando… Ctrl+C lo detiene.\n'))
  const child = spawn(process.execPath, ['--env-file=.env', 'src/index.js'], { cwd: ROOT, stdio: 'inherit' })
  process.on('SIGINT', () => {})
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  say()
}
