import { type ChildProcess } from 'node:child_process'
import {
  createBrowserSession,
  ensurePageServer,
  loadHashReport,
  type BrowserKind,
} from './browser-automation.ts'

type CorpusMeta = {
  id: string
  language: string
  title: string
  min_width?: number
  max_width?: number
  default_width?: number
}

type CorpusReport = {
  status: 'ready' | 'error'
  requestId?: string
  environment?: {
    userAgent: string
    devicePixelRatio: number
    viewport: {
      innerWidth: number
      innerHeight: number
      outerWidth: number
      outerHeight: number
      visualViewportScale: number | null
    }
    screen: {
      width: number
      height: number
      availWidth: number
      availHeight: number
      colorDepth: number
      pixelDepth: number
    }
  }
  corpusId?: string
  title?: string
  width?: number
  predictedHeight?: number
  actualHeight?: number
  diffPx?: number
  predictedLineCount?: number
  browserLineCount?: number
  browserLineMethod?: 'span-probe' | 'range'
  probeHeight?: number
  normalizedHeight?: number
  mismatchCount?: number
  firstMismatch?: {
    line: number
    ours: string
    browser: string
  } | null
  firstBreakMismatch?: {
    line: number
    oursStart: number
    browserStart: number
    oursEnd: number
    browserEnd: number
    oursText: string
    browserText: string
    oursRenderedText: string
    browserRenderedText: string
    oursContext: string
    browserContext: string
    deltaText: string
    reasonGuess: string
    oursSumWidth: number
    oursDomWidth: number
    oursFullWidth: number
    browserDomWidth: number
    browserFullWidth: number
    oursSegments: Array<{
      text: string
      width: number
      domWidth: number
      isSpace: boolean
    }>
  } | null
  maxLineWidthDrift?: number
  maxDriftLine?: {
    line: number
    drift: number
    text: string
    sumWidth: number
    fullWidth: number
    domWidth: number
    pairAdjustedWidth: number
    segments: Array<{
      text: string
      width: number
      domWidth: number
      isSpace: boolean
    }>
  } | null
  message?: string
}

function parseStringFlag(name: string): string | null {
  const prefix = `--${name}=`
  const arg = process.argv.find(value => value.startsWith(prefix))
  return arg === undefined ? null : arg.slice(prefix.length)
}

