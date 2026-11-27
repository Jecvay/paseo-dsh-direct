// Verifies the artifact users receive, not just the repository checkout.
// Packs the npm tarball, installs it the way Paseo acquires an npm plugin, and
// checks that the installed package contains the modules the runtime imports.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// Under `npm run`, npm_execpath points at npm's JS entry. Running it with the
// current Node avoids Windows' inability to execFile a .cmd shim.
const npm = process.env.npm_execpath
  ? [process.execPath, process.env.npm_execpath]
  : [process.platform === 'win32' ? 'npm.cmd' : 'npm']
const requiredFiles = [
  'index.client.tsx',
  'index.server.ts',
  'OVERVIEW.md',
  'paseo-plugin.json',
  'dsh.svg',
  'server/dsh/bridge.ts',
  'server/generated-bridge.ts',
  'server/generated-version.ts',
]
const forbiddenPatterns = [
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /\.test\.(?:ts|tsx)$/,
  /^scripts\//,
]

function fail(message) {
  throw new Error(`verify:package: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function npmRun(args, options) {
  return execFileSync(npm[0], [...npm.slice(1), ...args], options)
}

const temporary = mkdtempSync(join(tmpdir(), 'paseo-dsh-direct-package-'))
try {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const packed = JSON.parse(npmRun(
    ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ))
  // npm 11 returns an array; npm 12 returns an object keyed by package name.
  const info = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
  assert(info?.filename, 'npm pack did not report a tarball')

  const files = new Set(info.files.map(file => file.path))
  for (const path of requiredFiles) assert(files.has(path), `tarball is missing ${path}`)
  for (const path of files) {
    for (const pattern of forbiddenPatterns) {
      assert(!pattern.test(path), `tarball must not contain ${path}`)
    }
  }

  const tarball = join(temporary, info.filename)
  const project = join(temporary, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'paseo-dsh-direct-package-check',
    private: true,
    dependencies: { 'paseo-dsh-direct': pathToFileURL(tarball).href },
  }))
  // The same acquisition options Paseo uses for npm plugins. No build follows.
  npmRun([
    'install',
    '--ignore-scripts',
    '--legacy-peer-deps',
    '--no-audit',
    '--no-fund',
    '--package-lock=true',
    '--lockfile-version=3',
    '--include=prod',
    '--omit=dev',
    '--global=false',
    '--workspaces=false',
  ], { cwd: project, stdio: 'inherit' })

  const installed = join(project, 'node_modules', 'paseo-dsh-direct')
  assert(existsSync(installed), 'the tarball did not install as an npm package')
  const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'))
  const artifact = lock.packages?.['node_modules/paseo-dsh-direct']
  assert(artifact?.version === info.version, 'the installed package does not match the packed version')
  assert(typeof artifact.resolved === 'string' && artifact.resolved.startsWith('file:'), 'the installed package did not come from the local tarball')

  const installedPackage = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  assert(installedPackage.name === 'paseo-dsh-direct', `unexpected package name ${installedPackage.name}`)
  assert(installedPackage.version === packageJson.version, 'the installed package version does not match package.json')
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'prepublish', 'prepublishOnly']) {
    assert(!(lifecycle in (installedPackage.scripts ?? {})), `the installed package must not declare ${lifecycle}`)
  }

  const manifest = JSON.parse(readFileSync(join(installed, 'paseo-plugin.json'), 'utf8'))
  assert(manifest.id === installedPackage.name, `unexpected plugin id ${manifest.id}`)
  assert(manifest.requirements?.paseo === '>=0.11.0', 'the Paseo requirement changed; raising it needs evidence of real incompatibility')
  assert(typeof manifest.icon === 'string' && manifest.icon.length > 0, 'the manifest does not declare an icon')
  assert(existsSync(join(installed, manifest.icon)), 'the declared icon is missing')
  assert(!('build' in manifest), 'the installed manifest must not run an install-time build')

  for (const path of ['server/generated-bridge.ts', 'server/generated-version.ts']) {
    const repositoryCopy = readFileSync(join(root, path))
    const installedCopy = readFileSync(join(installed, path))
    assert(repositoryCopy.equals(installedCopy), `${path} in the tarball differs from the repository`)
  }

  // Paseo compiles the entry points from the installed package, so every relative
  // import reachable from them must exist there. A missing shared module would
  // otherwise pass the file-list check and fail only after installation.
  const seen = new Set()
  const pending = ['index.server.ts', 'index.client.tsx']
  while (pending.length > 0) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(join(installed, file), 'utf8')
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const specifier = match[1]
      const candidates = [specifier, `${specifier}.ts`, `${specifier}.tsx`, specifier.replace(/\.js$/, '.ts'), specifier.replace(/\.js$/, '.tsx')]
      const directory = resolve(installed, file, '..')
      const resolved = candidates
        .map(candidate => resolve(directory, candidate))
        .find(candidate => candidate.startsWith(installed + sep) && existsSync(candidate))
      assert(resolved, `${file} imports ${specifier}, which is missing from the tarball`)
      pending.push(relative(installed, resolved))
    }
  }

  console.log(`verify:package: ${info.filename} installs and contains the generated runtime modules`)
} catch (error) {
  console.error(`verify:package: temporary files are in ${temporary}`)
  throw error
} finally {
  try {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    console.warn(`verify:package: could not remove ${temporary}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
