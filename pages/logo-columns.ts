import { layoutNextLine, layoutWithLines, prepareWithSegments, type LayoutCursor, type LayoutLine, type PreparedTextWithSegments } from '../src/layout.ts'
import { BODY_COPY } from './logo-columns-text.ts'

const BODY_FONT = '16px "Helvetica Neue", Helvetica, Arial, sans-serif'
const BODY_LINE_HEIGHT = 25
const CREDIT_LINE_HEIGHT = 16
const HEADLINE_TEXT = 'SITUATIONAL AWARENESS: THE DECADE AHEAD'
const HEADLINE_FONT_FAMILY = '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, serif'

type Rect = {
  x: number
  y: number
  width: number
  height: number
}

type Interval = {
  left: number
  right: number
}

type MaskRow = {
  left: number
  right: number
}

type ImageMask = {
  width: number
  height: number
  rows: Array<MaskRow | null>
}

type PositionedLine = {
  x: number
  y: number
  text: string
}

type BandObstacle = {
  getIntervals: (bandTop: number, bandBottom: number) => Interval[]
}

const stage = document.getElementById('stage') as HTMLDivElement
const headline = document.getElementById('headline') as HTMLHeadingElement
const credit = document.getElementById('credit') as HTMLParagraphElement
const openaiLogo = document.getElementById('openai-logo') as HTMLImageElement
const claudeLogo = document.getElementById('claude-logo') as HTMLImageElement

const preparedByKey = new Map<string, PreparedTextWithSegments>()
const maskByKey = new Map<string, Promise<ImageMask>>()
const scheduled = { value: false }

function getTypography(): { font: string, lineHeight: number } {
  return { font: BODY_FONT, lineHeight: BODY_LINE_HEIGHT }
}

function getPrepared(text: string, font: string): PreparedTextWithSegments {
  const key = `${font}::${text}`
  const cached = preparedByKey.get(key)
  if (cached !== undefined) return cached
  const prepared = prepareWithSegments(text, font)
  preparedByKey.set(key, prepared)
  return prepared
}

async function makeImageMask(src: string, width: number, height: number): Promise<ImageMask> {
  const image = new Image()
  image.src = src
  await image.decode()

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('2d context unavailable')

  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)

  const { data } = ctx.getImageData(0, 0, width, height)
  const rows: Array<MaskRow | null> = new Array(height)

  for (let y = 0; y < height; y++) {
    let left = width
    let right = -1
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3]!
      if (alpha < 12) continue
      if (x < left) left = x
      if (x > right) right = x
    }
    rows[y] = right >= left ? { left, right: right + 1 } : null
  }

  return { width, height, rows }
}

function getMask(src: string, width: number, height: number): Promise<ImageMask> {
  const key = `${src}::${width}x${height}`
  const cached = maskByKey.get(key)
  if (cached !== undefined) return cached
  const promise = makeImageMask(src, width, height)
  maskByKey.set(key, promise)
  return promise
}

function getMaskIntervalForBand(
  mask: ImageMask,
  rect: Rect,
  bandTop: number,
  bandBottom: number,
  horizontalPadding: number,
  verticalPadding: number,
): Interval | null {
  if (bandBottom <= rect.y || bandTop >= rect.y + rect.height) return null

  const startRow = Math.max(0, Math.floor(bandTop - rect.y - verticalPadding))
  const endRow = Math.min(mask.height - 1, Math.ceil(bandBottom - rect.y + verticalPadding))

  let left = mask.width
  let right = -1

  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex++) {
    const row = mask.rows[rowIndex]
    if (row === null || row === undefined) continue
    if (row.left < left) left = row.left
    if (row.right > right) right = row.right
  }

  if (right < left) return null

  return {
    left: rect.x + left - horizontalPadding,
    right: rect.x + right + horizontalPadding,
  }
}

function getRectIntervalsForBand(
  rects: Rect[],
  bandTop: number,
  bandBottom: number,
  horizontalPadding: number,
  verticalPadding: number,
): Interval[] {
  const intervals: Interval[] = []
  for (const rect of rects) {
    if (bandBottom <= rect.y - verticalPadding || bandTop >= rect.y + rect.height + verticalPadding) continue
    intervals.push({
      left: rect.x - horizontalPadding,
      right: rect.x + rect.width + horizontalPadding,
    })
  }
  return intervals
}

