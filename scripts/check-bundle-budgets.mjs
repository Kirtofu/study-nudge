import { gzipSync } from 'node:zlib'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = join(root, 'dist')
const html = await readFile(join(dist, 'index.html'), 'utf8')
const mainJs = html.match(/src="\.\/assets\/([^"?]+\.js)"/)?.[1]
const mainCss = html.match(/href="\.\/assets\/([^"?]+\.css)"/)?.[1]
if (!mainJs || !mainCss) throw new Error('无法从 dist/index.html 找到首屏资源')

const gzipBytes = async (path) => gzipSync(await readFile(path)).length
const jsBytes = await gzipBytes(join(dist, 'assets', mainJs))
const cssBytes = await gzipBytes(join(dist, 'assets', mainCss))
const css = await readFile(join(dist, 'assets', mainCss), 'utf8')
const fontNames = [...css.matchAll(/url\(\.\/([^\)]+\.woff2)\)/g)].map((match) => match[1])
const uniqueFonts = [...new Set(fontNames)]
let fontBytes = 0
for (const font of uniqueFonts) fontBytes += (await stat(join(dist, 'assets', font))).size

const budgets = {
  '首屏 JS gzip': [jsBytes, 160 * 1024],
  '首屏 CSS gzip': [cssBytes, 60 * 1024],
  '首屏引用字体': [fontBytes, 5 * 1024 * 1024]
}
let failed = false
for (const [label, [actual, limit]] of Object.entries(budgets)) {
  const passed = actual <= limit
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}: ${(actual / 1024).toFixed(1)} KiB / ${(limit / 1024).toFixed(1)} KiB`)
  failed ||= !passed
}

const allAssets = await readdir(join(dist, 'assets'))
const fontCount = allAssets.filter((name) => name.endsWith('.woff2')).length
console.log(`INFO 字体分片: ${uniqueFonts.length} 个被首屏 CSS 引用，dist 共 ${fontCount} 个`)
if (failed) process.exit(1)
