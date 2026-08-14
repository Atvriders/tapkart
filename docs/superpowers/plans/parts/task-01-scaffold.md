### Task 1: npm-workspaces monorepo scaffold

Creates the repository skeleton every later task builds on: an npm-workspaces
root, the `@tapkart/sim` workspace, one shared strict TypeScript config that
encodes the contract's convention table, a root vitest config that discovers
tests at `packages/*/test/**/*.test.ts`, and one smoke test proving `npm test`
works from the repo root.

Nothing in this task imports from `packages/sim/src` except an empty barrel.
Task 2 fills that barrel in.

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `packages/sim/package.json`
- Create: `packages/sim/tsconfig.json`
- Create: `packages/sim/src/index.ts`
- Test: `packages/sim/test/scaffold.test.ts`

**Interfaces:**
- Consumes: nothing. This is the first task in the repo.
- Produces:
  - Root npm scripts `npm test` (`vitest run`), `npm run test:watch` (`vitest`),
    and `npm run typecheck` (`npm run typecheck --workspaces --if-present`).
  - Workspace `@tapkart/sim` at `packages/sim`, `"type": "module"`, exporting
    `"."` as `./src/index.ts`.
  - `packages/sim/src/index.ts` — a barrel that currently exports nothing. Task 2
    replaces its body with four `export *` lines.
  - `tsconfig.base.json` with `moduleResolution: "Bundler"`,
    `verbatimModuleSyntax: true`, `strict: true`, and
    `noUncheckedIndexedAccess: false`. Every package tsconfig extends it.
  - Test convention: vitest with `globals: false`, so every test file begins
    `import { describe, expect, it } from 'vitest'`.

**Preconditions:** Node 20 (`node -v` reports `v20.x`). The repo already exists
at the working directory root, is a git repo, and its `.gitignore` already
contains `node_modules/`, `dist/`, `.env`, and `*.local`. Do not add a
`package-lock.json` ignore rule — the lockfile is committed.

---

- [ ] **Step 1: Write the failing test**

Create `packages/sim/test/scaffold.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import * as sim from '../src/index'

describe('workspace scaffold', () => {
  it('runs a TypeScript test from the repo root', () => {
    // TICK_HZ is 60 in the contract; 60 ticks * 3 seconds of countdown = 180,
    // which is COUNTDOWN_TICKS. Plain arithmetic here — the real constants
    // arrive in Task 2. This test only proves the toolchain executes TS.
    const tickHz: number = 60
    expect(tickHz * 3).toBe(180)
  })

  it('resolves the @tapkart/sim entry point with extensionless imports', () => {
    // '../src/index' has no file extension. This asserts that
    // moduleResolution: "Bundler" plus vitest's resolver agree with the
    // contract's import-style convention.
    expect(typeof sim).toBe('object')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sim/test/scaffold.test.ts`

Expected: FAIL. With no root `package.json` and no vitest installed, npx reports
`npm error could not determine executable to run` (or, if vitest resolves from a
global cache, it fails to collect the file with
`Error: Cannot find module '../src/index' imported from '.../packages/sim/test/scaffold.test.ts'`).

- [ ] **Step 3: Write the root workspace manifest**

Create `package.json`:

```json
{
  "name": "tapkart",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*"
  ],
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "npm run typecheck --workspaces --if-present"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 4: Write the shared strict TypeScript config**

Create `tsconfig.base.json`. Every compiler option below is load-bearing; the
comments explain which contract convention each one enforces, but JSON does not
allow comments, so write the file exactly as shown without them.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "strict": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noUncheckedIndexedAccess": false,
    "useDefineForClassFields": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

Why these exact values:

- `"moduleResolution": "Bundler"` — the contract's import-style row. It is what
  makes `from './types'` legal without a `.js` suffix.
- `"verbatimModuleSyntax": true` — the contract's type-only-import row. Type
  imports must be written `import type { Vec3 } from './types'` or the build
  fails.
- `"noUncheckedIndexedAccess": false` — **deliberately off.** `SimState.karts` is
  always length `MAX_KARTS` and `SimState.entities` is always length
  `MAX_ENTITIES`, so `state.karts[i]` is a `KartState`, not
  `KartState | undefined`. Turning this on would force a non-null assertion on
  every hot-path array read in Tasks 5–16.
- `"noEmit": true` — `packages/sim` is consumed as TypeScript source by vitest
  and by Vite. There is no `tsc` build output in Plan 1.

- [ ] **Step 5: Write the root vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
  },
})
```

`globals: false` is intentional: every test file imports `describe`, `expect` and
`it` from `'vitest'` explicitly, so no `types` entry is needed in any tsconfig.
`environment: 'node'` because `packages/sim` has no DOM dependency.

- [ ] **Step 6: Write the sim workspace package and tsconfig**

Create `packages/sim/package.json`:

```json
{
  "name": "@tapkart/sim",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

Create `packages/sim/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/sim/src/index.ts`:

```typescript
// Public barrel for @tapkart/sim. Task 2 replaces this line with re-exports of
// types, vec3, mathutil and rng. The bare `export {}` keeps the file a module
// under isolatedModules while it is still empty.
export {}
```

- [ ] **Step 7: Install and run the test to verify it passes**

Run:

```bash
npm install
npx vitest run packages/sim/test/scaffold.test.ts
```

Expected: PASS — `Test Files 1 passed (1)`, `Tests 2 passed (2)`.

- [ ] **Step 8: Verify `npm test` and `npm run typecheck` work from the repo root**

Run:

```bash
npm test
npm run typecheck
```

Expected: `npm test` prints `Test Files  1 passed (1)` and
`Tests  2 passed (2)`, having discovered
`packages/sim/test/scaffold.test.ts` through the `packages/*/test/**/*.test.ts`
glob. `npm run typecheck` fans out to `@tapkart/sim` and exits 0 with no
diagnostics.

Also confirm the workspace link exists:

```bash
npm ls --depth=0
```

Expected output includes `├── @tapkart/sim@0.1.0 -> ./packages/sim`.

- [ ] **Step 9: Verify Node 20 and that the lockfile is present**

Run:

```bash
node -v
test -f package-lock.json && echo "lockfile present"
```

Expected: `v20.x.x` and `lockfile present`. If `node -v` reports anything below
v20, stop — the `engines` field and the ES2022 target both assume Node 20.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json vitest.config.ts \
        packages/sim/package.json packages/sim/tsconfig.json \
        packages/sim/src/index.ts packages/sim/test/scaffold.test.ts
git commit -m "feat: npm-workspaces monorepo scaffold with strict TS and vitest

Root workspace plus the @tapkart/sim package. tsconfig.base.json encodes the
contract's convention table: moduleResolution Bundler for extensionless
imports, verbatimModuleSyntax for type-only imports, and
noUncheckedIndexedAccess deliberately off because SimState arrays are
fixed-length. Root 'npm test' runs vitest over packages/*/test/**/*.test.ts."
```