function subtractIntervals(base: Interval, intervals: Interval[]): Interval[] {
  let slots: Interval[] = [base]

  for (const interval of intervals) {
    const next: Interval[] = []
    for (const slot of slots) {
      if (interval.right <= slot.left || interval.left >= slot.right) {
        next.push(slot)
        continue
      }
      if (interval.left > slot.left) {
        next.push({ left: slot.left, right: interval.left })
      }
      if (interval.right < slot.right) {
        next.push({ left: interval.right, right: slot.right })
      }
    }
    slots = next
  }

  return slots.filter(slot => slot.right - slot.left >= 24)
}

function layoutColumn(
  prepared: PreparedTextWithSegments,
  startCursor: LayoutCursor,
  region: Rect,
  lineHeight: number,
  obstacles: BandObstacle[],
  side: 'left' | 'right',
): { lines: PositionedLine[], bottom: number, cursor: LayoutCursor } {
  let cursor: LayoutCursor = startCursor
  let lineTop = region.y
  const lines: PositionedLine[] = []
  const narrowBreakWidth = region.width * 0.76

  while (true) {
    if (lineTop + lineHeight > region.y + region.height) break

    const bandTop = lineTop
    const bandBottom = lineTop + lineHeight
    const blocked: Interval[] = []
    for (const obstacle of obstacles) {
      blocked.push(...obstacle.getIntervals(bandTop, bandBottom))
    }

    const slots = subtractIntervals(
      { left: region.x, right: region.x + region.width },
      blocked,
    )
    if (slots.length === 0) {
      lineTop += lineHeight
      continue
    }

    const slot = side === 'left'
      ? slots[slots.length - 1]!
      : slots[0]!
    const width = slot.right - slot.left
    const line = layoutNextLine(prepared, cursor, width)
    if (line === null) break
    const breaksInsideWord = line.end.graphemeIndex > 0
    if (breaksInsideWord && width < narrowBreakWidth) {
      lineTop += lineHeight
      continue
    }

    lines.push({
      x: Math.round(slot.left),
      y: Math.round(lineTop),
      text: line.text,
    })

    cursor = line.end
    lineTop += lineHeight
  }

  return { lines, bottom: lineTop, cursor }
}

function clearRenderedLines(): void {
  const lines = stage.querySelectorAll('.line')
  lines.forEach(line => {
    line.remove()
  })
}

function materializeLines(lines: PositionedLine[], lineClassName: string, font: string, lineHeight: number): void {
  for (const line of lines) {
    const el = document.createElement('div')
    el.className = lineClassName
    el.textContent = line.text
    el.style.left = `${line.x}px`
    el.style.top = `${line.y}px`
    el.style.font = font
    el.style.lineHeight = `${lineHeight}px`
    stage.appendChild(el)
  }
}

function getPreparedSingleLineWidth(text: string, font: string, lineHeight: number): number {
  const result = layoutWithLines(getPrepared(text, font), 10_000, lineHeight)
  return result.lines[0]?.width ?? 0
}

function titleLayoutKeepsWholeWords(lines: LayoutLine[]): boolean {
  const words = new Set(HEADLINE_TEXT.split(/\s+/))
  for (const line of lines) {
    const tokens = line.text.split(' ').filter(Boolean)
    for (const token of tokens) {
      if (!words.has(token)) return false
    }
  }
  return true
}

function fitHeadlineFontSize(headlineWidth: number, pageWidth: number): number {
  const maxSize = Math.min(94.4, Math.max(55.2, pageWidth * 0.055))
  let low = Math.max(22, pageWidth * 0.026)
  let high = maxSize
  let best = low
  const words = HEADLINE_TEXT.split(/\s+/)

  for (let iteration = 0; iteration < 10; iteration++) {
    const size = (low + high) / 2
    const lineHeight = Math.round(size * 0.92)
    const font = `700 ${size}px ${HEADLINE_FONT_FAMILY}`
    let widestWord = 0

    for (const word of words) {
      const width = getPreparedSingleLineWidth(word, font, lineHeight)
      if (width > widestWord) widestWord = width
    }

    const titleLayout = layoutWithLines(getPrepared(HEADLINE_TEXT, font), headlineWidth, lineHeight)
    const preservesWords = titleLayoutKeepsWholeWords(titleLayout.lines)

    if (widestWord <= headlineWidth - 8 && preservesWords) {
      best = size
      low = size
    } else {
      high = size
    }
  }

  return Math.round(best * 10) / 10
}