function parseNumberFlag(name: string, fallback: number): number {
  const raw = parseStringFlag(name)
  if (raw === null) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid value for --${name}: ${raw}`)
  }
  return parsed
}

function parseBrowser(value: string | null): BrowserKind {
  const browser = (value ?? process.env['CORPUS_CHECK_BROWSER'] ?? 'chrome').toLowerCase()
  if (browser !== 'chrome' && browser !== 'safari') {
    throw new Error(`Unsupported browser ${browser}; expected chrome or safari`)
  }
  return browser
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function loadSources(): Promise<CorpusMeta[]> {
  return await Bun.file('corpora/sources.json').json()
}

function getTargetWidths(meta: CorpusMeta): number[] {
  const widths = process.argv.slice(2)
    .filter(arg => !arg.startsWith('--'))
    .map(arg => Number.parseInt(arg, 10))
    .filter(width => Number.isFinite(width))

  if (widths.length > 0) return widths

  const min = meta.min_width ?? 300
  const max = meta.max_width ?? 900
  const preferred = [min, Math.max(min, Math.min(max, meta.default_width ?? 600)), max]
  return [...new Set(preferred)]
}

function printReport(report: CorpusReport): void {
  if (report.status === 'error') {
    console.log(`error: ${report.message ?? 'unknown error'}`)
    return
  }

  const width = report.width ?? 0
  const diff = Math.round(report.diffPx ?? 0)
  const predicted = Math.round(report.predictedHeight ?? 0)
  const actual = Math.round(report.actualHeight ?? 0)
  const lines = report.predictedLineCount !== undefined && report.browserLineCount !== undefined
    ? `${report.predictedLineCount}/${report.browserLineCount}`
    : '-'

  console.log(
    `width ${width}: diff ${diff > 0 ? '+' : ''}${diff}px | height ${predicted}/${actual} | lines ${lines}`,
  )
  if (report.maxLineWidthDrift !== undefined) {
    console.log(`  max line width drift: ${report.maxLineWidthDrift.toFixed(3)}px`)
  }
  if (report.environment !== undefined) {
    const env = report.environment
    console.log(
      `  env: dpr ${env.devicePixelRatio} | viewport ${env.viewport.innerWidth}x${env.viewport.innerHeight} | outer ${env.viewport.outerWidth}x${env.viewport.outerHeight} | scale ${env.viewport.visualViewportScale ?? '-'} | screen ${env.screen.width}x${env.screen.height}`,
    )
  }
  if (report.probeHeight !== undefined || report.normalizedHeight !== undefined) {
    console.log(
      `  probe heights: probe ${Math.round(report.probeHeight ?? 0)}px | normalized ${Math.round(report.normalizedHeight ?? 0)}px | book ${actual}px | method ${report.browserLineMethod ?? '-'}`,
    )
  }
  if (report.maxDriftLine !== null && report.maxDriftLine !== undefined) {
    console.log(
      `  drift sample L${report.maxDriftLine.line}: ${report.maxDriftLine.drift.toFixed(3)}px (${report.maxDriftLine.sumWidth.toFixed(3)} sum vs ${report.maxDriftLine.fullWidth.toFixed(3)} full vs ${report.maxDriftLine.domWidth.toFixed(3)} dom vs ${report.maxDriftLine.pairAdjustedWidth.toFixed(3)} pair)`,
    )
    console.log(`  text: ${JSON.stringify(report.maxDriftLine.text.slice(0, 140))}`)
    if (report.maxDriftLine.segments.length > 0) {
      const summary = report.maxDriftLine.segments
        .map(segment => `${JSON.stringify(segment.text)}@${segment.width.toFixed(2)}/${segment.domWidth.toFixed(2)}${segment.isSpace ? ':space' : ''}`)
        .join(' | ')
      console.log(`  segments: ${summary}`)
    }
  }
  if (report.firstBreakMismatch !== null && report.firstBreakMismatch !== undefined) {
    const mismatch = report.firstBreakMismatch
    console.log(`  break L${mismatch.line}: ${mismatch.reasonGuess}`)
    console.log(`  offsets: ours ${mismatch.oursStart}-${mismatch.oursEnd} | browser ${mismatch.browserStart}-${mismatch.browserEnd}`)
    console.log(`  delta: ${JSON.stringify(mismatch.deltaText)}`)
    console.log(`  ours text:    ${JSON.stringify(mismatch.oursText)}`)
    console.log(`  browser text: ${JSON.stringify(mismatch.browserText)}`)
    console.log(`  ours rendered:    ${JSON.stringify(mismatch.oursRenderedText)}`)
    console.log(`  browser rendered: ${JSON.stringify(mismatch.browserRenderedText)}`)
    console.log(`  ours:    ${mismatch.oursContext}`)
    console.log(`  browser: ${mismatch.browserContext}`)
    console.log(
      `  widths: ours sum/dom/full ${mismatch.oursSumWidth.toFixed(3)}/${mismatch.oursDomWidth.toFixed(3)}/${mismatch.oursFullWidth.toFixed(3)} | browser dom/full ${mismatch.browserDomWidth.toFixed(3)}/${mismatch.browserFullWidth.toFixed(3)}`,
    )
    if (mismatch.oursSegments.length > 0) {
      const summary = mismatch.oursSegments
        .map(segment => `${JSON.stringify(segment.text)}@${segment.width.toFixed(2)}/${segment.domWidth.toFixed(2)}${segment.isSpace ? ':space' : ''}`)
        .join(' | ')
      console.log(`  ours segments: ${summary}`)
    }
  } else if (report.firstMismatch !== null && report.firstMismatch !== undefined) {
    console.log(`  first mismatch L${report.firstMismatch.line}`)
    console.log(`  ours:    ${JSON.stringify(report.firstMismatch.ours.slice(0, 120))}`)
    console.log(`  browser: ${JSON.stringify(report.firstMismatch.browser.slice(0, 120))}`)
  }
}

let serverProcess: ChildProcess | null = null
const browser = parseBrowser(parseStringFlag('browser'))
const port = parseNumberFlag('port', Number.parseInt(process.env['CORPUS_CHECK_PORT'] ?? '3210', 10))
const timeoutMs = parseNumberFlag('timeout', Number.parseInt(process.env['CORPUS_CHECK_TIMEOUT_MS'] ?? '180000', 10))
const sources = await loadSources()
const id = parseStringFlag('id')

if (id === null) {
  throw new Error(`Missing --id. Available corpora: ${sources.map(source => source.id).join(', ')}`)
}

const meta = sources.find(source => source.id === id)
if (meta === undefined) {
  throw new Error(`Unknown corpus ${id}. Available corpora: ${sources.map(source => source.id).join(', ')}`)
}

const session = createBrowserSession(browser)
const diagnose = hasFlag('diagnose')

try {
  const pageServer = await ensurePageServer(port, '/corpus', process.cwd())
  serverProcess = pageServer.process
  const baseUrl = `${pageServer.baseUrl}/corpus`
  console.log(`${meta.id} (${meta.language}) — ${meta.title}`)

  for (const width of getTargetWidths(meta)) {
    const requestId = `${Date.now()}-${width}-${Math.random().toString(36).slice(2)}`
    const url =
      `${baseUrl}?id=${encodeURIComponent(meta.id)}` +
      `&width=${width}` +
      `&report=1` +
      `&diagnostic=${diagnose ? 'full' : 'light'}` +
      `&requestId=${encodeURIComponent(requestId)}`

    const report = await loadHashReport<CorpusReport>(session, url, requestId, browser, timeoutMs)
    printReport(report)
    if (report.status === 'error') {
      process.exitCode = 1
      break
    }
  }
} finally {
  session.close()
  serverProcess?.kill()
}
