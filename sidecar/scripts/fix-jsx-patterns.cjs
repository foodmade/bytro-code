/**
 * Batch-fix invalid props in JSX pattern templates.
 *
 * Strategy: Line-by-line processing for safety.
 * borderColor and border are always on the same line in our templates.
 *
 * Usage: node scripts/fix-jsx-patterns.js [--dry-run]
 */

const { readFileSync, writeFileSync, readdirSync } = require('fs')
const { join } = require('path')

const CATEGORIES_DIR = join(__dirname, '../src/design-system/jsx-patterns/categories')
const DRY_RUN = process.argv.includes('--dry-run')

function processFile(filePath) {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const changes = []
  let modified = false

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const original = line

    // ── Rule 1: borderColor='X' + border={N} on same line ──
    const bcMatch = line.match(/borderColor='([^']*)'/)
    const bdMatch = line.match(/border=\{(\d+)\}/)
    if (bcMatch && bdMatch) {
      const color = bcMatch[1]
      const borderVal = parseInt(bdMatch[1], 10)
      // Remove both props and collapse double spaces
      line = line.replace(/\s*borderColor='[^']*'/, '')
      line = line.replace(/\s*border=\{\d+\}/, '')
      line = line.replace(/  +/g, ' ')
      if (borderVal === 0) {
        // No border — just remove both
      } else if (borderVal === 1) {
        // Default strokeWidth — only add stroke
        line = insertProp(line, `stroke='${color}'`)
      } else {
        // Explicit strokeWidth
        line = insertProp(line, `stroke='${color}' strokeWidth={${borderVal}}`)
      }
    } else if (bcMatch && !bdMatch) {
      // borderColor alone → stroke
      line = line.replace(/borderColor='([^']*)'/, "stroke='$1'")
    }

    // ── Rule 2: padding shorthand ──
    line = line.replace(/paddingX=\{(\d+)\}/g, 'px={$1}')
    line = line.replace(/paddingY=\{(\d+)\}/g, 'py={$1}')
    line = line.replace(/paddingTop=\{(\d+)\}/g, 'pt={$1}')
    line = line.replace(/paddingBottom=\{(\d+)\}/g, 'pb={$1}')

    // ── Rule 3: shrink={0} — remove (with leading whitespace) ──
    line = line.replace(/\s+shrink=\{0\}/g, '')

    // ── Rule 4: align='X' → items='X' (all values, only if no items= on same line) ──
    if (/ align='(center|start|end)'/.test(line) && !/ items=/.test(line)) {
      line = line.replace(/ align='(center|start|end)'/, " items='$1'")
    }

    if (line !== original) {
      lines[i] = line
      modified = true
      changes.push({
        lineNum: i + 1,
        before: original.trim(),
        after: line.trim(),
      })
    }
  }

  if (modified) {
    if (!DRY_RUN) {
      writeFileSync(filePath, lines.join('\n'), 'utf-8')
    }
    return changes
  }
  return null
}

/**
 * Insert prop(s) into a line that has a JSX tag.
 * Inserts before the last > or /> on the line.
 */
function insertProp(line, prop) {
  // Find last closing bracket: > or />
  const selfCloseIdx = line.lastIndexOf('/>')
  const closeIdx = line.lastIndexOf('>')
  if (selfCloseIdx !== -1 && selfCloseIdx === closeIdx - 1) {
    // Self-closing tag
    return line.slice(0, selfCloseIdx) + ` ${prop} />` + line.slice(selfCloseIdx + 2)
  }
  if (closeIdx !== -1) {
    return line.slice(0, closeIdx) + ` ${prop}` + line.slice(closeIdx)
  }
  // No closing bracket on this line — just append prop
  return line + ` ${prop}`
}

// ── Main ──────────────────────────────────────────────────────────────────

const files = readdirSync(CATEGORIES_DIR).filter(f => f.endsWith('.ts'))
let totalChanges = 0
let filesChanged = 0

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Scanning ${files.length} files in categories/\n`)

for (const file of files) {
  const filePath = join(CATEGORIES_DIR, file)
  const changes = processFile(filePath)
  if (changes) {
    filesChanged++
    totalChanges += changes.length
    console.log(`${file}: ${changes.length} changes`)
    for (const c of changes) {
      console.log(`  L${c.lineNum}:`)
      console.log(`    - ${c.before}`)
      console.log(`    + ${c.after}`)
    }
    console.log()
  }
}

console.log(`\nDone: ${totalChanges} changes in ${filesChanged}/${files.length} files${DRY_RUN ? ' (dry run, no files written)' : ''}.`)