function buildLayout(pageWidth: number, pageHeight: number, lineHeight: number): {
  gutter: number
  headlineTop: number
  headlineWidth: number
  headlineFontSize: number
  headlineLineHeight: number
  headlineLines: LayoutLine[]
  headlineRects: Rect[]
  creditTop: number
  leftRegion: Rect
  rightRegion: Rect
  openaiRect: Rect
  claudeRect: Rect
} {
  const gutter = Math.round(Math.max(52, pageWidth * 0.048))
  const centerGap = Math.round(Math.max(28, pageWidth * 0.025))
  const columnWidth = Math.round((pageWidth - gutter * 2 - centerGap) / 2)

  const headlineTop = Math.round(Math.max(42, pageWidth * 0.04))
  const headlineWidth = Math.round(Math.min(pageWidth - gutter * 2, Math.max(columnWidth, pageWidth * 0.5)))
  const headlineFontSize = fitHeadlineFontSize(headlineWidth, pageWidth)
  const headlineLineHeight = Math.round(headlineFontSize * 0.92)
  const headlineFont = `700 ${headlineFontSize}px ${HEADLINE_FONT_FAMILY}`
  const preparedHeadline = prepareWithSegments(HEADLINE_TEXT, headlineFont)
  const headlineResult = layoutWithLines(preparedHeadline, headlineWidth, headlineLineHeight)
  const headlineLines = headlineResult.lines
  const headlineRects = headlineLines.map((line, index) => ({
    x: gutter,
    y: headlineTop + index * headlineLineHeight,
    width: Math.ceil(line.width),
    height: headlineLineHeight,
  }))

  const creditGap = Math.round(Math.max(14, lineHeight * 0.6))
  const creditTop = headlineTop + headlineResult.height + creditGap
  const copyTop = creditTop + CREDIT_LINE_HEIGHT + Math.round(Math.max(20, lineHeight * 0.9))

  const openaiTopLimit = copyTop + Math.round(lineHeight * 1.95)
  const maxOpenaiSizeByHeight = Math.floor((pageHeight - gutter - openaiTopLimit) / 1.03)
  const openaiSize = Math.round(Math.max(148, Math.min(372, pageWidth * 0.215, maxOpenaiSizeByHeight)))
  const claudeSize = Math.round(Math.max(300, Math.min(470, pageWidth * 0.41, pageHeight * 0.5)))

  const leftRegion: Rect = {
    x: gutter,
    y: copyTop,
    width: columnWidth,
    height: pageHeight - copyTop - gutter,
  }

  const rightRegion: Rect = {
    x: gutter + columnWidth + centerGap,
    y: headlineTop,
    width: columnWidth,
    height: pageHeight - headlineTop - gutter,
  }

  const openaiRect: Rect = {
    x: leftRegion.x - Math.round(openaiSize * 0.16),
    y: pageHeight - gutter - openaiSize + Math.round(openaiSize * 0.045),
    width: openaiSize,
    height: openaiSize,
  }

  const claudeRect: Rect = {
    x: pageWidth - Math.round(claudeSize * 0.48),
    y: -Math.round(claudeSize * 0.34),
    width: claudeSize,
    height: claudeSize,
  }

  return {
    gutter,
    headlineTop,
    headlineWidth,
    headlineFontSize,
    headlineLineHeight,
    headlineLines,
    headlineRects,
    creditTop,
    leftRegion,
    rightRegion,
    openaiRect,
    claudeRect,
  }
}

