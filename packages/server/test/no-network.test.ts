import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** The sole socket-binding test and this scanner, which necessarily spells the
 * needles it searches for. Repo-relative paths make similarly named files in a
 * different package ineligible for the exemption. */
const EXEMPT = new Set([
  'packages/server/test/no-network.test.ts',
  'packages/server/test/runtime-smoke.test.ts',
])

const NEEDLES = ['listen(', 'createServer', 'new WebSocket', 'fetch(']
const HOST_NETWORK = new Set(['node:net', 'node:http', 'node:https', 'node:tls', 'node:dgram', 'ws'])

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
}

function networkImportsOf(file: string, text: string): string[] {
  const out: string[] = []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    let spec: string | null = null
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      spec = node.moduleSpecifier.text
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0]
      if (first !== undefined && ts.isStringLiteralLike(first)) spec = first.text
    }
    if (spec !== null && HOST_NETWORK.has(spec)) out.push(spec)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

describe('no external network in tests', () => {
  it('leaves exactly one test able to open a socket across packages and apps', () => {
    const files: string[] = []
    for (const group of ['packages', 'apps']) {
      const groupDir = join(ROOT, group)
      if (!existsSync(groupDir)) continue
      for (const owner of readdirSync(groupDir, { withFileTypes: true })) {
        if (!owner.isDirectory()) continue
        const testDir = join(groupDir, owner.name, 'test')
        if (existsSync(testDir)) walk(testDir, files)
      }
    }
    expect(files.length).toBeGreaterThan(5)

    const seen = new Set(files.map((file) => relative(ROOT, file).split('\\').join('/')))
    expect([...EXEMPT].every((file) => seen.has(file))).toBe(true)
    expect(EXEMPT.size).toBe(2)

    const hits: string[] = []
    for (const file of files) {
      const rel = relative(ROOT, file).split('\\').join('/')
      if (EXEMPT.has(rel)) continue
      const source = readFileSync(file, 'utf8')
      for (const spec of networkImportsOf(file, source)) hits.push(rel + ' imports ' + spec)
      for (const needle of NEEDLES) {
        if (source.includes(needle)) hits.push(rel + ' contains ' + needle)
      }
    }
    expect(hits).toEqual([])
  })
})
