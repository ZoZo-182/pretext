import { prepare, layout } from '../../../src/layout.ts'
import rawThoughts from './shower-thoughts.json'

// --- config ---
const font = '15px "Helvetica Neue", Helvetica, Arial, sans-serif'
const lineHeight = 22
const cardPadding = 16
const gap = 12
const maxColWidth = 400

// --- prepare all texts upfront ---
const thoughts: string[] = []
for (let i = 0; i < 10000; i++) {
  thoughts.push(rawThoughts[i % rawThoughts.length]!)
}
const prepared = thoughts.map(text => prepare(text, font))

// --- dom ---
const container = document.createElement('div')
container.style.position = 'relative'
document.body.appendChild(container)

// cache lifetime: on visibility changes
const domCache: (HTMLDivElement | null)[] = new Array(thoughts.length).fill(null)

// --- layout state (recomputed on resize only) ---
const cardX = new Float64Array(thoughts.length)
const cardY = new Float64Array(thoughts.length)
const cardH = new Float64Array(thoughts.length)
let layoutColWidth = 0
let layoutMaxColHeight = 0
let lastLayoutWidth = -1

function recomputeLayout(windowWidth: number) {
  const minColWidth = 100 + windowWidth * 0.1
  const colCount = Math.max(2, Math.floor((windowWidth + gap) / (minColWidth + gap)))
  const colWidth = Math.min(maxColWidth, (windowWidth - (colCount + 1) * gap) / colCount)
  const textWidth = colWidth - cardPadding * 2
  const contentWidth = colCount * colWidth + (colCount - 1) * gap
  const offsetLeft = (windowWidth - contentWidth) / 2

  const colHeights = new Float64Array(colCount)
  for (let c = 0; c < colCount; c++) colHeights[c] = gap

  for (let i = 0; i < thoughts.length; i++) {
    let shortest = 0
    for (let c = 1; c < colCount; c++) {
      if (colHeights[c]! < colHeights[shortest]!) shortest = c
    }

    const { height } = layout(prepared[i]!, textWidth, lineHeight)
    const totalH = height + cardPadding * 2

    cardX[i] = offsetLeft + shortest * (colWidth + gap)
    cardY[i] = colHeights[shortest]!
    cardH[i] = totalH

    colHeights[shortest]! += totalH + gap
  }

  let maxH = 0
  for (let c = 0; c < colCount; c++) {
    if (colHeights[c]! > maxH) maxH = colHeights[c]!
  }

  layoutColWidth = colWidth
  layoutMaxColHeight = maxH
  lastLayoutWidth = windowWidth
}

// --- events ---
window.addEventListener('resize', () => scheduleRender())
window.addEventListener('scroll', () => scheduleRender(), true)

let scheduled = false
function scheduleRender() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(function renderAndMaybeScheduleAnotherRender() {
    scheduled = false
    render()
  })
}

function render() {
  // --- DOM reads ---
  const windowWidth = document.documentElement.clientWidth
  const windowHeight = document.documentElement.clientHeight
  const scrollTop = window.scrollY

  // --- recompute layout only when width changes ---
  if (windowWidth !== lastLayoutWidth) recomputeLayout(windowWidth)

  // --- visibility + DOM writes (single pass) ---
  const viewTop = scrollTop - 200
  const viewBottom = scrollTop + windowHeight + 200

  container.style.height = `${layoutMaxColHeight}px`

  for (let i = 0; i < thoughts.length; i++) {
    const y = cardY[i]!
    const h = cardH[i]!
    if (y <= viewBottom && y + h >= viewTop) {
      let node = domCache[i]
      if (node == null) {
        node = document.createElement('div')
        node.className = 'card'
        node.textContent = thoughts[i]!
        domCache[i] = node
      }
      node.style.left = `${cardX[i]!}px`
      node.style.top = `${y}px`
      node.style.width = `${layoutColWidth}px`
      node.style.height = `${h}px`
      if (node.parentNode == null) container.appendChild(node)
    } else {
      const node = domCache[i]
      if (node != null) {
        if (node.parentNode != null) node.remove()
        domCache[i] = null
      }
    }
  }
}

scheduleRender()