async function evaluateLayout(
  pageWidth: number,
  pageHeight: number,
  lineHeight: number,
  preparedBody: PreparedTextWithSegments,
): Promise<{
  layout: ReturnType<typeof buildLayout>
  leftLines: PositionedLine[]
  rightLines: PositionedLine[]
}> {
  const layout = buildLayout(pageWidth, pageHeight, lineHeight)

  const [openaiMask, claudeMask] = await Promise.all([
    getMask(openaiLogo.src, layout.openaiRect.width, layout.openaiRect.height),
    getMask(claudeLogo.src, layout.claudeRect.width, layout.claudeRect.height),
  ])

  const openaiObstacle: BandObstacle = {
    getIntervals(bandTop, bandBottom) {
      const interval = getMaskIntervalForBand(
        openaiMask,
        layout.openaiRect,
        bandTop,
        bandBottom,
        Math.round(lineHeight * 1.15),
        Math.round(lineHeight * 0.45),
      )
      return interval === null ? [] : [interval]
    },
  }

  const claudeObstacle: BandObstacle = {
    getIntervals(bandTop, bandBottom) {
      const interval = getMaskIntervalForBand(
        claudeMask,
        layout.claudeRect,
        bandTop,
        bandBottom,
        Math.round(lineHeight * 1.05),
        Math.round(lineHeight * 0.42),
      )
      return interval === null ? [] : [interval]
    },
  }

  const titleObstacle: BandObstacle = {
    getIntervals(bandTop, bandBottom) {
      return getRectIntervalsForBand(
        layout.headlineRects,
        bandTop,
        bandBottom,
        Math.round(lineHeight * 0.95),
        Math.round(lineHeight * 0.3),
      )
    },
  }

  const leftResult = layoutColumn(
    preparedBody,
    { segmentIndex: 0, graphemeIndex: 0 },
    layout.leftRegion,
    lineHeight,
    [openaiObstacle],
    'left',
  )

  const rightResult = layoutColumn(
    preparedBody,
    leftResult.cursor,
    layout.rightRegion,
    lineHeight,
    [titleObstacle, claudeObstacle, openaiObstacle],
    'right',
  )

  return {
    layout,
    leftLines: leftResult.lines,
    rightLines: rightResult.lines,
  }
}

async function render(): Promise<void> {
  const { font, lineHeight } = getTypography()
  const pageWidth = window.innerWidth
  const pageHeight = window.innerHeight
  const preparedBody = getPrepared(BODY_COPY, font)
  const evaluation = await evaluateLayout(pageWidth, pageHeight, lineHeight, preparedBody)
  const layout = evaluation.layout
  const leftLines = evaluation.leftLines
  const rightLines = evaluation.rightLines
  stage.style.height = `${pageHeight}px`

  openaiLogo.style.left = `${layout.openaiRect.x}px`
  openaiLogo.style.top = `${layout.openaiRect.y}px`
  openaiLogo.style.width = `${layout.openaiRect.width}px`
  openaiLogo.style.height = `${layout.openaiRect.height}px`

  claudeLogo.style.left = `${layout.claudeRect.x}px`
  claudeLogo.style.top = `${layout.claudeRect.y}px`
  claudeLogo.style.width = `${layout.claudeRect.width}px`
  claudeLogo.style.height = `${layout.claudeRect.height}px`

  headline.style.left = `${layout.gutter}px`
  headline.style.top = `${layout.headlineTop}px`
  headline.style.width = `${layout.headlineWidth}px`
  headline.textContent = ''
  headline.style.font = `700 ${layout.headlineFontSize}px ${HEADLINE_FONT_FAMILY}`
  headline.style.lineHeight = `${layout.headlineLineHeight}px`
  headline.style.letterSpacing = '0px'
  headline.style.height = `${layout.headlineLines.length * layout.headlineLineHeight}px`

  for (const [index, line] of layout.headlineLines.entries()) {
    const el = document.createElement('div')
    el.className = 'headline-line'
    el.textContent = line.text
    el.style.left = '0px'
    el.style.top = `${index * layout.headlineLineHeight}px`
    el.style.font = `700 ${layout.headlineFontSize}px ${HEADLINE_FONT_FAMILY}`
    el.style.lineHeight = `${layout.headlineLineHeight}px`
    headline.appendChild(el)
  }

  credit.style.left = `${layout.gutter + 4}px`
  credit.style.top = `${layout.creditTop}px`
  credit.style.width = 'auto'

  stage.style.minHeight = `${pageHeight}px`
  clearRenderedLines()
  materializeLines(leftLines, 'line line--left', font, lineHeight)
  materializeLines(rightLines, 'line line--right', font, lineHeight)
}

function scheduleRender(): void {
  if (scheduled.value) return
  scheduled.value = true
  requestAnimationFrame(() => {
    scheduled.value = false
    void render()
  })
}

window.addEventListener('resize', scheduleRender)
void document.fonts.ready.then(() => {
  scheduleRender()
})
scheduleRender()
