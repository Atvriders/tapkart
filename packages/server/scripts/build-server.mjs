// One production bundle, one emitted file (plus its source map). Shipped
// content is validated before the deploy artifact is written.
import * as esbuild from 'esbuild'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

async function validateShippedContent() {
  // Node 20 does not execute the TypeScript workspace sources directly. Bundle
  // this tiny validator in memory so it runs the exact parsers production uses,
  // over every descriptor, theme, and track, without creating a second artifact.
  const result = await esbuild.build({
    absWorkingDir: SERVER_ROOT,
    stdin: {
      contents: [
        "import { TRACK_MANIFEST, loadContentBundle, loadTrack } from '@tapkart/content'",
        'loadContentBundle()',
        'for (const entry of TRACK_MANIFEST) loadTrack(entry.id)',
      ].join('\n'),
      resolveDir: SERVER_ROOT,
      sourcefile: 'validate-shipped-content.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles?.[0]
  if (output === undefined) throw new Error('content validation produced no executable output')
  const url = 'data:text/javascript;base64,' + Buffer.from(output.contents).toString('base64')
  await import(url)
}

await validateShippedContent()

await esbuild.build({
  absWorkingDir: SERVER_ROOT,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  // `ws` lazily require()s these optional native accelerators inside try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  // ESM has no require; give ws the CommonJS resolver its guarded optional
  // imports expect.
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
})
