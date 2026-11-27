// Verifies the artifact users receive, not just the repository checkout.
// Packs the npm tarball, installs it the way Paseo acquires an npm plugin, and
// checks that the installed package can load without an install-time build.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const requiredFiles = [
  'index.client.tsx',
  'index.server.ts',
  'OVERVIEW.md',
  'package.json',
  'paseo-plugin.json',
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

const temporary = mkdtempSync(join(tmpdir(), 'paseo-dsh-direct-package-'))
try {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const packed = JSON.parse(execFileSync(
    npm,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ))
  const info = packed[0]
  assert(info?.filename, 'npm pack did not report a tarball')
  assert(info.version === packageJson.version, `tarball version ${info.version} does not match package.json ${packageJson.version}`)

  const files = new Set(info.files.map(file => file.path))
  for (const path of requiredFiles) assert(files.has(path), `tarball is missing ${path}`)
  for (const path of files) {
    for (const pattern of forbiddenPatterns) {
      assert(!pattern.test(path), `tarball must not contain ${path}`)
    }
  }

  const project = join(temporary, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'paseo-dsh-direct-package-check',
    private: true,
    dependencies: { 'paseo-dsh-direct': `file:${join(temporary, info.filename)}` },
  }))
  // The same acquisition options Paseo uses for npm plugins. No build follows.
  execFileSync(npm, [
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

  const installedPackage = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) {
    assert(!(lifecycle in (installedPackage.scripts ?? {})), `the installed package must not declare ${lifecycle}`)
  }

  const manifest = JSON.parse(readFileSync(join(installed, 'paseo-plugin.json'), 'utf8'))
  assert(manifest.id === 'paseo-dsh-direct', `unexpected plugin id ${manifest.id}`)
  assert(manifest.requirements?.paseo === '>=0.11.0', 'unexpected Paseo requirement')
  assert(manifest.icon && existsSync(join(installed, manifest.icon)), 'declared icon is missing')
  assert(!('build' in manifest), 'the installed manifest must not run an install-time build')

  const versionSource = readFileSync(join(installed, 'server/generated-version.ts'), 'utf8')
  assert(versionSource.includes(`export const PLUGIN_VERSION = ${JSON.stringify(packageJson.version)}`), 'generated plugin version does not match package.json')

  const bridgeSource = readFileSync(join(installed, 'server/generated-bridge.ts'), 'utf8')
  assert(bridgeSource.includes('export const DSH_BRIDGE_SOURCE = "'), 'generated bridge module is missing its export')
  assert(bridgeSource.length > 10_000, 'generated bridge module is unexpectedly small')

  assert(existsSync(join(installed, 'index.server.ts')), 'server entry is missing')
  assert(existsSync(join(installed, 'index.client.tsx')), 'client entry is missing')
  assert(existsSync(join(installed, 'server/dsh/bridge.ts')), 'the bridge source is missing from the package')

  console.log(`verify:package: ${info.filename} installs and contains the generated runtime modules`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
