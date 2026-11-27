// Verifies the artifact users receive, not just the repository checkout.
// Packs the npm tarball, installs it the way Paseo acquires an npm plugin, and
// checks that the installed package contains the modules the runtime imports.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
function fail(message) {
  throw new Error(`verify:package: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

// Under `npm run`, npm_execpath points at npm's JS entry. Running it with the
// current Node avoids Windows' inability to execFile a .cmd shim.
if (process.platform === 'win32' && !process.env.npm_execpath) {
  fail('run this through `npm run verify:package` so npm_execpath is available')
}
const npm = process.env.npm_execpath
  ? [process.execPath, process.env.npm_execpath]
  : ['npm']
const generatedFiles = [
  'server/generated-bridge.ts',
  'server/generated-version.ts',
]
const requiredFiles = [
  'index.client.tsx',
  'index.server.ts',
  'OVERVIEW.md',
  'paseo-plugin.json',
  'dsh.svg',
  'server/dsh/bridge.ts',
  ...generatedFiles,
]
const forbiddenPatterns = [
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /\.test\.(?:ts|tsx)$/,
  /^scripts\//,
]

const JS_TO_TS_EXTENSIONS = [
  [/\.js$/, ['.ts', '.tsx']],
  [/\.jsx$/, ['.tsx']],
  [/\.mjs$/, ['.mts']],
  [/\.cjs$/, ['.cts']],
]

function importCandidates(specifier) {
  for (const [pattern, replacements] of JS_TO_TS_EXTENSIONS) {
    if (pattern.test(specifier)) {
      return [specifier, ...replacements.map(ext => specifier.replace(pattern, ext))]
    }
  }
  return [
    specifier,
    `${specifier}.ts`,
    `${specifier}.tsx`,
    `${specifier}.mts`,
    `${specifier}.cts`,
    `${specifier}.js`,
    `${specifier}.jsx`,
    `${specifier}.mjs`,
    `${specifier}.cjs`,
    join(specifier, 'index.ts'),
    join(specifier, 'index.tsx'),
    join(specifier, 'index.js'),
    join(specifier, 'index.jsx'),
    join(specifier, 'index.mjs'),
    join(specifier, 'index.cjs'),
  ]
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

  const installed = resolve(project, 'node_modules', 'paseo-dsh-direct')
  assert(existsSync(installed), 'the tarball did not install as an npm package')
  const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'))
  const artifact = lock.packages?.['node_modules/paseo-dsh-direct']
  assert(artifact?.version === info.version, 'the installed package does not match the packed version')
  assert(typeof artifact.resolved === 'string' && artifact.resolved.startsWith('file:'), 'the installed package did not come from the local tarball')
  assert(typeof artifact.integrity === 'string' && artifact.integrity.startsWith('sha512-'), 'the installed package has no integrity hash')

  const installedPackage = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  assert(installedPackage.name === packageJson.name, `unexpected package name ${installedPackage.name}`)
  assert(installedPackage.version === packageJson.version, 'the installed package version does not match package.json')
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'prepublish', 'prepublishOnly']) {
    assert(!(lifecycle in (installedPackage.scripts ?? {})), `the installed package must not declare ${lifecycle}`)
  }

  const manifest = JSON.parse(readFileSync(join(installed, 'paseo-plugin.json'), 'utf8'))
  assert(manifest.id === installedPackage.name, `unexpected plugin id ${manifest.id}`)
  assert(manifest.requirements?.paseo === '>=0.11.0', 'the Paseo requirement changed; raising it needs evidence of real incompatibility')
  assert(typeof manifest.icon === 'string' && manifest.icon.length > 0, 'the manifest does not declare an icon')
  assert(/\.png$/i.test(manifest.icon), 'the manifest icon must be a PNG path')
  assert(existsSync(join(installed, manifest.icon)), 'the declared icon is missing')
  assert(!('build' in manifest), 'the installed manifest must not run an install-time build')

  for (const path of generatedFiles) {
    const repositoryCopy = readFileSync(join(root, path))
    const installedCopy = readFileSync(join(installed, path))
    assert(repositoryCopy.equals(installedCopy), `${path} in the tarball differs from the repository`)
  }
  const versionModule = readFileSync(join(installed, 'server/generated-version.ts'), 'utf8')
  assert(versionModule.includes(`export const PLUGIN_VERSION = ${JSON.stringify(installedPackage.version)}`), 'the generated plugin version does not match the installed package')

  // Paseo compiles the entry points from the installed package, so every relative
  // import reachable from them must exist there. A missing shared module would
  // otherwise pass the file-list check and fail only after installation.
  const seen = new Set()
  const pending = ['index.server.ts', 'index.client.tsx'].map(entry => resolve(installed, entry))
  const allowedRoots = ['client', 'server', 'shared'].map(directory => resolve(installed, directory) + sep)
  while (pending.length > 0) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    const { importedFiles, referencedFiles } = ts.preProcessFile(source, true, true)
    const localSpecifiers = [
      ...importedFiles.map(({ fileName }) => fileName).filter(specifier => /^\.\.?(\/|$)/.test(specifier)),
      ...referencedFiles.map(({ fileName }) => fileName),
    ]
    for (const specifier of localSpecifiers) {
      const directory = dirname(file)
      const base = resolve(directory, specifier)
      assert(
        base.startsWith(installed + sep),
        `${relative(installed, file)} imports ${specifier}, which is outside client/, server/ or shared/`,
      )
      const resolved = importCandidates(specifier)
        .map(candidate => resolve(directory, candidate))
        .find(candidate => candidate.startsWith(installed + sep) && existsSync(candidate) && statSync(candidate).isFile())
      assert(resolved, `${relative(installed, file)} imports ${specifier}, which is missing from the tarball`)
      assert(
        allowedRoots.some(allowedRoot => resolved.startsWith(allowedRoot)),
        `${relative(installed, file)} imports ${specifier}, which is outside client/, server/ or shared/`,
      )
      if (/\.[cm]?[jt]sx?$/i.test(resolved)) pending.push(resolved)
    }
  }

  console.log(`verify:package: ${info.filename} installs and contains the generated runtime modules`)
} finally {
  try {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    console.warn(`verify:package: could not remove ${temporary}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
