import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** Spec §3's dependency direction, as data. §8.4. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  sim: [],
  protocol: ['@tapkart/sim'],
  net: ['@tapkart/sim', '@tapkart/protocol'],
  content: ['@tapkart/sim'],
  render: ['@tapkart/sim', '@tapkart/content', 'three'],
  game: ['@tapkart/sim', '@tapkart/protocol', '@tapkart/net', '@tapkart/content', '@tapkart/render', '@tapkart/invite'],
  invite: ['@tapkart/protocol'],
  server: ['@tapkart/sim', '@tapkart/protocol', '@tapkart/net', '@tapkart/content'],
  web: ['@tapkart/game', '@tapkart/render', '@tapkart/invite', '@capacitor/core'],
}

interface SourceRoot { pkg: string; ownerDir: string; srcDir: string }

/** `node:*` and `ws` are importable ONLY from these paths. */
function mayImportHost(pkg: string, file: string): boolean {
  if (pkg !== 'server') return false
  return file.includes('/src/runtime/') || file.endsWith('/src/main.ts')
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
}

function specifiersOf(file: string, text: string): string[] {
  const out: string[] = []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0]
      if (first !== undefined && ts.isStringLiteralLike(first)) out.push(first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

function ownsPath(root: SourceRoot, target: string): boolean {
  const base = resolve(root.ownerDir)
  return target === base || target.startsWith(base + sep)
}

function allowedBare(spec: string, allowed: readonly string[]): boolean {
  return allowed.some((base) => spec === base || spec.startsWith(base + '/'))
}

describe('import direction (§8.4)', () => {
  it('lets no package or app import what spec §3 forbids it', () => {
    const roots: SourceRoot[] = []
    for (const group of ['packages', 'apps']) {
      const groupDir = join(ROOT, group)
      if (!existsSync(groupDir)) continue
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const ownerDir = join(groupDir, entry.name)
        const srcDir = join(ownerDir, 'src')
        if (existsSync(srcDir)) roots.push({ pkg: entry.name, ownerDir, srcDir })
      }
    }
    expect(roots.length).toBeGreaterThan(0)

    const violations: string[] = []
    let checked = 0

    for (const root of roots) {
      const allowed = ALLOWED[root.pkg]
      if (allowed === undefined) continue
      const files: string[] = []
      walk(root.srcDir, files)
      for (const file of files) {
        checked += 1
        const posix = file.split('\\').join('/')
        for (const spec of specifiersOf(file, readFileSync(file, 'utf8'))) {
          if (spec.startsWith('.')) {
            const target = resolve(dirname(file), spec)
            const otherOwner = roots.find((candidate) =>
              candidate.ownerDir !== root.ownerDir && ownsPath(candidate, target))
            if (otherOwner !== undefined) violations.push(posix + ' -> ' + spec)
            continue
          }
          if (spec.startsWith('node:') || spec === 'ws') {
            if (!mayImportHost(root.pkg, posix)) violations.push(posix + ' -> ' + spec)
            continue
          }
          if (!allowedBare(spec, allowed)) violations.push(posix + ' -> ' + spec)
        }
      }
    }

    expect(checked).toBeGreaterThan(20)
    expect(violations).toEqual([])
  })
})
